#!/usr/bin/env node
/**
 * termdock agent-hook emitter — the agent-side half of the rich status channel.
 * （设计移植自 tty7 core/agent_hooks.rs，Apache-2.0；TypeScript/Node 重写）
 *
 * Invoked by agent hooks as: `node agentHook.js <agent> <event>`.
 * Reads the hook's JSON payload from stdin, builds one sentinel OSC 777
 * sequence, and writes it to the controlling terminal, where the termdock
 * server sniffs it out of the PTY stream and folds it into the pane's
 * session state.
 *
 * Emission is gated on the TERMDOCK environment variable (injected into every
 * shell termdock spawns / every managed tmux session), so hooks installed
 * globally stay silent when an agent runs in another terminal.
 *
 * Always exits 0 quietly — a hook that fails must never break the agent's
 * own flow (agents surface nonzero exits).
 *
 * This entry must stay dependency-light (fast cold start): only stdlib +
 * the pure protocol module.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildHookSequence } from './agent/session.js';

/** The env var termdock sets in every spawned shell; the emitter refuses to
 *  write escape sequences into terminals that aren't termdock's. */
const TERMDOCK_ENV_MARKER = 'TERMDOCK';

/** Env var Grok Build's hook runner injects into every hook process it spawns.
 *  Its presence identifies *who ran us* — grok also scans ~/.claude/settings.json
 *  for hooks (its Claude-compat layer), so a termdock Claude Code integration
 *  also fires inside grok panes and must be relabeled to the agent that
 *  actually ran it. */
const GROK_HOOK_ENV = 'GROK_HOOK_EVENT';

/** Cap on how much hook stdin we'll read: real payloads are a few hundred
 *  bytes of JSON; anything huge is not for us. */
const MAX_STDIN = 64 * 1024;

/**
 * The sentinel event one hook invocation maps onto, or null to stay silent.
 * Most hooks pass their event through; the exceptions are the single catch-all
 * `notification` hook Copilot and Grok expose, which fires for *every*
 * notification type. Only the types that always mean a real block escalate to
 * `permission-request`; everything else is dropped rather than parroted.
 *
 * The two agents draw that line differently. Copilot's `permission_prompt`
 * only fires when it is actually asking, so it counts; grok dispatches the
 * same type *before* its permission system decides — on essentially every tool
 * call, auto-approved ones included — so only `elicitation_dialog` (grok
 * asking the user a question) survives there.
 */
function effectiveEvent(agent: string, event: string, stdinJson: string): string | null {
  if ((agent === 'copilot' || agent === 'grok') && event === 'notification') {
    const blocks = stdinJson.includes('elicitation_dialog')
      || (agent === 'copilot' && stdinJson.includes('permission_prompt'));
    return blocks ? 'permission-request' : null;
  }
  return event;
}

/** Write raw bytes to a tty device, best-effort. */
function writeDev(path: string, bytes: string): boolean {
  try {
    const fd = fs.openSync(path, 'w');
    try {
      fs.writeSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The controlling-tty device of the nearest ancestor that has one — the agent
 * process, when it ran us detached. Claude Code runs hooks *detached* from
 * the controlling terminal (they have no /dev/tty), but the agent process
 * itself still owns the pane's PTY slave. Walk up the parent chain via `ps`
 * (the hook runs at most a few times per turn, so the spawn is negligible).
 */
function ancestorTtyDevice(): string | null {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    let tty = '';
    let ppid = 1;
    try {
      const out = execFileSync('ps', ['-o', 'tty=', '-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      const fields = out.trim().split(/\s+/);
      tty = fields[0] ?? '';
      ppid = parseInt(fields[1] ?? '1', 10) || 1;
    } catch {
      return null;
    }
    if (tty && tty !== '??' && tty !== '?') {
      return `/dev/${tty}`;
    }
    pid = ppid;
  }
  return null;
}

/**
 * Write the sequence to the pane's PTY so the server sniffs it as pane output.
 * Two routes: /dev/tty (hook attached to its tty), or an ancestor's tty
 * device (agent ran us detached — write its PTY slave directly; writing the
 * slave sends output to the master, exactly like /dev/tty would).
 *
 * Inside tmux the pane's tty is tmux's own PTY slave: a bare OSC would be
 * consumed by tmux and never reach the attached client. When $TMUX is set we
 * wrap the sequence in a DCS passthrough, which tmux (with allow-passthrough
 * enabled, as termdock sets on managed sessions) forwards to its client —
 * the termdock server — as the plain inner OSC.
 */
function writeToControllingTty(sequence: string, inTmuxPane: boolean): boolean {
  // Only genuine tmux panes (TMUX_PANE is set by tmux itself) get the DCS
  // passthrough wrap; a bare inherited TMUX just means an ancestor ran tmux.
  const wire = inTmuxPane
    ? `\x1bPtmux;${sequence.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`
    : sequence;
  if (writeDev('/dev/tty', wire)) return true;
  const dev = ancestorTtyDevice();
  if (dev) return writeDev(dev, wire);
  return false;
}

function main(): void {
  try {
    // Gate: emit when (a) inside a termdock-spawned shell (TERMDOCK env), or
    // (b) inside any tmux pane (TMUX+TMUX_PANE) — there the passthrough wrap
    // self-gates: sessions without allow-passthrough (anything termdock
    // doesn't manage) swallow the sequence harmlessly. Anything else: stay
    // silent, so globally-installed hooks don't leak into other terminals.
    const inTmuxPane = !!(process.env.TMUX && process.env.TMUX_PANE);
    if (!process.env[TERMDOCK_ENV_MARKER] && !inTmuxPane) return;

    // Command line: `agentHook.js agent-hook <agent> <event>` — the literal
    // `agent-hook <slug>` token doubles as the installer's ownership marker.
    const args = process.argv.slice(2);
    if (args[0] === 'agent-hook') args.shift();
    let agent = args[0] ?? '';
    const eventArg = args[1] ?? '';
    const statusArg = args[2] ?? '';
    if (!agent || !eventArg) return;
    if (process.env[GROK_HOOK_ENV]) agent = 'grok';

    // Hook payload: the agent writes JSON and closes stdin. Absent/malformed
    // input still emits the bare event — the state machine works without ids
    // or messages. A tty stdin means the spawner inherited the pane's terminal
    // instead of piping a payload; reading it would block forever on an EOF
    // that never comes and swallow the user's keystrokes, so skip it.
    let input = '';
    if (!process.stdin.isTTY) {
      try {
        input = fs.readFileSync(0, 'utf8').slice(0, MAX_STDIN);
      } catch { /* no payload */ }
    }

    const event = effectiveEvent(agent, eventArg, input);
    if (!event) return;

    writeToControllingTty(buildHookSequence(agent, event, input, statusArg || undefined), inTmuxPane);
  } catch {
    // Never break the agent's flow.
  }
  process.exit(0);
}

main();
