/**
 * Agent-side hook installers: wire `agentHook.js` into each CLI agent's own
 * hook surface. （设计移植自 tty7 core/agent_hooks.rs，Apache-2.0；TS 重写）
 *
 * Each supported agent exposes hooks differently — Claude Code and Codex take
 * a declarative hooks map, Copilot and Grok auto-load JSON hook files from a
 * directory, OpenCode loads JS plugins, Pi loads TS extensions — but every
 * integration bottoms out in the same emitter: `agentHook.js agent-hook
 * <agent> <event>` reads the hook's JSON payload from stdin and writes one
 * sentinel OSC 777 sequence to the controlling terminal.
 *
 * All installers are idempotent (marker-carrying entries are rewritten in
 * place, never duplicated), ownership-guarded (user-authored hooks/files are
 * never touched), and report NotInstalled / Installed / Outdated.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { agentBySlug, isPluginAgent } from './registry.js';
import { loadPlugins, resolveHookTarget, type PluginHookEvent } from './plugins.js';

export type HookAgentSlug = 'claude' | 'codex' | 'copilot' | 'opencode' | 'pi' | 'grok' | 'kimi';

export type HooksState = 'not-installed' | 'installed' | 'outdated' | 'needs-approval';

export interface HookAgentInfo {
  slug: string;
  displayName: string;
  /** The file the integration installs into, ~-abbreviated for display. */
  targetDisplay: string;
  state: HooksState;
  accentColor: string | null;
  icon: string | null;
  /** Plugin icon rendering mode, if set. */
  iconMode: string | null;
  /** Plugin icon file mtime (ms) for cache-busting, if set. */
  iconVersion: number | null;
}

export const HOOK_AGENTS: HookAgentSlug[] = ['claude', 'codex', 'copilot', 'opencode', 'pi', 'grok', 'kimi'];

const DISPLAY_NAMES: Record<HookAgentSlug, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot CLI',
  opencode: 'OpenCode',
  pi: 'Pi',
  grok: 'Grok Build',
  kimi: 'Kimi Code',
};

// ---------------------------------------------------------------------------
// Paths and the hook command line
// ---------------------------------------------------------------------------

function homeDir(): string {
  return os.homedir();
}

/** Claude Code's user settings file: $CLAUDE_CONFIG_DIR/settings.json. */
function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir && dir.trim().length > 0) return path.join(dir, 'settings.json');
  return path.join(homeDir(), '.claude', 'settings.json');
}

/** $XDG_CONFIG_HOME, defaulting to ~/.config (OpenCode's config root). */
function xdgConfigDir(): string {
  const dir = process.env.XDG_CONFIG_HOME;
  if (dir && dir.trim().length > 0) return dir;
  return path.join(homeDir(), '.config');
}

const OWNED_FILE_STEM_JSON = 'termdock.json';
const OWNED_FILE_STEM_JS = 'termdock.js';

function targetPath(agent: HookAgentSlug): string {
  switch (agent) {
    case 'claude': return claudeSettingsPath();
    case 'codex': return path.join(homeDir(), '.codex', 'hooks.json');
    case 'copilot': return path.join(homeDir(), '.copilot', 'hooks', OWNED_FILE_STEM_JSON);
    case 'opencode': return path.join(xdgConfigDir(), 'opencode', 'plugins', OWNED_FILE_STEM_JS);
    case 'pi': return path.join(homeDir(), '.pi', 'agent', 'extensions', 'termdock', 'index.ts');
    case 'grok': return path.join(homeDir(), '.grok', 'hooks', OWNED_FILE_STEM_JSON);
    case 'kimi': return path.join(homeDir(), '.kimi-code', 'config.toml');
  }
}

function abbreviateHome(p: string): string {
  const home = homeDir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Absolute path of the built emitter script. In a built install this is
 * `dist/server/agentHook.js`; under tsx dev only the .ts source exists —
 * hooks then point at a file plain node can't run, so `installHooks` reports
 * `devMode` for the UI to warn about.
 */
export function resolveHookScript(): { script: string; devMode: boolean } {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const js = path.resolve(here, '..', 'agentHook.js');
  if (fs.existsSync(js)) return { script: js, devMode: false };
  const ts = path.resolve(here, '..', 'agentHook.ts');
  return { script: ts, devMode: true };
}

/**
 * The hook command line written into an agent's config — node by absolute
 * path (works regardless of PATH) + the emitter script + the literal
 * `agent-hook <slug>` marker token. Quoted because paths can carry spaces.
 */
function hookCommand(agent: HookAgentSlug, event: string): string {
  const { script } = resolveHookScript();
  return `"${process.execPath}" "${script}" agent-hook ${agent} ${event}`;
}

/** Substring identifying a hook entry / owned file as termdock's. Every
 *  generated command and file embeds `agent-hook <slug>` verbatim. */
function marker(agent: HookAgentSlug): string {
  return `agent-hook ${agent}`;
}

/** Best-effort atomic write: tmp file + rename. */
function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Hooks-map installer (Claude Code, Codex): a JSON object with a top-level
// "hooks" key mapping event names to entry lists; termdock owns exactly one
// marker-carrying entry per event and never touches the rest of the file.
// ---------------------------------------------------------------------------

/**
 * Claude Code's hook events and the sentinel event each maps onto.
 * `Notification` covers both "needs permission" and "waiting for input" —
 * exactly the waiting state. `PostToolUse` is the way *back*: Claude has no
 * "permission replied" hook, so the first tool that completes after the user
 * approves is the signal that the turn is moving again.
 */
const CLAUDE_HOOK_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'prompt-submit'],
  ['Notification', 'notification'],
  ['PostToolUse', 'tool-complete'],
  ['Stop', 'stop'],
  ['SessionEnd', 'session-end'],
];

/** Codex's native hooks.json event vocabulary. */
const CODEX_HOOK_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'prompt-submit'],
  ['PermissionRequest', 'permission-request'],
  ['PostToolUse', 'tool-complete'],
  ['Stop', 'stop'],
  ['SessionEnd', 'session-end'],
];

/**
 * Kimi Code's hook events (~/.kimi-code/config.toml `[[hooks]]` entries, TOML).
 * `PermissionRequest` is the genuine block (fires right before the approval
 * wait); `PostToolUse` is the way *back* — Kimi has a `PermissionResult`
 * event, but the approved tool completing is the same recovery edge Claude
 * uses, and it keeps the state machine on the shared vocabulary. `Stop` does
 * NOT fire when the user interrupts (Esc) or the turn errors — Kimi sends
 * `Interrupt` / `StopFailure` instead, so both fold onto `stop` to keep the
 * pane from sticking in working.
 */
export const KIMI_HOOK_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'prompt-submit'],
  ['PermissionRequest', 'permission-request'],
  ['PostToolUse', 'tool-complete'],
  ['Stop', 'stop'],
  ['StopFailure', 'stop'],
  ['Interrupt', 'stop'],
  ['SessionEnd', 'session-end'],
];

/** Seconds Kimi gives one termdock hook before killing it (its default is
 *  30s; ours writes a few bytes). */
const KIMI_HOOK_TIMEOUT_SECS = 5;

/**
 * Grok Build's hook events — Claude Code's vocabulary (grok mirrors it
 * deliberately, it even reads ~/.claude/settings.json) — plus the matcher
 * each subscription is narrowed by. `Notification` is the one narrowed
 * subscription: grok dispatches its `permission_prompt` notification *before*
 * the permission system decides, so it fires on essentially every tool call —
 * escalating that to the "needs you" state would flash the pane on every tool
 * a turn runs. `elicitation_dialog` — grok's ask-the-user question — is the
 * type that always means a real block.
 */
const GROK_HOOK_EVENTS: Array<[string, string, string | null]> = [
  ['SessionStart', 'session-start', null],
  ['UserPromptSubmit', 'prompt-submit', null],
  ['Notification', 'notification', 'elicitation_dialog'],
  ['PostToolUse', 'tool-complete', null],
  ['Stop', 'stop', null],
  ['SessionEnd', 'session-end', null],
];

/** Seconds grok gives one termdock hook before killing it (its default is
 *  600s — a budget for hooks that run test suites; ours writes a few bytes). */
const GROK_HOOK_TIMEOUT_SECS = 10;

type JsonObject = Record<string, unknown>;

function readJsonObject(file: string): JsonObject | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

/** The termdock hook command inside one matcher entry
 *  (`{"matcher": …, "hooks": [{"command": …}]}`), if it carries one. */
function markerCommand(entry: unknown, mark: string): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const hooks = (entry as JsonObject).hooks;
  if (!Array.isArray(hooks)) return null;
  for (const h of hooks) {
    const cmd = h && typeof h === 'object' ? (h as JsonObject).command : null;
    if (typeof cmd === 'string' && cmd.includes(mark)) return cmd;
  }
  return null;
}

function hookMapState(file: string, agent: HookAgentSlug, events: Array<[string, string]>): HooksState {
  const root = readJsonObject(file);
  if (!root) return 'not-installed';
  const mark = marker(agent);
  const hooks = root.hooks;
  let any = false;
  let complete = true;
  for (const [hookEvent, sentinel] of events) {
    const list = hooks && typeof hooks === 'object'
      ? (hooks as JsonObject)[hookEvent]
      : null;
    const ours = Array.isArray(list)
      ? list.map((entry) => markerCommand(entry, mark)).find((c) => c !== null) ?? null
      : null;
    if (ours !== null) {
      any = true;
      if (ours !== hookCommand(agent, sentinel)) complete = false;
    } else {
      complete = false;
    }
  }
  if (!any) return 'not-installed';
  return complete ? 'installed' : 'outdated';
}

/** Merge termdock's hook entries into the file, preserving everything else. */
function hookMapInstall(file: string, agent: HookAgentSlug, events: Array<[string, string]>): void {
  let root: JsonObject = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file} is not a JSON object; not touching it`);
    }
    root = parsed as JsonObject;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    if (root.hooks !== undefined) {
      throw new Error(`"hooks" in ${file} is not an object; not touching it`);
    }
    root.hooks = {};
  }
  const hooks = root.hooks as JsonObject;
  const mark = marker(agent);

  for (const [hookEvent, sentinel] of events) {
    const command = hookCommand(agent, sentinel);
    let list = hooks[hookEvent];
    if (list === undefined) {
      list = [];
      hooks[hookEvent] = list;
    }
    if (!Array.isArray(list)) continue; // malformed user config; leave it alone
    // Drop any previous termdock entry (stale exe path), then append ours.
    const kept = list.filter((entry) => markerCommand(entry, mark) === null);
    kept.push({ hooks: [{ type: 'command', command }] });
    hooks[hookEvent] = kept;
  }

  writeAtomic(file, JSON.stringify(root, null, 2));
}

/** Remove every termdock hook entry, leaving user-defined hooks untouched.
 *  Sweeps *all* hook events so entries left by an older termdock with a
 *  different event set are cleaned up too. */
function hookMapUninstall(file: string, agent: HookAgentSlug): string {
  const root = readJsonObject(file);
  if (!root) return 'Nothing installed; nothing to remove';
  const mark = marker(agent);
  let removed = 0;
  if (root.hooks && typeof root.hooks === 'object') {
    const hooks = root.hooks as JsonObject;
    for (const eventName of Object.keys(hooks)) {
      const list = hooks[eventName];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((entry) => markerCommand(entry, mark) === null);
      removed += list.length - kept.length;
      if (kept.length === 0) {
        delete hooks[eventName];
      } else {
        hooks[eventName] = kept;
      }
    }
  }
  if (removed === 0) return 'No termdock hooks found; nothing to remove';
  writeAtomic(file, JSON.stringify(root, null, 2));
  return 'Removed';
}

/** Turn Codex's hooks feature flag on, which gates whether hooks.json is
 *  read at all. Best-effort: the file install is complete either way, so a
 *  missing codex binary downgrades to advice instead of failing. */
function enableCodexHooksFeature(): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const candidates = [
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(homeDir(), '.local', 'bin', 'codex'),
    ];
    const program = candidates.find((p) => fs.existsSync(p)) ?? 'codex';
    execFile(program, ['features', 'enable', 'hooks'], { timeout: 10_000 }, (error, _stdout, stderr) => {
      if (!error) return resolvePromise();
      rejectPromise(new Error(`${program}: ${String(stderr).trim() || error.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Owned-file installer (Copilot, OpenCode, Pi, Grok): termdock writes a whole
// file it owns outright, identified by the marker. Install refuses to clobber
// a file termdock didn't write; uninstall only ever deletes a marker file.
// ---------------------------------------------------------------------------

/** Copilot hook file (~/.copilot/hooks/termdock.json): Copilot auto-loads
 *  every JSON file in that directory. Event names are Copilot's camelCase
 *  vocabulary. `notification` is passed through and filtered in the emitter. */
function copilotHooksJson(): string {
  const hook = (event: string, timeoutSec: number) => [{
    type: 'command',
    bash: hookCommand('copilot', event),
    timeoutSec,
  }];
  return JSON.stringify({
    version: 1,
    hooks: {
      sessionStart: hook('session-start', 5),
      userPromptSubmitted: hook('prompt-submit', 5),
      agentStop: hook('stop', 10),
      sessionEnd: hook('session-end', 5),
      notification: hook('notification', 5),
    },
  }, null, 2);
}

/** Grok Build hook file (~/.grok/hooks/termdock.json). Grok loads every JSON
 *  file there and global hooks need no folder-trust grant. Same wiring as
 *  CLAUDE_HOOK_EVENTS in owned-file form, with the Notification matcher. */
function grokHooksJson(): string {
  const hooks: JsonObject = {};
  for (const [event, sentinel, match] of GROK_HOOK_EVENTS) {
    const group: JsonObject = {
      hooks: [{
        type: 'command',
        command: hookCommand('grok', sentinel),
        timeout: GROK_HOOK_TIMEOUT_SECS,
      }],
    };
    if (match) group.matcher = match;
    hooks[event] = [group];
  }
  return JSON.stringify({ hooks }, null, 2);
}

/** OpenCode plugin (~/.config/opencode/plugins/termdock.js). OpenCode has no
 *  declarative hooks — its extensibility surface is JS plugins auto-loaded
 *  from that directory — so the plugin bridges its events onto the same
 *  emitter. Inert outside termdock (both the JS guard and the emitter check
 *  TERMDOCK). */
export function opencodePluginJs(): string {
  const prefix = JSON.stringify(
    `"${process.execPath}" "${resolveHookScript().script}" agent-hook opencode `,
  );
  return `// termdock agent-hook opencode bridge — generated by termdock, do not edit.
// Bridges OpenCode plugin events onto the termdock agent-hook emitter,
// which is inert outside termdock (gated on the TERMDOCK env var).
export const TermdockPresence = async ({ $ }) => {
  if (!process.env["TERMDOCK"]) return {}
  const cmd = ${prefix}
  const announced = new Set()
  const childSessions = new Set()
  const emit = (event, sessionID) => {
    const payload = JSON.stringify(sessionID ? { session_id: sessionID } : {})
    return $\`printf "%s" \${payload} | sh -c \${cmd + event}\`.quiet().nothrow()
  }
  const ensureSession = async (sessionID) => {
    if (!sessionID || childSessions.has(sessionID) || announced.has(sessionID)) return false
    announced.add(sessionID)
    await emit("session-start", sessionID)
    return true
  }
  const observeSessionInfo = async (info) => {
    const sessionID = info?.id
    if (!sessionID) return
    if (info.parentID) {
      childSessions.add(sessionID)
      announced.delete(sessionID)
      return
    }
    await ensureSession(sessionID)
  }

  return {
    dispose: async () => {
      await Promise.all([...announced].map((sessionID) => emit("session-end", sessionID)))
    },
    "chat.message": async ({ sessionID }) => {
      await ensureSession(sessionID)
      if (!childSessions.has(sessionID)) await emit("prompt-submit", sessionID)
    },
    "tool.execute.before": async ({ sessionID }) => {
      await ensureSession(sessionID)
      if (!childSessions.has(sessionID)) await emit("prompt-submit", sessionID)
    },
    "permission.ask": async ({ sessionID }) => {
      await ensureSession(sessionID)
      if (!childSessions.has(sessionID)) await emit("permission-request", sessionID)
    },
    event: async ({ event }) => {
      if (event.type === "session.created" || event.type === "session.updated") {
        await observeSessionInfo(event.properties?.info)
        return
      }
      if (event.type === "session.deleted") {
        const deletedSessionID = event.properties?.info?.id
        if (announced.has(deletedSessionID)) await emit("session-end", deletedSessionID)
        announced.delete(deletedSessionID)
        childSessions.delete(deletedSessionID)
        return
      }
      const sessionID = event.properties?.sessionID
      await ensureSession(sessionID)
      if (!sessionID || childSessions.has(sessionID)) return
      if (event.type === "session.idle") {
        await emit("stop", sessionID)
      } else if (event.type === "permission.replied") {
        await emit("prompt-submit", sessionID)
      }
    },
  }
}
`;
}

/** Pi extension (~/.pi/agent/extensions/termdock/index.ts). Pi auto-loads TS
 *  extensions from per-directory index.ts files; this one forwards Pi's
 *  lifecycle events to the emitter. Inert outside termdock. */
function piExtensionTs(): string {
  const script = JSON.stringify(resolveHookScript().script);
  const node = JSON.stringify(process.execPath);
  return `/* termdock agent-hook pi bridge — generated by termdock, do not edit. */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";

const EXE = ${node};
const SCRIPT = ${script};

function emit(event: string): void {
  try {
    spawnSync(EXE, [SCRIPT, "agent-hook", "pi", event], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {}
}

export default function (pi: ExtensionAPI) {
  if (!process.env["TERMDOCK"]) return;
  // Extension load = the agent is running in this pane; Pi has no separate
  // session-start event.
  emit("session-start");
  pi.on("agent_start", () => emit("prompt-submit"));
  pi.on("agent_end", () => emit("stop"));
  pi.on("session_shutdown", () => emit("session-end"));
}
`;
}

function ownedFileContent(agent: HookAgentSlug): string | null {
  switch (agent) {
    case 'copilot': return copilotHooksJson();
    case 'opencode': return opencodePluginJs();
    case 'pi': return piExtensionTs();
    case 'grok': return grokHooksJson();
    default: return null;
  }
}

function ownedFileState(file: string, expected: string, mark: string): HooksState {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return 'not-installed';
  }
  if (contents === expected) return 'installed';
  // termdock wrote it (the marker survives), but from another binary or an
  // older version of the content.
  if (contents.includes(mark)) return 'outdated';
  return 'not-installed';
}

function ownedFileInstall(file: string, content: string, mark: string): void {
  try {
    const existing = fs.readFileSync(file, 'utf8');
    if (!existing.includes(mark)) {
      throw new Error(`${file} exists but wasn't written by termdock; not touching it`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeAtomic(file, content);
}

function ownedFileUninstall(file: string, mark: string): string {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'Nothing installed; nothing to remove';
    }
    throw error;
  }
  if (!contents.includes(mark)) {
    throw new Error(`${file} wasn't written by termdock; not touching it`);
  }
  fs.unlinkSync(file);
  // Pi's extension lives in its own directory; sweep it if now empty.
  const parent = path.dirname(file);
  if (path.basename(parent) === 'termdock') {
    try { fs.rmdirSync(parent); } catch { /* non-empty dir is the user's */ }
  }
  return 'Removed';
}

// ---------------------------------------------------------------------------
// TOML hooks installer (Kimi Code): kimi keeps hooks in `[[hooks]]` array-of-
// tables inside ~/.kimi-code/config.toml — free-form TOML we must NOT rewrite
// wholesale (comments, ordering, other tables are the user's). So instead of
// parsing, the file is treated as a sequence of *sections* (a `[table]` /
// `[[array]]` header line plus the lines up to the next header); termdock
// owns exactly the sections whose command carries the marker, appends fresh
// `[[hooks]]` blocks at the end of the file, and never touches the rest.
// ---------------------------------------------------------------------------

/** Split TOML text into sections: everything before the first header is one
 *  (preamble) section; each later section starts at its header line.
 *  `sections.join('\n')` reproduces the input byte-for-byte. */
function splitTomlSections(text: string): string[] {
  const lines = text.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line) && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  sections.push(current.join('\n'));
  return sections;
}

/** The `event = "…"` value of a `[[hooks]]` section, if it declares one. */
function tomlSectionEvent(section: string): string | null {
  const m = section.match(/^\s*event\s*=\s*"([^"]+)"\s*(?:#.*)?$/m);
  return m ? m[1] : null;
}

/** The `command = '…'` value of a `[[hooks]]` section (literal-string form —
 *  the only form termdock writes; the command embeds double quotes). */
function tomlSectionCommand(section: string): string | null {
  const m = section.match(/^\s*command\s*=\s*'(.*)'\s*(?:#.*)?$/m);
  return m ? m[1] : null;
}

/** One `[[hooks]]` block as termdock writes it. Kimi allows exactly the
 *  fields event/matcher/command/timeout. */
function tomlHookBlock(hookEvent: string, command: string): string {
  return `[[hooks]]\nevent = "${hookEvent}"\ncommand = '${command}'\ntimeout = ${KIMI_HOOK_TIMEOUT_SECS}`;
}

function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Exported for tests — the public entry points are hooksState/installHooks/
// uninstallHooks; these take an explicit file path so tests can use tmp files.
export function tomlHooksState(file: string, agent: HookAgentSlug, events: Array<[string, string]>): HooksState {
  const text = readTextFile(file);
  if (text === null) return 'not-installed';
  const mark = marker(agent);
  const ours = splitTomlSections(text).filter((s) => s.includes(mark));
  if (ours.length === 0) return 'not-installed';
  for (const [hookEvent, sentinel] of events) {
    const expected = hookCommand(agent, sentinel);
    const ok = ours.some(
      (s) => tomlSectionEvent(s) === hookEvent && tomlSectionCommand(s) === expected,
    );
    if (!ok) return 'outdated';
  }
  return 'installed';
}

/** Merge termdock's `[[hooks]]` blocks into config.toml, preserving
 *  everything else (including the user's own hooks) byte-for-byte. */
export function tomlHooksInstall(file: string, agent: HookAgentSlug, events: Array<[string, string]>): void {
  const text = readTextFile(file) ?? '';
  const mark = marker(agent);
  // Drop any previous termdock blocks (stale exe path / older event set)…
  const kept = splitTomlSections(text).filter((s) => !s.includes(mark));
  let out = kept.join('\n');
  // …then append the fresh set at the end of the file, where new
  // `[[hooks]]` tables can never swallow the user's trailing keys.
  if (out.length > 0 && !out.endsWith('\n')) out += '\n';
  if (out.trim().length > 0) out += '\n';
  out += events
    .map(([hookEvent, sentinel]) => tomlHookBlock(hookEvent, hookCommand(agent, sentinel)))
    .join('\n\n');
  out += '\n';
  writeAtomic(file, out);
}

/** Remove every termdock `[[hooks]]` block, leaving the rest of the file
 *  (user hooks included) untouched. */
export function tomlHooksUninstall(file: string, agent: HookAgentSlug): string {
  const text = readTextFile(file);
  if (text === null) return 'Nothing installed; nothing to remove';
  const mark = marker(agent);
  const sections = splitTomlSections(text);
  const removed = sections.filter((s) => s.includes(mark)).length;
  if (removed === 0) return 'No termdock hooks found; nothing to remove';
  const out = sections
    .filter((s) => !s.includes(mark))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '\n');
  writeAtomic(file, out);
  return 'Removed';
}

// ---------------------------------------------------------------------------
// Public API — built-in agents
// ---------------------------------------------------------------------------

export function hooksState(agent: HookAgentSlug): HooksState {
  const file = targetPath(agent);
  if (agent === 'claude') return hookMapState(file, agent, CLAUDE_HOOK_EVENTS);
  if (agent === 'codex') return hookMapState(file, agent, CODEX_HOOK_EVENTS);
  if (agent === 'kimi') return tomlHooksState(file, agent, KIMI_HOOK_EVENTS);
  const expected = ownedFileContent(agent);
  if (expected === null) return 'not-installed';
  return ownedFileState(file, expected, marker(agent));
}

interface CodexHookMetadata {
  command?: string;
  trustStatus?: string;
  enabled?: boolean;
}

let codexRuntimeStateCache: { at: number; state: HooksState } | null = null;

/** Query Codex's own hook registry: a structurally present hook can still be
 * quarantined until the user approves its current hash in `/hooks`. */
async function codexRuntimeHooksState(): Promise<HooksState> {
  const structural = hooksState('codex');
  if (structural !== 'installed') return structural;
  if (codexRuntimeStateCache && Date.now() - codexRuntimeStateCache.at < 30_000) {
    return codexRuntimeStateCache.state;
  }
  const state = await new Promise<HooksState>((resolve) => {
    const child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    let buffer = '';
    let settled = false;
    const finish = (value: HooksState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(structural), 5_000);
    timer.unref?.();
    child.on('error', () => finish(structural));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: number; result?: { data?: Array<{ hooks?: CodexHookMetadata[] }> } };
        try { message = JSON.parse(line) as typeof message; } catch { continue; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [process.cwd()] } })}\n`);
        } else if (message.id === 2) {
          const ours = (message.result?.data ?? [])
            .flatMap((entry) => entry.hooks ?? [])
            .filter((hook) => typeof hook.command === 'string' && hook.command.includes(marker('codex')));
          if (ours.length < CODEX_HOOK_EVENTS.length) finish('outdated');
          else if (ours.some((hook) => hook.enabled === false || !['trusted', 'managed'].includes(hook.trustStatus ?? ''))) finish('needs-approval');
          else finish('installed');
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'termdock', version: '1' } } })}\n`);
  });
  codexRuntimeStateCache = { at: Date.now(), state };
  return state;
}

export function listHookAgents(): HookAgentInfo[] {
  return HOOK_AGENTS.map((slug) => ({
    slug,
    displayName: DISPLAY_NAMES[slug],
    targetDisplay: abbreviateHome(targetPath(slug)),
    state: hooksState(slug),
    accentColor: agentBySlug(slug)?.accentColor ?? null,
    icon: agentBySlug(slug)?.icon ?? null,
    iconMode: agentBySlug(slug)?.iconMode ?? null,
    iconVersion: agentBySlug(slug)?.iconVersion ?? null,
  }));
}

export interface InstallResult {
  summary: string;
  /** True when hooks point at .ts sources (tsx dev) and won't fire until built. */
  devMode: boolean;
}

export async function installHooks(agent: HookAgentSlug): Promise<InstallResult> {
  const file = targetPath(agent);
  const { devMode } = resolveHookScript();
  if (agent === 'claude') {
    hookMapInstall(file, agent, CLAUDE_HOOK_EVENTS);
    return { summary: 'Installed', devMode };
  }
  if (agent === 'codex') {
    hookMapInstall(file, agent, CODEX_HOOK_EVENTS);
    codexRuntimeStateCache = null;
    try {
      await enableCodexHooksFeature();
      return { summary: 'Installed — open /hooks in Codex and approve any new Termdock hooks', devMode };
    } catch (error) {
      return {
        summary: `Installed, but couldn't run \`codex features enable hooks\` (${(error as Error).message}) — run it once manually`,
        devMode,
      };
    }
  }
  if (agent === 'kimi') {
    tomlHooksInstall(file, agent, KIMI_HOOK_EVENTS);
    return {
      summary: 'Installed — run /reload in any open Kimi session (or restart it) for hooks to take effect',
      devMode,
    };
  }
  const content = ownedFileContent(agent);
  if (content === null) throw new Error(`no owned-file integration for ${agent}`);
  ownedFileInstall(file, content, marker(agent));
  return { summary: 'Installed', devMode };
}

export async function uninstallHooks(agent: HookAgentSlug): Promise<string> {
  const file = targetPath(agent);
  if (agent === 'claude' || agent === 'codex') {
    if (agent === 'codex') codexRuntimeStateCache = null;
    return hookMapUninstall(file, agent);
  }
  if (agent === 'kimi') {
    return tomlHooksUninstall(file, agent);
  }
  return ownedFileUninstall(file, marker(agent));
}

// ---------------------------------------------------------------------------
// Public API — plugin agents (generic hookmap installer)
// ---------------------------------------------------------------------------

interface PluginHookAgentEntry {
  slug: string;
  displayName: string;
  targetPath: string;
  events: Array<[string, string, string | null, number?, string?]>;
}

/** Collect all plugin agents that define hooks. */
function pluginHookEntries(): PluginHookAgentEntry[] {
  const { plugins } = loadPlugins();
  return plugins
    .filter((p) => p.manifest.hooks && p.manifest.hooks.events.length > 0)
    .map((p) => {
      const events: Array<[string, string, string | null, number?, string?]> = p.manifest.hooks!.events.map(
        (e: PluginHookEvent) => [e.hook, e.event, e.matcher ?? null, e.timeout, e.status],
      );
      return {
        slug: p.manifest.slug,
        displayName: p.manifest.displayName,
        targetPath: resolveHookTarget(p.manifest.hooks!.target),
        events,
      };
    });
}

/** Hook command for a plugin agent. Uses the same emitter script but with the plugin slug. */
function hookCommandForPlugin(slug: string, event: string, status?: string): string {
  const { script } = resolveHookScript();
  const statusArg = status ? ` ${status}` : '';
  return `"${process.execPath}" "${script}" agent-hook ${slug} ${event}${statusArg}`;
}

/**
 * List all agents with hook support — both built-in and plugin-defined.
 * Plugin agents appear after built-in agents.
 */
export async function listAllHookAgents(): Promise<HookAgentInfo[]> {
  const builtIn = HOOK_AGENTS.map((slug) => {
    const agent = agentBySlug(slug);
    return {
      slug,
      displayName: DISPLAY_NAMES[slug],
      targetDisplay: abbreviateHome(targetPath(slug)),
      state: hooksState(slug),
      accentColor: agent?.accentColor ?? null,
      icon: agent?.icon ?? null,
      iconMode: agent?.iconMode ?? null,
      iconVersion: agent?.iconVersion ?? null,
    };
  });
  const pluginAgents = pluginHookEntries().map((entry) => {
    const agent = agentBySlug(entry.slug);
    return {
      slug: entry.slug,
      displayName: entry.displayName,
      targetDisplay: abbreviateHome(entry.targetPath),
      state: pluginHooksState(entry.slug, entry.targetPath, entry.events),
      accentColor: agent?.accentColor ?? '#878580',
      icon: agent?.icon ?? null,
      iconMode: agent?.iconMode ?? null,
      iconVersion: agent?.iconVersion ?? null,
    };
  });
  const codex = builtIn.find((entry) => entry.slug === 'codex');
  if (codex) codex.state = await codexRuntimeHooksState();
  return [...builtIn, ...pluginAgents];
}

export function hooksStateForSlug(slug: string): HooksState {
  if (isPluginAgent(slug)) {
    const entries = pluginHookEntries();
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) return 'not-installed';
    return pluginHooksState(
      slug,
      entry.targetPath,
      entry.events,
    );
  }
  return hooksState(slug as HookAgentSlug);
}

export async function installHooksForSlug(slug: string): Promise<InstallResult> {
  if (isPluginAgent(slug)) {
    const entries = pluginHookEntries();
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) throw new Error(`No hook config for plugin "${slug}"`);
    return installPluginHooks(slug, entry.targetPath, entry.events);
  }
  return installHooks(slug as HookAgentSlug);
}

export async function uninstallHooksForSlug(slug: string): Promise<string> {
  if (isPluginAgent(slug)) {
    const entries = pluginHookEntries();
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) throw new Error(`No hook config for plugin "${slug}"`);
    return uninstallPluginHooks(slug, entry.targetPath);
  }
  return uninstallHooks(slug as HookAgentSlug);
}

// ---------------------------------------------------------------------------
// Generic hookmap logic (shared with built-in Claude/Codex + all plugins)
// ---------------------------------------------------------------------------

/** Generic state check for a hookmap-style hooks file. */
export function pluginHooksState(
  slug: string,
  file: string,
  events: Array<[string, string, string | null, number?, string?]>,
): HooksState {
  const root = readJsonObject(file);
  if (!root) return 'not-installed';
  const mark = marker(slug as HookAgentSlug);
  const hooks = root.hooks;
  let any = false;
  let complete = true;
  for (const [hookEvent, sentinel, matcher, timeout, status] of events) {
    const list = hooks && typeof hooks === 'object'
      ? (hooks as JsonObject)[hookEvent]
      : null;
    const ours = Array.isArray(list)
      ? list.find((entry) => markerCommand(entry, mark) !== null)
      : undefined;
    if (ours !== undefined) {
      any = true;
      const group = ours && typeof ours === 'object' ? ours as JsonObject : {};
      const handler = Array.isArray(group.hooks) && group.hooks[0] && typeof group.hooks[0] === 'object'
        ? group.hooks[0] as JsonObject
        : {};
      if (
        handler.command !== hookCommandForPlugin(slug, sentinel, status)
        || (matcher ?? undefined) !== group.matcher
        || (timeout ?? undefined) !== handler.timeout
      ) complete = false;
    } else {
      complete = false;
    }
  }
  if (!any) return 'not-installed';
  return complete ? 'installed' : 'outdated';
}

/** Generic install for a hookmap-style hooks file. */
export function installPluginHooks(
  slug: string,
  file: string,
  events: Array<[string, string, string | null, number?, string?]>,
): InstallResult {
  const { devMode } = resolveHookScript();
  let root: JsonObject = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file} is not a JSON object; not touching it`);
    }
    root = parsed as JsonObject;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    if (root.hooks !== undefined) {
      throw new Error(`"hooks" in ${file} is not an object; not touching it`);
    }
    root.hooks = {};
  }
  const hooks = root.hooks as JsonObject;
  const mark = marker(slug as HookAgentSlug);

  for (const [hookEvent, sentinel, matcher, timeout, status] of events) {
    const command = hookCommandForPlugin(slug, sentinel, status);
    let list = hooks[hookEvent];
    if (list === undefined) {
      list = [];
      hooks[hookEvent] = list;
    }
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => markerCommand(entry, mark) === null);
    const handler: JsonObject = { type: 'command', command };
    if (timeout !== undefined) handler.timeout = timeout;
    const entry: JsonObject = { hooks: [handler] };
    if (matcher) entry.matcher = matcher;
    kept.push(entry);
    hooks[hookEvent] = kept;
  }

  writeAtomic(file, JSON.stringify(root, null, 2));
  return { summary: 'Installed', devMode };
}

/** Generic uninstall for a hookmap-style hooks file. */
function uninstallPluginHooks(slug: string, file: string): string {
  const root = readJsonObject(file);
  if (!root) return 'Nothing installed; nothing to remove';
  const mark = marker(slug as HookAgentSlug);
  let removed = 0;
  if (root.hooks && typeof root.hooks === 'object') {
    const hooks = root.hooks as JsonObject;
    for (const eventName of Object.keys(hooks)) {
      const list = hooks[eventName];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((entry) => markerCommand(entry, mark) === null);
      removed += list.length - kept.length;
      if (kept.length === 0) {
        delete hooks[eventName];
      } else {
        hooks[eventName] = kept;
      }
    }
  }
  if (removed === 0) return 'No termdock hooks found; nothing to remove';
  writeAtomic(file, JSON.stringify(root, null, 2));
  return 'Removed';
}

/**
 * Startup keeper: rewrite any integration that is installed but stale so
 * hooks keep pointing at a real termdock after the package moves or updates.
 * Covers both built-in and plugin agents. Returns how many were refreshed.
 */
export function refreshStaleHooksAtLaunch(): number {
  let refreshed = 0;
  for (const agent of HOOK_AGENTS) {
    if (hooksState(agent) !== 'outdated') continue;
    try {
      void installHooks(agent);
      refreshed++;
      console.log(`[agent-hooks] refreshed stale ${agent} hooks at ${abbreviateHome(targetPath(agent))}`);
    } catch (error) {
      console.warn(`[agent-hooks] could not refresh stale ${agent} hooks:`, (error as Error).message);
    }
  }
  // Plugin agents
  for (const entry of pluginHookEntries()) {
    const state = pluginHooksState(
      entry.slug,
      entry.targetPath,
      entry.events,
    );
    if (state !== 'outdated') continue;
    try {
      void installPluginHooks(entry.slug, entry.targetPath, entry.events);
      refreshed++;
      console.log(`[agent-hooks] refreshed stale plugin ${entry.slug} hooks at ${abbreviateHome(entry.targetPath)}`);
    } catch (error) {
      console.warn(`[agent-hooks] could not refresh stale plugin ${entry.slug} hooks:`, (error as Error).message);
    }
  }
  return refreshed;
}
