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
import { execFile } from 'node:child_process';
import { agentBySlug } from './registry.js';

export type HookAgentSlug = 'claude' | 'codex' | 'copilot' | 'opencode' | 'pi' | 'grok';

export type HooksState = 'not-installed' | 'installed' | 'outdated';

export interface HookAgentInfo {
  slug: HookAgentSlug;
  displayName: string;
  /** The file the integration installs into, ~-abbreviated for display. */
  targetDisplay: string;
  state: HooksState;
  accentColor: string | null;
  icon: string | null;
}

export const HOOK_AGENTS: HookAgentSlug[] = ['claude', 'codex', 'copilot', 'opencode', 'pi', 'grok'];

const DISPLAY_NAMES: Record<HookAgentSlug, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot CLI',
  opencode: 'OpenCode',
  pi: 'Pi',
  grok: 'Grok Build',
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

/** Codex's hook events (~/.codex/hooks.json, Claude-shaped). Codex is
 *  turn-level only: no Notification hook, and no SessionEnd — the pane's
 *  foreground detection clears the badge when Codex exits. */
const CODEX_HOOK_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'prompt-submit'],
  ['Stop', 'stop'],
];

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
function opencodePluginJs(): string {
  const prefix = JSON.stringify(
    `"${process.execPath}" "${resolveHookScript().script}" agent-hook opencode `,
  );
  return `// termdock agent-hook opencode bridge — generated by termdock, do not edit.
// Bridges OpenCode plugin events onto the termdock agent-hook emitter,
// which is inert outside termdock (gated on the TERMDOCK env var).
export const TermdockPresence = async ({ $ }) => {
  if (!process.env["TERMDOCK"]) return {}
  const cmd = ${prefix}
  const emit = (event) => $\`sh -c \${cmd + event}\`.quiet().nothrow()

  // Plugin load = the agent is running in this pane.
  await emit("session-start")

  return {
    dispose: async () => {
      await emit("session-end")
    },
    "tool.execute.before": async () => {
      await emit("prompt-submit")
    },
    "permission.ask": async () => {
      await emit("permission-request")
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await emit("stop")
      } else if (event.type === "permission.replied") {
        await emit("prompt-submit")
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
// Public API
// ---------------------------------------------------------------------------

export function hooksState(agent: HookAgentSlug): HooksState {
  const file = targetPath(agent);
  if (agent === 'claude') return hookMapState(file, agent, CLAUDE_HOOK_EVENTS);
  if (agent === 'codex') return hookMapState(file, agent, CODEX_HOOK_EVENTS);
  const expected = ownedFileContent(agent);
  if (expected === null) return 'not-installed';
  return ownedFileState(file, expected, marker(agent));
}

export function listHookAgents(): HookAgentInfo[] {
  return HOOK_AGENTS.map((slug) => ({
    slug,
    displayName: DISPLAY_NAMES[slug],
    targetDisplay: abbreviateHome(targetPath(slug)),
    state: hooksState(slug),
    accentColor: agentBySlug(slug)?.accentColor ?? null,
    icon: agentBySlug(slug)?.icon ?? null,
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
    try {
      await enableCodexHooksFeature();
      return { summary: 'Installed', devMode };
    } catch (error) {
      return {
        summary: `Installed, but couldn't run \`codex features enable hooks\` (${(error as Error).message}) — run it once manually`,
        devMode,
      };
    }
  }
  const content = ownedFileContent(agent);
  if (content === null) throw new Error(`no owned-file integration for ${agent}`);
  ownedFileInstall(file, content, marker(agent));
  return { summary: 'Installed', devMode };
}

export async function uninstallHooks(agent: HookAgentSlug): Promise<string> {
  const file = targetPath(agent);
  if (agent === 'claude' || agent === 'codex') {
    return hookMapUninstall(file, agent);
  }
  return ownedFileUninstall(file, marker(agent));
}

/**
 * Startup keeper: rewrite any integration that is installed but stale so
 * hooks keep pointing at a real termdock after the package moves or updates.
 * Returns how many integrations were refreshed.
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
  return refreshed;
}
