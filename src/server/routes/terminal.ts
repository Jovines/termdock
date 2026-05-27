import express from 'express';
import fs from 'fs';
import os from 'os';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import type { WebSocket } from 'ws';

const router: express.Router = express.Router();
const execFileAsync = promisify(execFile);

// WebSocket clients per session (separate from SSE clients).
const wsClients = new Map<string, Map<string, WebSocket>>();

// Sessions where copy-mode -e just auto-exited at the bottom.
// Prevents immediate re-entry on subsequent scroll-down commands.
const exitedAtBottom = new Set<string>();


type TerminalMode = 'shell' | 'tmux';

interface TmuxPane {
  id: string;
  index: number;
  active: boolean;
  width: number;
  height: number;
  top: number;
  left: number;
  command: string;
  title: string;
}

interface TmuxWindow {
  id: string;
  name: string;
  index: number;
  active: boolean;
  panes: TmuxPane[];
}

interface TmuxLayout {
  sessionId: string;
  sessionName: string;
  windows: TmuxWindow[];
  activeWindowId: string;
  activePaneId: string;
  inCopyMode: boolean;
}

// PTY backend abstraction
interface PtyProvider {
  spawn(
    shell: string,
    args: string[],
    options: {
      name?: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    }
  ): PtyProcess;
  backend: string;
}

interface PtyProcess {
  onData(handler: (data: string) => void): { dispose: () => void };
  onExit(handler: (event: { exitCode: number; signal: number | null }) => void): { dispose: () => void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause?(): void;
  resume?(): void;
  pid?: number;
}

interface TmuxControl {
  process: ChildProcess;
  nextSeq: number;
  pending: Map<number, { resolve: (value: string) => void; reject: (error: Error) => void; output: string }>;
  buffer: string;
  dead: boolean;
}

interface TerminalSession {
  ptyProcess: PtyProcess;
  ptyBackend: string;
  cwd: string;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  lastActivity: number;
  clients: Map<string, express.Response>;
  createdAt: number;
  shouldPersist: boolean;
  keepAliveMs: number | null;
  lastDetachedAt: number | null;
  hasWrittenData: boolean;
  activeProgram: {
    command: string | null;
    source: 'tmux-pane' | 'shell-tty' | 'shell-pid' | 'unknown';
    updatedAt: number;
  } | null;
  dataDisposable?: { dispose: () => void };
  exitDisposable?: { dispose: () => void };
  tmuxControl?: TmuxControl;
  oscSniffBuf: string;
  lastOscCwd: string | null;
}

interface PersistedClientSession {
  sessionId: string;
  name: string;
  backendSessionId: string | null;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  keepAliveMs: number | null;
  createdAt: number;
  lastActivity: number;
}

interface ClientTerminalState {
  sessions: PersistedClientSession[];
  activeSessionId: string | null;
  updatedAt: number;
}

const terminalSessions = new Map<string, TerminalSession>();
const clientTerminalStates = new Map<string, ClientTerminalState>();
// ── 持久化 clientTerminalStates 到磁盘，防止服务重启后丢失 ──
const CLIENT_STATES_FILE = `${os.homedir()}/.termdock/client-states.json`;
let persistClientStatesTimer: ReturnType<typeof setTimeout> | null = null;

function loadClientStatesFromDisk(): void {
  try {
    if (fs.existsSync(CLIENT_STATES_FILE)) {
      const raw = fs.readFileSync(CLIENT_STATES_FILE, 'utf-8');
      const data = JSON.parse(raw) as Record<string, ClientTerminalState>;
      for (const [key, value] of Object.entries(data)) {
        // 去重：同 client 下 tmux 同名 session 只保留最后一条
        const deduped = deduplicateClientState(value);
        clientTerminalStates.set(key, deduped);
      }
      console.log(`[session-persist] Loaded ${clientTerminalStates.size} client states from disk`);
    }
  } catch (error) {
    console.warn('[session-persist] Failed to load client states:', getErrorMessage(error));
  }
}

function deduplicateClientState(state: ClientTerminalState): ClientTerminalState {
  const seen = new Map<string, number>(); // sessionId → index, tmuxSessionName → index
  const sessions = state.sessions;
  let hasDuplicates = false;

  const keep = new Array<boolean>(sessions.length).fill(true);

  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];

    // 同 sessionId 的只保留最新的
    if (seen.has(s.sessionId)) {
      keep[i] = false;
      hasDuplicates = true;
      continue;
    }
    seen.set(s.sessionId, i);

    // tmux 同名 session 只保留最新的
    if (s.mode === 'tmux' && s.tmuxSessionName) {
      const dupKey = `tmux:${s.tmuxSessionName}`;
      if (seen.has(dupKey)) {
        keep[i] = false;
        hasDuplicates = true;
        continue;
      }
      seen.set(dupKey, i);
    }
  }

  if (!hasDuplicates) return state;

  return {
    ...state,
    sessions: sessions.filter((_, i) => keep[i]),
  };
}

function schedulePersistClientStates(): void {
  if (persistClientStatesTimer) clearTimeout(persistClientStatesTimer);
  persistClientStatesTimer = setTimeout(() => {
    try {
      const dir = `${os.homedir()}/.termdock`;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, ClientTerminalState> = {};
      for (const [key, value] of clientTerminalStates.entries()) {
        obj[key] = value;
      }
      fs.writeFileSync(CLIENT_STATES_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (error) {
      console.warn('[session-persist] Failed to persist client states:', getErrorMessage(error));
    }
  }, 200); // 200ms debounce — short enough to survive most tsx watch restart windows
}

// 进程退出前立即刷盘，避免 tsx watch 重启导致状态丢失
function flushPersistAndExit(): void {
  if (persistClientStatesTimer) {
    clearTimeout(persistClientStatesTimer);
    persistClientStatesTimer = null;
  }
  try {
    const dir = `${os.homedir()}/.termdock`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj: Record<string, ClientTerminalState> = {};
    for (const [key, value] of clientTerminalStates.entries()) {
      obj[key] = value;
    }
    fs.writeFileSync(CLIENT_STATES_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch { /* best effort */ }
}
process.on('SIGTERM', () => { flushPersistAndExit(); process.exit(0); });
process.on('SIGINT', () => { flushPersistAndExit(); process.exit(0); });

// 服务启动时从磁盘加载（带去重，防止历史累积的重复条目复活）
loadClientStatesFromDisk();

// 清理磁盘恢复后后端已不存在的 session 引用。
// 服务重启时 terminalSessions 是空的，持久化的 client states
// 全部指向已销毁的 session，必须清掉，否则客户端重连时会不断创建新 session。
(function pruneOrphanClientSessions(): void {
  let changed = false;
  for (const [clientId, state] of clientTerminalStates.entries()) {
    let sessionChanged = false;
    const cleaned = state.sessions.map((s) => {
      if (s.backendSessionId != null && !terminalSessions.has(s.backendSessionId)) {
        sessionChanged = true;
        return { ...s, backendSessionId: null };
      }
      return s;
    });

    if (!sessionChanged) continue;
    changed = true;

    if (cleaned.length === 0) {
      clientTerminalStates.delete(clientId);
    } else {
      const activeOk = state.activeSessionId != null &&
        cleaned.some((s) => s.sessionId === state.activeSessionId);
      clientTerminalStates.set(clientId, {
        sessions: cleaned,
        activeSessionId: activeOk ? state.activeSessionId : cleaned[0]?.sessionId ?? null,
        updatedAt: Date.now(),
      });
    }
  }
  if (changed) schedulePersistClientStates();
})();

// ── end persistence ──

// 开发模式下使用更激进的清理策略
const isDevelopment = process.env.NODE_ENV === 'development';
const TERMINAL_IDLE_TIMEOUT = parseInt(process.env.TERMINAL_IDLE_TIMEOUT || (isDevelopment ? '300000' : '1800000'), 10);
const CLEANUP_INTERVAL = isDevelopment ? 60 * 1000 : 5 * 60 * 1000;
const DEFAULT_KEEP_ALIVE_MS = parseInt(process.env.TERMINAL_DEFAULT_KEEPALIVE_MS || String(3 * 60 * 60 * 1000), 10);
const RECONNECT_SCROLLBACK = parseInt(process.env.TERMINAL_RECONNECT_SCROLLBACK || '200', 10);
const TMUX_POLL_INTERVAL = parseInt(process.env.TMUX_POLL_INTERVAL || '500', 10);
const ACTIVE_PROGRAM_POLL_INTERVAL = parseInt(process.env.TERMINAL_ACTIVE_PROGRAM_POLL_INTERVAL || '1200', 10);
const TMUX_DELIMITER = '\x1f';
// 输出历史缓冲区（限制大小）
const MAX_HISTORY_SIZE = 100 * 1024; // 100KB per session
const sessionHistory = new Map<string, { chunks: string[]; size: number }>();

function addToHistory(sessionId: string, data: string): void {
  const history = sessionHistory.get(sessionId);
  if (!history) {
    sessionHistory.set(sessionId, { chunks: [data], size: data.length });
    return;
  }

  history.chunks.push(data);
  history.size += data.length;

  // 超出限制时移除最旧的 chunk
  while (history.size > MAX_HISTORY_SIZE && history.chunks.length > 0) {
    const removed = history.chunks.shift();
    if (removed) {
      history.size -= removed.length;
    }
  }
}

function getHistory(sessionId: string): string[] {
  const history = sessionHistory.get(sessionId);
  return history ? [...history.chunks] : [];
}

function clearHistory(sessionId: string): void {
  sessionHistory.delete(sessionId);
}

function getReconnectionHistory(sessionId: string): string[] {
  const history = getHistory(sessionId);
  if (RECONNECT_SCROLLBACK <= 0 || history.length <= RECONNECT_SCROLLBACK) {
    return history;
  }
  return history.slice(-RECONNECT_SCROLLBACK);
}

function normalizeKeepAliveMs(input: unknown): number | null {
  if (input === null) {
    return null;
  }

  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return DEFAULT_KEEP_ALIVE_MS;
  }

  if (input < 1000) {
    return 1000;
  }

  return Math.floor(input);
}

function normalizeMode(input: unknown): TerminalMode {
  return input === 'tmux' ? 'tmux' : 'shell';
}

function normalizePersistedClientSession(input: unknown): PersistedClientSession | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<PersistedClientSession>;
  if (typeof candidate.sessionId !== 'string' || typeof candidate.name !== 'string') {
    return null;
  }

  return {
    sessionId: candidate.sessionId,
    name: candidate.name,
    backendSessionId: typeof candidate.backendSessionId === 'string' && candidate.backendSessionId.trim().length > 0
      ? candidate.backendSessionId
      : null,
    mode: normalizeMode(candidate.mode),
    tmuxSessionName: typeof candidate.tmuxSessionName === 'string' && candidate.tmuxSessionName.trim().length > 0
      ? candidate.tmuxSessionName
      : null,
    keepAliveMs: normalizeKeepAliveMs(candidate.keepAliveMs),
    createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
      ? Math.floor(candidate.createdAt)
      : Date.now(),
    lastActivity: typeof candidate.lastActivity === 'number' && Number.isFinite(candidate.lastActivity)
      ? Math.floor(candidate.lastActivity)
      : Date.now(),
  };
}

function normalizeClientTerminalState(input: unknown): ClientTerminalState {
  if (!input || typeof input !== 'object') {
    return { sessions: [], activeSessionId: null, updatedAt: Date.now() };
  }

  const candidate = input as Partial<ClientTerminalState> & { sessions?: unknown[] };
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions
      .map((session) => normalizePersistedClientSession(session))
      .filter((session): session is PersistedClientSession => session !== null)
    : [];
  const activeSessionId = typeof candidate.activeSessionId === 'string' && candidate.activeSessionId.trim().length > 0
    ? candidate.activeSessionId
    : null;

  return {
    sessions,
    activeSessionId,
    updatedAt: Date.now(),
  };
}

function generateTmuxSessionName(): string {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `wt-${timePart}${randomPart}`;
}

function normalizeTmuxSessionName(input: unknown): string {
  if (typeof input !== 'string') {
    return generateTmuxSessionName();
  }
  const normalized = input.trim();
  return normalized.length > 0 ? normalized : generateTmuxSessionName();
}

async function runTmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', args, {
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

// ---- Persistent tmux control-mode connection ----
// Instead of spawning a new `tmux` process per command (execFile overhead),
// maintain a single `tmux -C attach` child process per session.  Commands
// are written to stdin and responses are parsed from stdout using tmux's
// control-mode protocol (%begin / %end / %exit).

const TMUX_CONTROL_ENABLED = false;
const TMUX_CONTROL_COMMAND_TIMEOUT_MS = 2000;

function spawnTmuxControl(sessionName: string): TmuxControl {
  const process = spawn('tmux', ['-C', 'attach', '-t', sessionName], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const control: TmuxControl = {
    process,
    nextSeq: 0,
    pending: new Map(),
    buffer: '',
    dead: false,
  };

  process.stdout?.on('data', (chunk: Buffer) => {
    control.buffer += chunk.toString();
    const lines = control.buffer.split('\n');
    control.buffer = lines.pop() || '';

    for (const line of lines) {
      // %begin <seq>  — start of command output block
      const beginMatch = line.match(/^%begin\s+(\d+)$/);
      if (beginMatch) {
        // Subsequent lines (until %end) are the output.
        continue;
      }

      // %end <seq>  — end of output block
      const endMatch = line.match(/^%end\s+(\d+)$/);
      if (endMatch) {
        continue;
      }

      // %exit <seq> <code>  — command finished
      const exitMatch = line.match(/^%exit\s+(\d+)\s+(\d+)$/);
      if (exitMatch) {
        const seq = parseInt(exitMatch[1], 10);
        const code = parseInt(exitMatch[2], 10);
        const entry = control.pending.get(seq);
        if (entry) {
          control.pending.delete(seq);
          if (code === 0) {
            entry.resolve(entry.output);
          } else {
            entry.reject(new Error(`tmux command exited with code ${code}`));
          }
        }
        continue;
      }

      // Output line between %begin and %end — attach to the most recent
      // pending entry (the one with the matching sequence).
      // We don't know which seq this belongs to until %end/%exit,
      // so stash it on the newest pending entry.
      if (control.pending.size > 0) {
        const lastEntry = Array.from(control.pending.values()).pop();
        if (lastEntry) {
          lastEntry.output += (lastEntry.output ? '\n' : '') + line;
        }
      }
    }
  });

  process.on('error', (err) => {
    control.dead = true;
    for (const [, entry] of control.pending) {
      entry.reject(err);
    }
    control.pending.clear();
  });

  process.on('exit', () => {
    control.dead = true;
    for (const [, entry] of control.pending) {
      entry.reject(new Error('tmux control process exited'));
    }
    control.pending.clear();
  });

  process.stderr?.on('data', (chunk: Buffer) => {
    console.warn(`[tmux-control ${sessionName}] ${chunk.toString().trim()}`);
  });

  return control;
}

/**
 * Send a command through the persistent control-mode connection and wait
 * for the response.  Falls back to `execFile` if the control process is
 * dead, the write fails, or the command times out.
 */
async function sendTmuxCommand(
  _sessionName: string,
  control: TmuxControl | undefined,
  args: string[],
): Promise<string> {
  if (control && !control.dead) {
    const seq = control.nextSeq++;
    const command = args.join(' ');

    try {
      return await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          control.pending.delete(seq);
          reject(new Error('tmux control command timed out'));
        }, TMUX_CONTROL_COMMAND_TIMEOUT_MS);

        control.pending.set(seq, {
          resolve: (value: string) => { clearTimeout(timeout); resolve(value); },
          reject: (err: Error) => { clearTimeout(timeout); reject(err); },
          output: '',
        });

        control.process.stdin?.write(command + '\n');
      });
    } catch {
      // Control mode failed — mark dead and fall through to execFile.
      control.dead = true;
    }
  }

  // Fallback: spawn a one-shot tmux process
  return runTmux(args);
}

/**
 * Fire-and-forget variant for scroll commands where we don't need to wait
 * for a response.  Writes through the control process if available;
 * falls back to a one-shot execFile on any failure.
 */
function sendTmuxCommandFireAndForget(
  _sessionName: string,
  control: TmuxControl | undefined,
  args: string[],
): void {
  if (control && !control.dead) {
    try {
      control.process.stdin?.write(args.join(' ') + '\n');
      return;
    } catch {
      control.dead = true;
      // Fall through to execFile fallback below
    }
  }

  // Fallback: spawn a one-shot process (fire-and-forget)
  const child = execFile('tmux', args, { timeout: 5000 });
  child.on('error', () => { /* ignore */ });
}

function destroyTmuxControl(control: TmuxControl | undefined): void {
  if (!control) return;
  control.dead = true;
  for (const [, entry] of control.pending) {
    entry.reject(new Error('tmux control process destroyed'));
  }
  control.pending.clear();
  try {
    control.process.kill();
  } catch {
    // Process may already be dead
  }
}

function isTmuxUnavailableMessage(errorMessage: string): boolean {
  return /no such file or directory|not found|enoent/i.test(errorMessage);
}

async function getTmuxStatus(): Promise<{ available: boolean; version: string | null; reason: string | null }> {
  try {
    const raw = await runTmux(['-V']);
    return {
      available: true,
      version: raw.trim() || null,
      reason: null,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (isTmuxUnavailableMessage(errorMessage)) {
      return {
        available: false,
        version: null,
        reason: 'tmux is not installed or not available in PATH.',
      };
    }

    return {
      available: false,
      version: null,
      reason: errorMessage || 'Failed to detect tmux availability',
    };
  }
}

async function enableTmuxMouse(sessionName: string): Promise<void> {
  let lastError: unknown;

  // A newly attached session can race briefly with the client startup.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await runTmux(['set-option', '-t', sessionName, 'mouse', 'on']);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function configureTmuxWheelBindings(): Promise<void> {
  // Pass mouse events through to TUI programs when they request mouse
  // reporting (vim with mouse=a, htop, etc.).  When only the alternate
  // screen is active (less, man without mouse), send arrow keys instead.
  // Otherwise fall back to tmux copy-mode for scrollback history.
  //
  // The command is passed as a single string argument because tmux's
  // argument parser cannot parse nested { } groups from separate argv
  // tokens — execFile bypasses the shell, so tmux receives each token
  // individually and rejects the command with "too many arguments".
  const upCmd = "if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } { if -F '#{alternate_on}' { send-keys -N 5 Up } { copy-mode -He } }";

  // WheelDownPane: don't enter copy mode — scrolling down at the live
  // prompt has nowhere to go and just flash-enters/exits copy mode.
  const downCmd = "if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } { if -F '#{alternate_on}' { send-keys -N 5 Down } }";

  await runTmux(['bind-key', '-n', 'WheelUpPane', upCmd]);
  await runTmux(['bind-key', '-n', 'WheelDownPane', downCmd]);
}

async function disableTmuxStatus(sessionName: string): Promise<void> {
  let lastError: unknown;

  // A newly attached session can race briefly with the client startup.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await runTmux(['set-option', '-t', sessionName, 'status', 'off']);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function captureTmuxPane(sessionName: string): Promise<string> {
  let lastError: unknown;

  // An attached session can briefly race with tmux pane availability.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const paneId = (await runTmux([
        'display-message',
        '-t',
        sessionName,
        '-p',
        '#{pane_id}',
      ])).trim();

      return await runTmux([
        'capture-pane',
        '-p',
        '-e',
        '-J',
        '-t',
        paneId || sessionName,
      ]);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function isTmuxPaneInMode(target: string, control?: TmuxControl): Promise<boolean> {
  const paneInModeRaw = (await sendTmuxCommand(target, control, [
    'display-message',
    '-t',
    target,
    '-p',
    '#{pane_in_mode}',
  ])).trim();

  return paneInModeRaw === '1';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyInCopyModeError(message: string): boolean {
  return /already in.*mode/i.test(message);
}

function isNotInCopyModeError(message: string): boolean {
  return /not in (a )?mode/i.test(message);
}

function parseDelimitedRow(line: string, expected: number): string[] | null {
  let normalizedLine = line;
  if (normalizedLine.includes('\\037')) {
    normalizedLine = normalizedLine.split('\\037').join(TMUX_DELIMITER);
  }
  if (normalizedLine.includes('\\x1f')) {
    normalizedLine = normalizedLine.split('\\x1f').join(TMUX_DELIMITER);
  }

  const parts = normalizedLine.split(TMUX_DELIMITER);
  if (parts.length < expected) {
    return null;
  }
  if (parts.length === expected) {
    return parts;
  }
  const merged = parts.slice(0, expected - 1);
  merged.push(parts.slice(expected - 1).join(TMUX_DELIMITER));
  return merged;
}

function getPtyProcessPid(ptyProcess: PtyProcess): number | null {
  if (typeof ptyProcess.pid === 'number' && Number.isFinite(ptyProcess.pid)) {
    return ptyProcess.pid;
  }
  return null;
}

function normalizeProgramName(command: string | null | undefined): string | null {
  if (typeof command !== 'string') {
    return null;
  }

  const normalized = command.trim();
  if (!normalized) {
    return null;
  }

  const lastSegment = normalized.split(/[\\/]/).pop()?.trim();
  return lastSegment && lastSegment.length > 0 ? lastSegment : normalized;
}

// ── OSC 0/2 title sniffing for CWD tracking ──

const OSC_SNIFF_CAP = 32768; // 32 KB rolling buffer
const OSC_PATTERN = /\x1b\][02];([^\x07\x1b]*)(\x07|\x1b\\)/g;

function parseTitleCwd(title: string, home: string): string | null {
  // Format: user@host:/path/to/dir
  const atIdx = title.lastIndexOf('@');
  if (atIdx >= 0) {
    const afterAt = title.slice(atIdx + 1);
    const colonIdx = afterAt.indexOf(':');
    if (colonIdx >= 0) {
      const pathPart = afterAt.slice(colonIdx + 1).trim();
      if (!pathPart) return null;
      if (pathPart.startsWith('~/')) return home + pathPart.slice(1);
      if (pathPart === '~') return home;
      if (pathPart.startsWith('/')) return pathPart;
      return home + '/' + pathPart;
    }
  }

  // Direct path format
  const trimmed = title.trim();
  if (trimmed.startsWith('/')) return trimmed;
  if (trimmed.startsWith('~/')) return home + trimmed.slice(1);
  if (trimmed === '~') return home;

  return null;
}

function sniffCwdFromOsc(buf: string, home: string): { cwd: string | null; remaining: string } {
  let match: RegExpExecArray | null;
  let lastCwd: string | null = null;
  let lastMatchEnd = 0;

  // Reset lastIndex since we're passing a concatenated string each time
  OSC_PATTERN.lastIndex = 0;

  while ((match = OSC_PATTERN.exec(buf)) !== null) {
    lastCwd = parseTitleCwd(match[1] || '', home) || lastCwd;
    lastMatchEnd = match.index + match[0].length;
  }

  // Keep the tail that might contain an incomplete OSC sequence
  const remaining = buf.slice(lastMatchEnd).slice(-128); // keep at most 128 bytes of tail

  return { cwd: lastCwd, remaining };
}

// ── end OSC sniffing ──

function getActiveProgramFromTmuxLayout(layout: TmuxLayout): { command: string | null; source: 'tmux-pane'; updatedAt: number } | null {
  const activeWindow = layout.windows.find((window) => window.id === layout.activeWindowId);
  const activePane = activeWindow?.panes.find((pane) => pane.id === layout.activePaneId);
  const command = normalizeProgramName(activePane?.command);

  if (!command) {
    return null;
  }

  return {
    command,
    source: 'tmux-pane',
    updatedAt: Date.now(),
  };
}

async function detectShellActiveProgram(session: TerminalSession): Promise<{
  command: string | null;
  source: 'shell-tty' | 'shell-pid' | 'unknown';
  updatedAt: number;
} | null> {
  const pid = getPtyProcessPid(session.ptyProcess);
  if (pid === null) {
    return null;
  }

  try {
    const ttyPath = await fs.promises.readlink(`/proc/${pid}/fd/0`);
    const ttyName = ttyPath.startsWith('/dev/') ? ttyPath.slice('/dev/'.length) : ttyPath;

    const { stdout } = await execFileAsync('ps', [
      '-t',
      ttyName,
      '-o',
      'pid=,ppid=,pgid=,tpgid=,stat=,comm=',
    ], {
      timeout: 3000,
      maxBuffer: 512 * 1024,
    });

    const rows = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/);
        if (!match) {
          return null;
        }

        return {
          pid: Number.parseInt(match[1] || '0', 10),
          pgid: Number.parseInt(match[3] || '0', 10),
          tpgid: Number.parseInt(match[4] || '0', 10),
          stat: match[5] || '',
          command: normalizeProgramName(match[6]),
        };
      })
      .filter((row): row is { pid: number; pgid: number; tpgid: number; stat: string; command: string | null } => row !== null);

    if (rows.length > 0) {
      const foregroundRows = rows.filter((row) => row.command && row.tpgid > 0 && row.pgid === row.tpgid && !row.stat.startsWith('Z'));
      const preferredForeground = foregroundRows.find((row) => row.pid !== pid) ?? foregroundRows[foregroundRows.length - 1];
      if (preferredForeground?.command) {
        return {
          command: preferredForeground.command,
          source: 'shell-tty',
          updatedAt: Date.now(),
        };
      }

      const shellRow = rows.find((row) => row.pid === pid && row.command);
      if (shellRow?.command) {
        return {
          command: shellRow.command,
          source: 'shell-pid',
          updatedAt: Date.now(),
        };
      }
    }
  } catch {
    // Fall through to shell fallback.
  }

  return {
    command: normalizeProgramName(process.env.SHELL || '/bin/sh'),
    source: 'unknown',
    updatedAt: Date.now(),
  };
}

async function resolveTmuxClientTty(sessionName: string, preferredClientPid: number | null): Promise<string | null> {
  const clientsRaw = await runTmux([
    'list-clients',
    '-t',
    sessionName,
    '-F',
    `#{client_pid}${TMUX_DELIMITER}#{client_tty}`,
  ]);

  const rows = clientsRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseDelimitedRow(line, 2))
    .filter((row): row is string[] => row !== null);

  if (rows.length === 0) {
    return null;
  }

  if (preferredClientPid !== null) {
    const matched = rows.find(([clientPid]) => clientPid === String(preferredClientPid));
    if (matched?.[1]) {
      return matched[1];
    }
  }

  return rows[0][1] || null;
}

async function ensureTmuxSessionExists(sessionName: string): Promise<void> {
  try {
    await runTmux(['has-session', '-t', sessionName]);
    return;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (!/can't find session|no server running/i.test(errorMessage)) {
      throw error;
    }
  }

  await runTmux(['new-session', '-d', '-s', sessionName]);
}

async function getTmuxLayout(sessionName: string): Promise<TmuxLayout> {
  const sessionInfoRaw = (await runTmux([
    'display-message',
    '-t',
    sessionName,
    '-p',
    `#{session_id}${TMUX_DELIMITER}#{session_name}${TMUX_DELIMITER}#{window_id}${TMUX_DELIMITER}#{pane_id}${TMUX_DELIMITER}#{pane_in_mode}`,
  ])).trim();

  const sessionInfo = parseDelimitedRow(sessionInfoRaw, 5);
  if (!sessionInfo) {
    throw new Error(`Failed to parse tmux session info: ${sessionInfoRaw}`);
  }

  const [sessionId, resolvedSessionName, activeWindowId, activePaneId, paneInMode] = sessionInfo;

  const windowsRaw = await runTmux([
    'list-windows',
    '-t',
    sessionName,
    '-F',
    `#{window_id}${TMUX_DELIMITER}#{window_name}${TMUX_DELIMITER}#{window_index}${TMUX_DELIMITER}#{window_active}`,
  ]);

  const windows: TmuxWindow[] = [];

  for (const line of windowsRaw.trim().split('\n')) {
    if (!line) {
      continue;
    }

    const row = parseDelimitedRow(line, 4);
    if (!row) {
      continue;
    }

    const [windowId, windowName, windowIndexRaw, windowActiveRaw] = row;
    const panesRaw = await runTmux([
      'list-panes',
      '-t',
      windowId,
      '-F',
      `#{pane_id}${TMUX_DELIMITER}#{pane_index}${TMUX_DELIMITER}#{pane_active}${TMUX_DELIMITER}#{pane_width}${TMUX_DELIMITER}#{pane_height}${TMUX_DELIMITER}#{pane_top}${TMUX_DELIMITER}#{pane_left}${TMUX_DELIMITER}#{pane_current_command}${TMUX_DELIMITER}#{pane_title}`,
    ]);

    const panes: TmuxPane[] = panesRaw.trim().split('\n').filter(Boolean).map((paneLine) => {
      const paneRow = parseDelimitedRow(paneLine, 9);
      if (!paneRow) {
        return null;
      }

      const [paneId, paneIndexRaw, paneActiveRaw, widthRaw, heightRaw, topRaw, leftRaw, command, title] = paneRow;
      return {
        id: paneId,
        index: parseInt(paneIndexRaw || '0', 10),
        active: paneActiveRaw === '1',
        width: parseInt(widthRaw || '0', 10),
        height: parseInt(heightRaw || '0', 10),
        top: parseInt(topRaw || '0', 10),
        left: parseInt(leftRaw || '0', 10),
        command: command || '',
        title: title || '',
      } as TmuxPane;
    }).filter((pane): pane is TmuxPane => pane !== null);

    windows.push({
      id: windowId,
      name: windowName || '',
      index: parseInt(windowIndexRaw || '0', 10),
      active: windowActiveRaw === '1',
      panes,
    });
  }

  return {
    sessionId,
    sessionName: resolvedSessionName,
    windows,
    activeWindowId,
    activePaneId,
    inCopyMode: paneInMode === '1',
  };
}

async function getRestoreHistory(sessionId: string, session: TerminalSession): Promise<string[]> {
  // In tmux mode, scrollback belongs to tmux itself rather than the app layer,
  // so capture the active pane to rebuild the visible screen on refresh.
  if (session.mode === 'tmux') {
    if (!session.tmuxSessionName) {
      return [];
    }

    try {
      const snapshot = await captureTmuxPane(session.tmuxSessionName);
      return snapshot
        ? ['\u001b[H\u001b[2J\u001b[3J', snapshot]
        : [];
    } catch (error) {
      console.warn(`Failed to capture tmux pane for ${session.tmuxSessionName}: ${getErrorMessage(error)}`);
      return [];
    }
  }

  return getReconnectionHistory(sessionId);
}

function resolveWorkingDirectory(req: express.Request, inputCwd?: string): string {
  const requestedCwd = inputCwd || os.homedir();

  if (req.pathValidator) {
    return req.pathValidator.validate(requestedCwd);
  }

  if (!fs.existsSync(requestedCwd)) {
    throw new Error('Invalid working directory');
  }

  try {
    fs.accessSync(requestedCwd, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new Error(`Working directory is not accessible: ${requestedCwd}`);
  }

  return requestedCwd;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveShellCandidates(): string[] {
  const candidates: string[] = [];
  const configuredShell = process.env.SHELL;
  if (configuredShell && isExecutable(configuredShell)) {
    candidates.push(configuredShell);
  }

  const fallbackShells = [
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/zsh',
    '/usr/bin/zsh',
    '/bin/sh',
    '/usr/bin/sh',
  ];

  for (const candidate of fallbackShells) {
    if (isExecutable(candidate) && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    throw new Error('No usable shell found. Set SHELL to an installed shell such as /bin/bash or /bin/sh.');
  }

  return candidates;
}

function shouldRetryShellSpawn(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return /posix_spawnp failed|ENOENT|EACCES/i.test(errorMessage);
}

function writeSse(res: express.Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getTotalClients(sessionId: string): number {
  let count = 0;
  const session = terminalSessions.get(sessionId);
  if (session) count += session.clients.size;
  const ws = wsClients.get(sessionId);
  if (ws) count += ws.size;
  return count;
}

function sessionIsOrphaned(sessionId: string): boolean {
  const session = terminalSessions.get(sessionId);
  if (!session) return true;
  if (session.clients.size > 0) return false;
  const ws = wsClients.get(sessionId);
  return !ws || ws.size === 0;
}

function closeClient(session: TerminalSession, sessionId: string, clientId: string): void {
  const client = session.clients.get(clientId);
  if (!client) {
    return;
  }

  session.clients.delete(clientId);
  if (sessionIsOrphaned(sessionId)) {
    session.lastDetachedAt = Date.now();
  }

  try {
    client.end();
  } catch {
    // ignore
  }
}

function broadcastEvent(sessionId: string, payload: unknown): void {
  // SSE clients
  const session = terminalSessions.get(sessionId);
  if (session) {
    for (const [clientId, client] of session.clients.entries()) {
      try {
        writeSse(client, payload);
      } catch {
        closeClient(session, sessionId, clientId);
      }
    }
  }

  // WebSocket clients
  broadcastJsonWs(sessionId, payload);
}

function cleanupSession(sessionId: string, options: { killProcess: boolean; clearHistoryBuffer?: boolean }): void {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    return;
  }

  session.dataDisposable?.dispose();
  session.exitDisposable?.dispose();
  destroyTmuxControl(session.tmuxControl);
  session.tmuxControl = undefined;

  if (session.tmuxSessionName) {
    exitedAtBottom.delete(session.tmuxSessionName);
  }

  if (options.killProcess) {
    try {
      session.ptyProcess.kill();
    } catch {
      // ignore
    }
  }

  for (const client of session.clients.values()) {
    try {
      client.end();
    } catch {
      // ignore
    }
  }

  terminalSessions.delete(sessionId);

  if (options.clearHistoryBuffer !== false) {
    clearHistory(sessionId);
  }
}

function broadcastToWs(sessionId: string, data: string): void {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  for (const ws of clients.values()) {
    try { ws.send(data); } catch { clients.delete(getWsClientKey(ws, clients)); }
  }
}

function getWsClientKey(ws: WebSocket, map: Map<string, WebSocket>): string {
  for (const [key, value] of map.entries()) {
    if (value === ws) return key;
  }
  return '';
}

function broadcastJsonWs(sessionId: string, payload: unknown): void {
  broadcastToWs(sessionId, JSON.stringify(payload));
}

function setupPtyHandlers(sessionId: string, session: TerminalSession): void {
  const home = (process.env.HOME || '/root').replace(/\/+$/, '') || '/';

  session.dataDisposable = session.ptyProcess.onData((data: string) => {
    session.lastActivity = Date.now();
    session.hasWrittenData = true;
    if (session.mode === 'shell') {
      addToHistory(sessionId, data);
    }

    // Sniff OSC 0/2 sequences for CWD tracking
    try {
      const buf = session.oscSniffBuf + data;
      if (buf.length > OSC_SNIFF_CAP) {
        session.oscSniffBuf = buf.slice(-OSC_SNIFF_CAP / 4); // trim
      }
      const { cwd, remaining } = sniffCwdFromOsc(buf, home);
      session.oscSniffBuf = remaining;
      if (cwd && cwd !== session.lastOscCwd) {
        session.lastOscCwd = cwd;
        session.cwd = cwd;
        console.log(`[osc-cwd] session=${sessionId} cwd=${cwd}`);
        broadcastEvent(sessionId, { type: 'cwd', cwd });
      }
    } catch { /* sniff failure should never block data */ }

    broadcastEvent(sessionId, { type: 'data', data });
  });

  session.exitDisposable = session.ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
    broadcastEvent(sessionId, { type: 'exit', exitCode, signal });
    cleanupSession(sessionId, { killProcess: false });
  });
}

async function spawnTerminalSession(req: express.Request, input: {
  cwd?: string;
  cols?: number;
  rows?: number;
  mode?: TerminalMode;
  tmuxSessionName?: string;
  shouldPersist?: boolean;
  keepAliveMs?: number | null;
}): Promise<{ sessionId: string; session: TerminalSession; cols: number; rows: number }> {
  const cwd = resolveWorkingDirectory(req, input.cwd);
  const cols = input.cols || 80;
  const rows = input.rows || 24;
  const sessionId = Math.random().toString(36).substring(2, 15) +
                    Math.random().toString(36).substring(2, 15);
  const mode = normalizeMode(input.mode);
  const tmuxSessionName = mode === 'tmux' ? normalizeTmuxSessionName(input.tmuxSessionName) : null;

  const command = mode === 'tmux'
    ? (process.env.TMUX_BIN || 'tmux')
    : (process.platform === 'win32' ? 'powershell.exe' : resolveShellCandidates()[0]);
  const args = mode === 'tmux' && tmuxSessionName
    ? ['new-session', '-A', '-s', tmuxSessionName]
    : [];

  const envPath = buildAugmentedPath();
  const resolvedEnv = { ...process.env, PATH: envPath };

  const pty = await getPtyProvider();
  const baseEnv = {
    ...resolvedEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };

  let ptyProcess: PtyProcess;

  if (mode === 'shell' && process.platform !== 'win32') {
    const shellCandidates = resolveShellCandidates();
    let lastError: unknown = null;

    ptyProcess = (() => {
      for (const shellCandidate of shellCandidates) {
        try {
          const env = injectShellTitleHooks(shellCandidate, baseEnv);
          console.log(`[osc-cwd] spawning shell=${shellCandidate} env.PROMPT_COMMAND=${env.PROMPT_COMMAND ? 'set' : 'unset'} env.ZDOTDIR=${env.ZDOTDIR ? 'set' : 'unset'}`);
          return pty.spawn(shellCandidate, [], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
          });
        } catch (error) {
          lastError = error;
          if (!shouldRetryShellSpawn(error)) {
            throw error;
          }
        }
      }

      throw lastError ?? new Error('Failed to start shell');
    })();
  } else {
    ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: baseEnv,
    });
  }

  const session: TerminalSession = {
    ptyProcess,
    ptyBackend: pty.backend,
    cwd,
    mode,
    tmuxSessionName,
    lastActivity: Date.now(),
    clients: new Map(),
    createdAt: Date.now(),
    shouldPersist: input.shouldPersist !== false,
    keepAliveMs: normalizeKeepAliveMs(input.keepAliveMs),
    lastDetachedAt: null,
    hasWrittenData: false,
    activeProgram: null,
    oscSniffBuf: '',
    lastOscCwd: null,
  };

  terminalSessions.set(sessionId, session);
  setupPtyHandlers(sessionId, session);

  if (mode === 'tmux' && tmuxSessionName) {
    try {
      await disableTmuxStatus(tmuxSessionName);
    } catch (error) {
      console.warn(`Failed to disable tmux status for ${tmuxSessionName}: ${getErrorMessage(error)}`);
    }

    try {
      await enableTmuxMouse(tmuxSessionName);
    } catch (error) {
      console.warn(`Failed to enable tmux mouse for ${tmuxSessionName}: ${getErrorMessage(error)}`);
    }

    try {
      await configureTmuxWheelBindings();
    } catch (error) {
      console.warn(`Failed to configure tmux wheel bindings: ${getErrorMessage(error)}`);
    }

    // Spawn a persistent control-mode connection so scroll commands
    // don't pay execFile process-spawn overhead on every frame.
    if (TMUX_CONTROL_ENABLED) {
      let ctrl: TmuxControl | undefined;
      try {
        ctrl = spawnTmuxControl(tmuxSessionName);
        // Verify the control process is healthy before we rely on it.
        await sendTmuxCommand(tmuxSessionName, ctrl, ['display-message', '-p', 'ok']);
        session.tmuxControl = ctrl;
      } catch (error) {
        // Control process failed — clean up and fall back to execFile.
        console.warn(`Failed to start tmux control for ${tmuxSessionName}: ${getErrorMessage(error)}`);
        if (ctrl) destroyTmuxControl(ctrl);
      }
    }
  }

  return { sessionId, session, cols, rows };
}

function detectShellType(shellPath: string): 'bash' | 'zsh' | 'fish' | 'other' {
  const base = shellPath.split('/').pop()?.toLowerCase() || '';
  if (base.includes('bash')) return 'bash';
  if (base.includes('zsh')) return 'zsh';
  if (base.includes('fish')) return 'fish';
  return 'other';
}

function injectShellTitleHooks(shellPath: string, baseEnv: Record<string, string>): Record<string, string> {
  const shellType = detectShellType(shellPath);
  const home = (process.env.HOME || '/root').replace(/\/+$/, '') || '/';
  const env = { ...baseEnv };

  // Emit full PWD path in OSC 0 — parser resolves absolute paths directly
  if (shellType === 'bash') {
    env.PROMPT_COMMAND = 'printf "\\033]0;%s@%s:%s\\007" "${USER}" "${HOSTNAME%%.*}" "${PWD}"';
  } else if (shellType === 'zsh') {
    const zdotdir = '/tmp/dinotty-zsh-' + String(process.pid);
    try {
      fs.mkdirSync(zdotdir, { recursive: true });
      fs.writeFileSync(zdotdir + '/.zshenv',
        '[[ -f "' + home + '/.zshenv" ]] && source "' + home + '/.zshenv"\n');
      fs.writeFileSync(zdotdir + '/.zshrc',
        'ZDOTDIR=\n' +
        '[[ -f "' + home + '/.zshrc" ]] && source "' + home + '/.zshrc"\n' +
        'function _wt_precmd { printf "\\033]0;%s@%s:%s\\007" "${USER}" "${HOST%%.*}" "${PWD}"; }\n' +
        'function _wt_preexec { printf "\\033]0;%s\\007" "$1"; }\n' +
        'if [[ -z "${precmd_functions[(r)_wt_precmd]}" ]]; then precmd_functions+=(_wt_precmd); fi\n' +
        'if [[ -z "${preexec_functions[(r)_wt_preexec]}" ]]; then preexec_functions+=(_wt_preexec); fi\n');
      env.ZDOTDIR = zdotdir;
    } catch {
      // Fallback: rely on user's zsh config for title
    }
  }
  // fish already sets terminal title by default via fish_title function

  return env;
}

function buildAugmentedPath(): string {
  const pathEnv = process.env.PATH || '';
  const extraPaths = ['/usr/local/bin', '/usr/bin', '/bin'];
  const uniquePaths = new Set([...extraPaths, ...pathEnv.split(':').filter(Boolean)]);
  return Array.from(uniquePaths).join(':');
}

let ptyProviderPromise: Promise<PtyProvider> | null = null;

async function getPtyProvider(): Promise<PtyProvider> {
  if (ptyProviderPromise) {
    return ptyProviderPromise;
  }

  ptyProviderPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bunRuntime = (globalThis as any).Bun;

    if (bunRuntime) {
      try {
        const bunPty = await import('bun-pty');
        console.log('Using bun-pty for terminal sessions');
        return { spawn: bunPty.spawn, backend: 'bun-pty' } as PtyProvider;
      } catch (error) {
        console.warn('bun-pty unavailable, falling back to node-pty');
      }
    }

    try {
      const nodePty = await import('node-pty');
      console.log('Using node-pty for terminal sessions');
      return { spawn: nodePty.spawn, backend: 'node-pty' } as PtyProvider;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Failed to load node-pty:', errorMessage);
      if (bunRuntime) {
        throw new Error('No PTY backend available. Install bun-pty or node-pty.');
      }
      throw new Error('node-pty is not available. Run: npm rebuild node-pty (or install Bun for bun-pty)');
    }
  })();

  return ptyProviderPromise;
}

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of terminalSessions.entries()) {
    const idleTooLong = now - session.lastActivity > TERMINAL_IDLE_TIMEOUT;
    const orphaned = sessionIsOrphaned(sessionId);
    const graceWindow = session.keepAliveMs;
    const graceExpired = orphaned
      && session.lastDetachedAt !== null
      && graceWindow !== null
      && now - session.lastDetachedAt > graceWindow;

    if (idleTooLong || (!session.shouldPersist && orphaned) || graceExpired) {
      console.log(`Cleaning up terminal session: ${sessionId}, idleTooLong=${idleTooLong}, orphaned=${orphaned}, graceExpired=${graceExpired}`);
      cleanupSession(sessionId, { killProcess: true });
    }
  }
}, CLEANUP_INTERVAL);

router.get('/processes', (_req, res) => {
  const processes = Array.from(terminalSessions.entries()).map(([sessionId, session]) => ({
    sessionId,
    cwd: session.cwd,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    backend: session.ptyBackend,
    clients: getTotalClients(sessionId),
    mode: session.mode,
    tmuxSessionName: session.tmuxSessionName,
    shouldPersist: session.shouldPersist,
    keepAliveMs: session.keepAliveMs,
    isOrphan: sessionIsOrphaned(sessionId),
    hasWrittenData: session.hasWrittenData,
    activeProgram: session.activeProgram?.command ?? null,
    activeProgramSource: session.activeProgram?.source ?? null,
  }));

  res.json({
    reconnect: {
      graceTime: DEFAULT_KEEP_ALIVE_MS,
      scrollback: RECONNECT_SCROLLBACK,
      idleTimeout: TERMINAL_IDLE_TIMEOUT,
    },
    processes,
  });
});

router.get('/tmux/sessions', async (_req, res) => {
  try {
    const raw = await runTmux([
      'list-sessions',
      '-F',
      `#{session_name}${TMUX_DELIMITER}#{session_windows}${TMUX_DELIMITER}#{session_attached}`,
    ]);

    const sessions = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseDelimitedRow(line, 3))
      .filter((row): row is string[] => row !== null)
      .map(([name, windowsRaw, attachedRaw]) => ({
        name,
        windows: Number.parseInt(windowsRaw || '0', 10) || 0,
        attached: Number.parseInt(attachedRaw || '0', 10) || 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ sessions });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (/no server running/i.test(errorMessage)) {
      return res.json({ sessions: [] });
    }
    if (isTmuxUnavailableMessage(errorMessage)) {
      return res.json({ sessions: [], available: false, reason: 'tmux is not installed or not available in PATH.' });
    }
    return res.status(500).json({ error: errorMessage || 'Failed to list tmux sessions' });
  }
});

router.get('/tmux/status', async (_req, res) => {
  const status = await getTmuxStatus();
  res.json(status);
});

router.post('/serialize-state', async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? new Set((req.body.ids as unknown[]).filter((item): item is string => typeof item === 'string'))
    : null;

  const states = await Promise.all(
    Array.from(terminalSessions.entries())
      .filter(([sessionId, session]) => (ids ? ids.has(sessionId) : true) && session.shouldPersist)
      .map(async ([sessionId, session]) => ({
        sessionId,
        cwd: session.cwd,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        backend: session.ptyBackend,
        mode: session.mode,
        tmuxSessionName: session.tmuxSessionName,
        keepAliveMs: session.keepAliveMs,
        history: await getRestoreHistory(sessionId, session),
      }))
  );

  res.json({
    serialized: JSON.stringify({ version: 1, states }),
    states,
  });
});

router.get('/client-state', (req, res) => {
  const clientId = req.clientId;
  if (!clientId) {
    return res.status(500).json({ error: 'Client identity is not available' });
  }

  const state = clientTerminalStates.get(clientId) ?? {
    sessions: [],
    updatedAt: Date.now(),
  };

  res.json(state);
});

router.put('/client-state', (req, res) => {
  const clientId = req.clientId;
  if (!clientId) {
    return res.status(500).json({ error: 'Client identity is not available' });
  }

  const state = normalizeClientTerminalState(req.body);
  clientTerminalStates.set(clientId, state);
  schedulePersistClientStates();
  res.json(state);
});

router.delete('/client-state', (req, res) => {
  const clientId = req.clientId;
  if (!clientId) {
    return res.status(500).json({ error: 'Client identity is not available' });
  }

  clientTerminalStates.delete(clientId);
  schedulePersistClientStates();
  res.status(204).send();
});

router.post('/create', async (req, res) => {
  try {
    const { cwd: inputCwd, cols, rows, mode, tmuxSessionName, shouldPersist, keepAliveMs } = req.body;
    const normalizedMode = normalizeMode(mode);
    const normalizedTmuxName = normalizedMode === 'tmux' ? normalizeTmuxSessionName(tmuxSessionName) : null;

    // Deduplicate: if a TerminalSession for this tmux session already exists,
    // return it instead of creating a duplicate wrapper.  tmux's own
    // new-session -A already prevents duplicate tmux sessions.
    if (normalizedMode === 'tmux' && normalizedTmuxName) {
      for (const [id, s] of terminalSessions.entries()) {
        if (s.mode === 'tmux' && s.tmuxSessionName === normalizedTmuxName) {
          console.log(`Reusing existing terminal session ${id} for tmux:${normalizedTmuxName}`);
          return res.json({
            sessionId: id,
            mode: s.mode,
            tmuxSessionName: s.tmuxSessionName,
            shouldPersist: s.shouldPersist,
            keepAliveMs: s.keepAliveMs,
            activeProgram: s.activeProgram?.command ?? null,
            activeProgramSource: s.activeProgram?.source ?? null,
          });
        }
      }
    }

    const spawned = await spawnTerminalSession(req, {
      cwd: inputCwd,
      cols,
      rows,
      mode,
      tmuxSessionName,
      shouldPersist,
      keepAliveMs,
    });

    console.log(`Created terminal session: ${spawned.sessionId} in ${spawned.session.cwd}, shouldPersist=${spawned.session.shouldPersist}, keepAliveMs=${spawned.session.keepAliveMs ?? 'never'}`);
    res.json({
      sessionId: spawned.sessionId,
      cols: cols || 80,
      rows: rows || 24,
      mode: spawned.session.mode,
      tmuxSessionName: spawned.session.tmuxSessionName,
      shouldPersist: spawned.session.shouldPersist,
      keepAliveMs: spawned.session.keepAliveMs,
      activeProgram: spawned.session.activeProgram?.command ?? null,
      activeProgramSource: spawned.session.activeProgram?.source ?? null,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to create terminal session:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to create terminal session' });
  }
});

router.get('/:sessionId/stream', async (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  // 连接时立即检测一次 activeProgram，避免前端首次显示闪烁
  try {
    if (session.mode === 'shell') {
      const ap = await detectShellActiveProgram(session);
      if (ap) session.activeProgram = ap;
    } else if (session.mode === 'tmux' && session.tmuxSessionName) {
      const layout = await getTmuxLayout(session.tmuxSessionName);
      const ap = getActiveProgramFromTmuxLayout(layout);
      if (ap) session.activeProgram = ap;
    }
  } catch { /* ignore */ }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const clientId = Math.random().toString(36).substring(7);
  session.clients.set(clientId, res);
  session.lastActivity = Date.now();
  session.lastDetachedAt = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runtime = (globalThis as any).Bun ? 'bun' : 'node';
  const ptyBackend = session.ptyBackend || 'unknown';
  writeSse(res, {
    type: 'connected',
    runtime,
    ptyBackend,
    mode: session.mode,
    tmuxSessionName: session.tmuxSessionName,
    cwd: session.cwd ?? null,
    activeProgram: session.activeProgram?.command ?? null,
    activeProgramSource: session.activeProgram?.source ?? null,
  });

  let tmuxInterval: ReturnType<typeof setInterval> | null = null;
  let activeProgramInterval: ReturnType<typeof setInterval> | null = null;
  let lastTmuxLayoutSnapshot = '';
  let lastActiveProgramSnapshot = JSON.stringify(session.activeProgram ?? null);

  const maybeWriteActiveProgram = (activeProgram: TerminalSession['activeProgram']) => {
    const snapshot = JSON.stringify(activeProgram ?? null);
    if (snapshot === lastActiveProgramSnapshot) {
      return;
    }

    lastActiveProgramSnapshot = snapshot;
    session.activeProgram = activeProgram;
    writeSse(res, {
      type: 'active-program',
      activeProgram: activeProgram?.command ?? null,
      activeProgramSource: activeProgram?.source ?? null,
    });
  };

  const sendTmuxLayout = async () => {
    if (session.mode !== 'tmux' || !session.tmuxSessionName) {
      return;
    }

    try {
      const layout = await getTmuxLayout(session.tmuxSessionName);
      maybeWriteActiveProgram(getActiveProgramFromTmuxLayout(layout));
      const snapshot = JSON.stringify(layout);
      if (snapshot === lastTmuxLayoutSnapshot) {
        return;
      }
      lastTmuxLayoutSnapshot = snapshot;
      writeSse(res, { type: 'tmux-layout', layout });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to fetch tmux layout for ${session.tmuxSessionName}: ${errorMessage}`);
    }
  };

  const sendShellActiveProgram = async () => {
    if (session.mode !== 'shell') {
      return;
    }

    try {
      maybeWriteActiveProgram(await detectShellActiveProgram(session));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to detect active shell program for ${sessionId}: ${errorMessage}`);
    }
  };

  if (session.mode === 'tmux' && session.tmuxSessionName) {
    void sendTmuxLayout();
    tmuxInterval = setInterval(() => {
      void sendTmuxLayout();
    }, TMUX_POLL_INTERVAL);
  } else {
    void sendShellActiveProgram();
    activeProgramInterval = setInterval(() => {
      void sendShellActiveProgram();
    }, ACTIVE_PROGRAM_POLL_INTERVAL);
  }

  const heartbeatInterval = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (error) {
      console.error(`Heartbeat failed for client ${clientId}:`, error);
      clearInterval(heartbeatInterval);
    }
  }, 15000);

  if (req.query.replay === '1') {
    if (session.mode === 'shell') {
      const replayChunks = getReconnectionHistory(sessionId);
      for (const chunk of replayChunks) {
        writeSse(res, { type: 'data', data: chunk, replay: true });
      }
    }
  }

  const cleanup = () => {
    clearInterval(heartbeatInterval);
    if (tmuxInterval) {
      clearInterval(tmuxInterval);
    }
    if (activeProgramInterval) {
      clearInterval(activeProgramInterval);
    }
    closeClient(session, sessionId, clientId);
    console.log(`Client ${clientId} disconnected from terminal session ${sessionId}`);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);

  console.log(`Terminal connected: session=${sessionId} client=${clientId} runtime=${runtime} pty=${ptyBackend}`);
});

router.get('/:sessionId/health', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);
  
  if (!session) {
    console.log(`Health check: session ${sessionId} not found`);
    return res.status(404).json({ healthy: false, error: 'Session not found' });
  }
  
  console.log(`Health check: session ${sessionId} healthy, cwd=${session.cwd}, clients=${getTotalClients(sessionId)}, lastActivity=${Date.now() - session.lastActivity}ms ago`);
   res.json({ 
     healthy: true, 
     sessionId,
      cwd: session.cwd,
      clients: getTotalClients(sessionId),
      lastActivity: session.lastActivity,
      backend: session.ptyBackend,
      mode: session.mode,
      tmuxSessionName: session.tmuxSessionName,
      activeProgram: session.activeProgram?.command ?? null,
      activeProgramSource: session.activeProgram?.source ?? null,
    });
 });

router.get('/:sessionId/attach', async (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.lastDetachedAt = null;
  session.lastActivity = Date.now();

  const history = await getRestoreHistory(sessionId, session);

  res.json({
    sessionId,
    cwd: session.cwd,
    backend: session.ptyBackend,
    clients: getTotalClients(sessionId),
    mode: session.mode,
    tmuxSessionName: session.tmuxSessionName,
    history,
    shouldPersist: session.shouldPersist,
    keepAliveMs: session.keepAliveMs,
    activeProgram: session.activeProgram?.command ?? null,
    activeProgramSource: session.activeProgram?.source ?? null,
  });
});

router.patch('/:sessionId/policy', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'shouldPersist')) {
    session.shouldPersist = req.body.shouldPersist !== false;
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'keepAliveMs')) {
    session.keepAliveMs = normalizeKeepAliveMs(req.body.keepAliveMs);
  }

  if (sessionIsOrphaned(sessionId)) {
    session.lastDetachedAt = Date.now();
  }

  return res.json({
    sessionId,
    shouldPersist: session.shouldPersist,
    keepAliveMs: session.keepAliveMs,
    clients: getTotalClients(sessionId),
  });
});

router.post('/:sessionId/detach', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (sessionIsOrphaned(sessionId)) {
    session.lastDetachedAt = Date.now();
  }

  res.json({
    sessionId,
    detachedAt: session.lastDetachedAt,
    clients: getTotalClients(sessionId),
    shouldPersist: session.shouldPersist,
  });
});

router.post('/:sessionId/input', express.text({ type: '*/*' }), (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  const data = typeof req.body === 'string' ? req.body : '';

  try {
    session.ptyProcess.write(data);
    session.lastActivity = Date.now();
    res.json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to write to terminal:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to write to terminal' });
  }
});

router.post('/:sessionId/resize', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  const { cols, rows } = req.body;
  if (!cols || !rows) {
    return res.status(400).json({ error: 'cols and rows are required' });
  }

  try {
    session.ptyProcess.resize(cols, rows);
    session.lastActivity = Date.now();
    res.json({ success: true, cols, rows });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to resize terminal:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to resize terminal' });
  }
});

router.post('/:sessionId/tmux', async (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  if (session.mode !== 'tmux' || !session.tmuxSessionName) {
    return res.status(400).json({ error: 'Terminal session is not in tmux mode' });
  }

  const { action } = req.body ?? {};

  try {
    const tmuxTarget = session.tmuxSessionName;

    // switch-session needs special handling (tty resolution)
    if (action === 'switch-session') {
      const targetSessionName = typeof req.body?.tmuxSessionName === 'string'
        ? req.body.tmuxSessionName.trim()
        : '';

      if (!targetSessionName) {
        return res.status(400).json({ error: 'tmuxSessionName is required' });
      }

      const preferredClientPid = getPtyProcessPid(session.ptyProcess);
      const clientTty = await resolveTmuxClientTty(tmuxTarget, preferredClientPid);

      if (!clientTty) {
        return res.status(500).json({ error: 'No tmux client available for current session' });
      }

      await ensureTmuxSessionExists(targetSessionName);
      await sendTmuxCommand(tmuxTarget, session.tmuxControl, ['switch-client', '-c', clientTty, '-t', targetSessionName]);
      session.tmuxSessionName = targetSessionName;
      session.lastActivity = Date.now();

      const layout = await getTmuxLayout(targetSessionName);
      broadcastEvent(sessionId, { type: 'tmux-layout', layout });
      return res.json({ success: true, layout });
    }

    // All other actions: delegate to shared executeTmuxAction
    const result = await executeTmuxAction(
      tmuxTarget,
      action,
      req.body as Record<string, unknown>,
      session.tmuxControl,
    );

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    session.lastActivity = Date.now();

    if (result.shouldBroadcastLayout) {
      const layout = await getTmuxLayout(tmuxTarget);
      broadcastEvent(sessionId, { type: 'tmux-layout', layout });
      return res.json({ success: true, layout });
    }

    return res.json({ success: true });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error(`Failed to execute tmux action ${action}:`, errorMessage);
    return res.status(500).json({ error: errorMessage || 'Failed to execute tmux action' });
  }
});

router.delete('/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  try {
    cleanupSession(sessionId, { killProcess: true });
    console.log(`Closed terminal session: ${sessionId}`);
    res.json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to close terminal:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to close terminal' });
  }
});

router.post('/:sessionId/restart', async (req, res) => {
  const { sessionId } = req.params;
  const { cwd: inputCwd, cols, rows, mode, tmuxSessionName, shouldPersist, keepAliveMs } = req.body;

  const existingSession = terminalSessions.get(sessionId);
  if (existingSession) {
    cleanupSession(sessionId, { killProcess: true });
  }

  try {
    const { sessionId: newSessionId, session } = await spawnTerminalSession(req, {
      cwd: inputCwd,
      cols,
      rows,
      mode,
      tmuxSessionName,
      shouldPersist,
      keepAliveMs,
    });

    console.log(`Restarted terminal session: ${sessionId} -> ${newSessionId} in ${session.cwd}`);
    res.json({
      sessionId: newSessionId,
      cols: cols || 80,
      rows: rows || 24,
      mode: session.mode,
      tmuxSessionName: session.tmuxSessionName,
      shouldPersist: session.shouldPersist,
      keepAliveMs: session.keepAliveMs,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to restart terminal session:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to restart terminal session' });
  }
});

router.post('/force-kill', (req, res) => {
  const { sessionId, cwd } = req.body;
  let killedCount = 0;

  if (sessionId) {
    const session = terminalSessions.get(sessionId);
    if (session) {
      cleanupSession(sessionId, { killProcess: true });
      killedCount++;
    }
  } else if (cwd) {
    for (const [id, session] of terminalSessions) {
      if (session.cwd === cwd) {
        cleanupSession(id, { killProcess: true });
        killedCount++;
      }
    }
  } else {
    for (const [id] of terminalSessions) {
      cleanupSession(id, { killProcess: true });
      killedCount++;
    }
  }

  console.log(`Force killed ${killedCount} terminal session(s)`);
  res.json({ success: true, killedCount });
});

// ---- WebSocket handler (replaces SSE + HTTP POST for terminal I/O) ----

async function executeTmuxAction(
  tmuxTarget: string,
  action: string,
  body: Record<string, unknown>,
  control?: TmuxControl,
): Promise<{ shouldBroadcastLayout: boolean; error?: string }> {
  let shouldBroadcastLayout = true;

  switch (action) {
    case 'select-pane': {
      const paneId = typeof body.paneId === 'string' ? body.paneId : '';
      if (!paneId) return { shouldBroadcastLayout: false, error: 'paneId is required' };
      await sendTmuxCommand(tmuxTarget, control, ['select-pane', '-t', paneId]);
      break;
    }
    case 'select-window': {
      const windowId = typeof body.windowId === 'string' ? body.windowId : '';
      if (!windowId) return { shouldBroadcastLayout: false, error: 'windowId is required' };
      await sendTmuxCommand(tmuxTarget, control, ['select-window', '-t', windowId]);
      break;
    }
    case 'split-pane': {
      const dir = body.direction === 'h' ? '-h' : '-v';
      await sendTmuxCommand(tmuxTarget, control, ['split-window', '-t', tmuxTarget, dir]);
      break;
    }
    case 'close-pane': {
      const paneId = typeof body.paneId === 'string' ? body.paneId : '';
      if (!paneId) return { shouldBroadcastLayout: false, error: 'paneId is required' };
      await sendTmuxCommand(tmuxTarget, control, ['kill-pane', '-t', paneId]);
      break;
    }
    case 'copy-mode': {
      const enabled = body.enabled !== false;
      if (enabled) {
        try {
          await sendTmuxCommand(tmuxTarget, control, ['copy-mode', '-He', '-t', tmuxTarget]);
        } catch (error) {
          if (!isAlreadyInCopyModeError(getErrorMessage(error))) throw error;
        }
      } else {
        try {
          await sendTmuxCommand(tmuxTarget, control, ['send-keys', '-t', tmuxTarget, '-X', 'cancel']);
        } catch (error) {
          if (!isNotInCopyModeError(getErrorMessage(error))) throw error;
        }
      }
      break;
    }
    case 'scroll': {
      const direction = body.direction === 'down' ? 'down' : 'up';
      const lines = Math.max(1, Math.min(50, Math.floor(Number(body.lines) || 1)));

      let inCopyMode = await isTmuxPaneInMode(tmuxTarget, control);

      // Down-scroll outside copy mode: already at the live prompt, nothing to do.
      if (direction === 'down' && !inCopyMode) {
        shouldBroadcastLayout = false;
        break;
      }

      // Up-scroll outside copy mode: only enter if the pane has scrollback
      // history.  Without history, copy-mode -He would flash-enter then
      // `-e` auto-exit instantly.
      if (!inCopyMode) {
        // Re-check history_size on every entry — the pane may have
        // accumulated scrollback since last check.
        const histRaw = (await sendTmuxCommand(tmuxTarget, control, [
          'display-message', '-t', tmuxTarget, '-p', '#{history_size}',
        ])).trim();
        const historySize = parseInt(histRaw, 10) || 0;
        if (historySize === 0) {
          exitedAtBottom.add(tmuxTarget);
          shouldBroadcastLayout = false;
          break;
        }
        exitedAtBottom.delete(tmuxTarget);

        try {
          await sendTmuxCommand(tmuxTarget, control, ['copy-mode', '-He', '-t', tmuxTarget]);
        } catch (error) {
          if (!isAlreadyInCopyModeError(getErrorMessage(error))) throw error;
        }
        inCopyMode = await isTmuxPaneInMode(tmuxTarget, control);
        if (!inCopyMode) {
          shouldBroadcastLayout = false;
          break;
        }
      }

      // Scroll commands are fire-and-forget — don't wait for %exit.
      const scrollCmd = direction === 'up' ? 'scroll-up' : 'scroll-down';
      const fallbackCmds = direction === 'up'
        ? ['up-line', 'cursor-up']
        : ['down-line', 'cursor-down'];

      let sent = false;
      for (const cmd of [scrollCmd, ...fallbackCmds]) {
        try {
          if (control && !control.dead) {
            sendTmuxCommandFireAndForget(tmuxTarget, control, [
              'send-keys', '-t', tmuxTarget, '-X', '-N', String(lines), cmd,
            ]);
          } else {
            await runTmux(['send-keys', '-t', tmuxTarget, '-X', '-N', String(lines), cmd]);
          }
          sent = true;
          break;
        } catch (error) {
          // Try fallback
        }
      }
      if (!sent) {
        shouldBroadcastLayout = false;
        break;
      }

      if (direction === 'down') {
        const stillInCopyMode = await isTmuxPaneInMode(tmuxTarget, control);
        if (!stillInCopyMode) {
          exitedAtBottom.add(tmuxTarget);
        }
      }

      shouldBroadcastLayout = false;
      break;
    }
    case 'new-window': {
      await sendTmuxCommand(tmuxTarget, control, ['new-window', '-t', tmuxTarget]);
      break;
    }
    case 'switch-session': {
      const targetSessionName = typeof body.tmuxSessionName === 'string'
        ? body.tmuxSessionName.trim()
        : '';
      if (!targetSessionName) {
        return { shouldBroadcastLayout: false, error: 'tmuxSessionName is required' };
      }
      await sendTmuxCommand(tmuxTarget, control, ['switch-client', '-t', targetSessionName]);
      break;
    }
    default:
      return { shouldBroadcastLayout: false, error: `Unknown tmux action: ${action}` };
  }

  return { shouldBroadcastLayout };
}

export function handleTerminalWebSocket(ws: WebSocket, sessionId: string, clientId: string): void {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    ws.close(4001, 'Session not found');
    return;
  }

  // Register client
  let clients = wsClients.get(sessionId);
  if (!clients) {
    clients = new Map();
    wsClients.set(sessionId, clients);
  }
  clients.set(clientId, ws);
  session.lastActivity = Date.now();
  session.lastDetachedAt = null;

  void (async () => {
    // 连接时立即检测一次 activeProgram，避免前端首次显示闪烁
    try {
      if (session.mode === 'shell') {
        const ap = await detectShellActiveProgram(session);
        if (ap) session.activeProgram = ap;
      } else if (session.mode === 'tmux' && session.tmuxSessionName) {
        const layout = await getTmuxLayout(session.tmuxSessionName);
        const ap = getActiveProgramFromTmuxLayout(layout);
        if (ap) session.activeProgram = ap;
      }
    } catch { /* ignore */ }

    // Send connected event (after initial detection)
    const runtime = (globalThis as Record<string, unknown>).Bun ? 'bun' : 'node';
    ws.send(JSON.stringify({
      type: 'connected',
      runtime,
      ptyBackend: session.ptyBackend || 'unknown',
      mode: session.mode,
      tmuxSessionName: session.tmuxSessionName,
      cwd: session.cwd ?? null,
      activeProgram: session.activeProgram?.command ?? null,
      activeProgramSource: session.activeProgram?.source ?? null,
    }));
  })();

  // Tmux layout polling (per-client, like the SSE stream does)
  let tmuxInterval: ReturnType<typeof setInterval> | null = null;
  let activeProgramInterval: ReturnType<typeof setInterval> | null = null;

  if (session.mode === 'tmux' && session.tmuxSessionName) {
    let lastTmuxLayoutSnapshot = '';
    let lastActiveProgramSnapshot = JSON.stringify(session.activeProgram ?? null);

    const sendTmuxLayout = async () => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        const layout = await getTmuxLayout(session.tmuxSessionName!);
        // Update active program
        const ap = getActiveProgramFromTmuxLayout(layout);
        const apSnapshot = JSON.stringify(ap ?? null);
        if (apSnapshot !== lastActiveProgramSnapshot) {
          lastActiveProgramSnapshot = apSnapshot;
          session.activeProgram = ap;
          ws.send(JSON.stringify({
            type: 'active-program',
            activeProgram: ap?.command ?? null,
            activeProgramSource: ap?.source ?? null,
          }));
        }
        const snapshot = JSON.stringify(layout);
        if (snapshot !== lastTmuxLayoutSnapshot) {
          lastTmuxLayoutSnapshot = snapshot;
          ws.send(JSON.stringify({ type: 'tmux-layout', layout }));
        }
      } catch { /* ignore polling errors */ }
    };

    sendTmuxLayout();
    tmuxInterval = setInterval(sendTmuxLayout, TMUX_POLL_INTERVAL);
  }

  // Active program polling (shell mode)
  if (session.mode === 'shell') {
    let lastApSnapshot = JSON.stringify(session.activeProgram ?? null);

    const pollActiveProgram = async () => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        const ap = await detectShellActiveProgram(session);
        const snapshot = JSON.stringify(ap ?? null);
        if (snapshot !== lastApSnapshot) {
          lastApSnapshot = snapshot;
          session.activeProgram = ap;
          ws.send(JSON.stringify({
            type: 'active-program',
            activeProgram: ap?.command ?? null,
            activeProgramSource: ap?.source ?? null,
          }));
        }
      } catch { /* ignore */ }
    };

    activeProgramInterval = setInterval(pollActiveProgram, ACTIVE_PROGRAM_POLL_INTERVAL);
  }

  // Handle client → server messages
  ws.on('message', async (raw) => {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    try {
      switch (msg.type) {
        case 'input': {
          if (typeof msg.data === 'string' && msg.data.length > 0) {
            session.lastActivity = Date.now();
            session.ptyProcess.write(msg.data);
          }
          break;
        }
        case 'resize': {
          const cols = Number(msg.cols);
          const rows = Number(msg.rows);
          if (cols > 0 && rows > 0) {
            session.ptyProcess.resize(cols, rows);
          }
          break;
        }
        case 'tmux': {
          const reqId = msg.reqId as string | undefined;
          if (session.mode !== 'tmux' || !session.tmuxSessionName) {
            ws.send(JSON.stringify({ type: 'tmux-result', reqId, success: false, error: 'Not in tmux mode' }));
            break;
          }
          const result = await executeTmuxAction(
            session.tmuxSessionName,
            msg.action as string,
            msg as unknown as Record<string, unknown>,
            session.tmuxControl,
          );
          ws.send(JSON.stringify({ type: 'tmux-result', reqId, success: !result.error, error: result.error }));
          if (result.shouldBroadcastLayout && session.tmuxSessionName) {
            try {
              const layout = await getTmuxLayout(session.tmuxSessionName);
              broadcastJsonWs(sessionId, { type: 'tmux-layout', layout });
            } catch { /* ignore */ }
          }
          break;
        }
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }
      }
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  });

  // Cleanup on close
  ws.on('close', () => {
    if (tmuxInterval) clearInterval(tmuxInterval);
    if (activeProgramInterval) clearInterval(activeProgramInterval);
    const clients = wsClients.get(sessionId);
    if (clients) {
      clients.delete(clientId);
      if (clients.size === 0) {
        wsClients.delete(sessionId);
        if (sessionIsOrphaned(sessionId)) {
          session.lastDetachedAt = Date.now();
        }
      }
    }
  });

  ws.on('error', () => {
    // close handler will clean up
  });
}

// Refresh global WheelUpPane/WheelDownPane bindings on every server start
// so existing tmux sessions pick up the latest copy-mode flags.
configureTmuxWheelBindings().catch(() => {});

export default router;
