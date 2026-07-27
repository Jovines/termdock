/**
 * Rich agent session status — the OSC 777 sentinel protocol + per-pane state
 * machine. （设计移植自 tty7 core/cli_agent.rs，Apache-2.0；TypeScript 重写）
 *
 * Agent-side hooks (installed by `installers.ts`, or hand-wired) emit an
 * OSC 777 notification whose title is AGENT_EVENT_SENTINEL and whose body is
 * a small JSON event. The server sniffs those out of the PTY stream, folds
 * them through `applyAgentEvent`, and streams state changes to clients for
 * status dots, "needs your input" notifications, and session resume.
 *
 * Wire shape: `ESC ] 777 ; notify ; termdock://cli-agent ; {"v":1,…} BEL`
 */

import { agentBySlug, type AgentInfo } from './registry.js';

export const AGENT_EVENT_SENTINEL = 'termdock://cli-agent';
export const AGENT_EVENT_PROTOCOL_VERSION = 1;

/**
 * What an agent session is doing right now, coarsely. `waiting` is the state
 * the whole feature exists for: the agent stopped mid-turn and needs the user
 * (a permission prompt, a question) — the moment worth a notification.
 */
export type AgentSessionStatus = 'idle' | 'working' | 'waiting' | 'done';

export type AgentEventKind =
  | 'session-start'
  | 'prompt-submit'
  | 'permission-request'
  | 'question-asked'
  | 'tool-complete'
  | 'notification'
  | 'stop'
  | 'session-end';

const EVENT_KINDS = new Set<AgentEventKind>([
  'session-start', 'prompt-submit', 'permission-request', 'question-asked',
  'tool-complete', 'notification', 'stop', 'session-end',
]);

/** One parsed sentinel event. */
export interface AgentEvent {
  /** Which agent sent it, when the payload names one we know. Lets the event
   *  brand a pane even where argv detection can't see through a wrapper. */
  agent: AgentInfo | null;
  kind: AgentEventKind;
  sessionId: string | null;
  message: string | null;
  /** The agent's working directory at the moment the hook fired, when carried. */
  cwd: string | null;
}

/**
 * Per-pane agent session state, maintained server-side and mirrored to clients.
 * Exists only while an agent is detected in the pane's foreground.
 */
export interface AgentSessionState {
  status: AgentSessionStatus;
  /** Human-readable context for waiting/done (e.g. "Claude needs your
   *  permission to use Bash"), straight from the event. */
  message: string | null;
  /** The agent's *native* session id (from its session-start event) — the key
   *  its own `--resume` flag takes. Persisted for restore. */
  sessionId: string | null;
  /** The argv the agent was launched with, as observed by the foreground
   *  process poll. Stamped by the identity-detection side, not applyEvent. */
  launchArgv: string[] | null;
  /** Whether this state came from the rich sentinel channel (hooks installed)
   *  rather than the opaque OSC 9/777 fallback. Rich state drives turn-level
   *  notifications; fallback state only paints the dot. */
  rich: boolean;
  /** The agent's working directory as its hook payloads report it — tracks
   *  internal chdirs the PTY can't show (Claude Code's EnterWorktree).
   *  Cleared on session-end. */
  agentCwd: string | null;
  /** Tool completions seen in this session, counted only so consumers can
   *  spot *that* the agent did something (e.g. refresh the git probe mid-turn).
   *  Monotonic within a session and never reset — only the *change* means
   *  anything. */
  activity: number;
  /** Whether the user has acknowledged the current turn's result. Server-
   *  authoritative so the 'needs review' indicator survives page refresh. */
  reviewed: boolean;
}

export function defaultAgentSessionState(): AgentSessionState {
  return {
    status: 'idle',
    message: null,
    sessionId: null,
    launchArgv: null,
    rich: false,
    agentCwd: null,
    activity: 0,
    reviewed: true,
  };
}

/**
 * Fold one rich event into the state. Pure transition function — the caller
 * owns *when* to call it and who to tell.
 */
export function applyAgentEvent(state: AgentSessionState, ev: AgentEvent): void {
  state.rich = true;
  if (ev.sessionId) state.sessionId = ev.sessionId;
  if (ev.cwd) state.agentCwd = ev.cwd;

  switch (ev.kind) {
    case 'session-start':
      state.status = 'idle';
      state.message = null;
      break;
    case 'prompt-submit':
      state.status = 'working';
      state.message = null;
      state.reviewed = true;
      break;
    // Explicit blocks from agents that distinguish them (Codex/OpenCode
    // plugins): always the urgent "needs you" state.
    case 'permission-request':
    case 'question-asked':
      state.status = 'waiting';
      state.message = ev.message;
      break;
    // Claude Code overloads its single Notification hook: it fires *mid-turn*
    // for a permission/decision prompt (a genuine block), but ALSO *between*
    // turns as an idle "waiting for your input" reminder — which must not
    // masquerade as a block. Escalate only when a turn is actually in flight;
    // keyed on turn phase, not the message text, so it survives version/locale
    // changes.
    case 'notification':
      if (state.status === 'working') {
        state.status = 'waiting';
        state.message = ev.message;
      }
      break;
    // A tool call finished. Only meaningful as the recovery edge out of a
    // block: the user answered the permission prompt, the approved tool ran,
    // so the turn is moving again — no agent emits an explicit "permission
    // replied" signal, so the next tool completion is that signal. Guarded on
    // waiting so the steady stream of completions during normal work is a
    // no-op and can never overwrite done between turns.
    case 'tool-complete':
      // The count moves even when the status doesn't: a tool call is the one
      // signal that the working tree may have just changed mid-turn.
      state.activity = (state.activity + 1) >>> 0;
      if (state.status === 'waiting') {
        state.status = 'working';
        state.message = null;
        state.reviewed = true;
      }
      break;
    case 'stop':
      state.status = 'done';
      state.message = ev.message;
      state.reviewed = false;
      break;
    // The agent session ended but its id stays: agents can resume an *ended*
    // session, which is exactly what restore does. Its cwd claim does NOT
    // stay: with no agent running, the pane's real directory is the truth.
    case 'session-end':
      state.status = 'idle';
      state.message = null;
      state.agentCwd = null;
      state.reviewed = true;
      break;
  }
}

function nonEmpty(s: unknown): string | null {
  return typeof s === 'string' && s.trim().length > 0 ? s : null;
}

/**
 * Parse a complete OSC payload (identifier included, e.g.
 * `777;notify;termdock://cli-agent;{"v":1,…}`) into an AgentEvent. Returns
 * null for anything that isn't a well-formed sentinel event — including
 * unknown `event` values, so the protocol can grow without old servers
 * mis-classifying new events.
 */
export function parseAgentEvent(payload: string): AgentEvent | null {
  if (!payload.startsWith('777;notify;')) return null;
  const rest = payload.slice('777;notify;'.length);
  if (!rest.startsWith(AGENT_EVENT_SENTINEL)) return null;
  const json = rest.slice(AGENT_EVENT_SENTINEL.length);
  if (!json.startsWith(';')) return null;

  let w: Record<string, unknown>;
  try {
    w = JSON.parse(json.slice(1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!w || typeof w !== 'object') return null;
  const eventName = nonEmpty(w.event);
  if (!eventName || !EVENT_KINDS.has(eventName as AgentEventKind)) return null;

  return {
    agent: agentBySlug(nonEmpty(w.agent)),
    kind: eventName as AgentEventKind,
    sessionId: nonEmpty(w.session_id),
    message: nonEmpty(w.message),
    cwd: nonEmpty(w.cwd),
  };
}

/**
 * Build the sentinel OSC sequence for one hook invocation — the emitter side,
 * kept here so tests can round-trip it through `parseAgentEvent`.
 * `payloadJson` is the hook's raw stdin JSON from the agent; fields are lifted
 * into the sentinel body (snake_case, with camelCase aliases for Grok).
 */
export function buildHookSequence(agent: string, event: string, stdinJson: string): string {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(stdinJson) as unknown;
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
  } catch { /* garbage stdin still yields a well-formed bare event */ }

  const body: Record<string, unknown> = {
    v: AGENT_EVENT_PROTOCOL_VERSION,
    agent,
    event,
  };
  for (const [key, alias] of [['session_id', 'sessionId'], ['message', 'message'], ['cwd', 'cwd']] as const) {
    const v = nonEmpty(payload[key]) ?? nonEmpty(payload[alias]);
    if (v) body[key] = v;
  }
  return `\x1b]777;notify;${AGENT_EVENT_SENTINEL};${JSON.stringify(body)}\x07`;
}
