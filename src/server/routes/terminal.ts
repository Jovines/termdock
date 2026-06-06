import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import type { WebSocket } from 'ws';
import { caffeinateManager } from '../utils/caffeinate.js';

const router: express.Router = express.Router();
const execFileAsync = promisify(execFile);

// Termdock metadata constants used to populate tmux user options
// (`@termdock-*`) so external tools (e.g. `termdock --tls`) can identify
// and describe termdock-managed tmux sessions without contacting the server.
const TERMDOCK_VERSION: string = (() => {
  try {
    const require_ = createRequire(import.meta.url);
    // dist/server/routes/terminal.js → ../../../package.json
    const pkg = require_(path.join(__dirname || '', '..', '..', '..', 'package.json'));
    if (typeof pkg?.version === 'string') return pkg.version;
  } catch { /* fall through */ }
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_('../../../package.json');
    if (typeof pkg?.version === 'string') return pkg.version;
  } catch { /* ignore */ }
  return '0.0.0';
})();
const TERMDOCK_HOST = os.hostname();
const TERMDOCK_PID = String(process.pid);

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
  pid: number;
  title: string;
  currentPath: string;
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
  hasWrittenData: boolean;
  activeProgram: {
    command: string | null;
    source: 'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown';
    rawArgs: string | null;
    updatedAt: number;
  } | null;
  dataDisposable?: { dispose: () => void };
  exitDisposable?: { dispose: () => void };
  tmuxControl?: TmuxControl;
  oscSniffBuf: string;
  lastOscCwd: string | null;
  agentStatus: string | null;
  agentColor: string | null;
  agentIndicator: AgentIndicator | null;
  agentStatusBuf: string;      // 去除 ANSI 后的纯文本滚动缓冲区
  agentStatusTimer: ReturnType<typeof setTimeout> | null;
  agentStatusClearDelayMs: number;
}

interface PersistedClientSession {
  sessionId: string;
  name: string;
  customName?: boolean;
  backendSessionId: string | null;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  createdAt: number;
  lastActivity: number;
}

interface GlobalSessionState {
  sessions: PersistedClientSession[];
  updatedAt: number;
}

const terminalSessions = new Map<string, TerminalSession>();
let globalSessionState: GlobalSessionState = { sessions: [], updatedAt: Date.now() };
// ── 持久化 globalSessionState 到磁盘，防止服务重启后丢失 ──
const GLOBAL_SESSION_STATE_FILE = `${os.homedir()}/.termdock/global-session-state.json`;
const CLIENT_STATES_FILE = `${os.homedir()}/.termdock/client-states.json`; // 保留用于迁移
let persistGlobalStateTimer: ReturnType<typeof setTimeout> | null = null;

// ── Control WebSocket: pushes the canonical client-state to every connected
// browser in real time. Each client gets a fresh snapshot on connect, then
// receives deltas on every mutation (PUT/DELETE client-state, dead-session
// reconciliation, etc.). Replaces the 5-second poll on the front-end. ──
const controlClients = new Map<string, WebSocket>();

function broadcastClientState(): void {
  if (controlClients.size === 0) return;
  const payload = JSON.stringify({ type: 'client-state', state: globalSessionState });
  for (const [clientId, ws] of controlClients) {
    if (ws.readyState !== ws.OPEN) {
      controlClients.delete(clientId);
      continue;
    }
    try {
      ws.send(payload);
    } catch {
      controlClients.delete(clientId);
    }
  }
}

function deduplicateGlobalSessions(sessions: PersistedClientSession[]): PersistedClientSession[] {
  const seen = new Map<string, number>();
  let hasDuplicates = false;
  const keep = new Array<boolean>(sessions.length).fill(true);

  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (seen.has(s.sessionId)) {
      keep[i] = false;
      hasDuplicates = true;
      continue;
    }
    seen.set(s.sessionId, i);

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

  if (!hasDuplicates) return sessions;
  return sessions.filter((_, i) => keep[i]);
}

function migrateFromClientStatesFile(): GlobalSessionState | null {
  try {
    if (!fs.existsSync(CLIENT_STATES_FILE)) return null;
    const raw = fs.readFileSync(CLIENT_STATES_FILE, 'utf-8');
    const data = JSON.parse(raw) as Record<string, { sessions: unknown[] }>;
    const allSessions: PersistedClientSession[] = [];
    for (const state of Object.values(data)) {
      for (const s of (state.sessions || [])) {
        const normalized = normalizePersistedClientSession(s);
        if (normalized) allSessions.push(normalized);
      }
    }
    return {
      sessions: deduplicateGlobalSessions(allSessions),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function loadGlobalSessionStateFromDisk(): void {
  try {
    if (fs.existsSync(GLOBAL_SESSION_STATE_FILE)) {
      const raw = fs.readFileSync(GLOBAL_SESSION_STATE_FILE, 'utf-8');
      const data = JSON.parse(raw) as GlobalSessionState;
      globalSessionState = {
        sessions: deduplicateGlobalSessions(
          (data.sessions || []).map(s => normalizePersistedClientSession(s)).filter((s): s is PersistedClientSession => s !== null)
        ),
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
      };
      console.log(`[session-persist] Loaded ${globalSessionState.sessions.length} sessions from global state`);
      return;
    }
    const migrated = migrateFromClientStatesFile();
    if (migrated) {
      globalSessionState = migrated;
      schedulePersistGlobalState();
      console.log(`[session-persist] Migrated ${globalSessionState.sessions.length} sessions from legacy client-states`);
      return;
    }
  } catch (error) {
    console.warn('[session-persist] Failed to load global state:', getErrorMessage(error));
  }
}

function schedulePersistGlobalState(): void {
  if (persistGlobalStateTimer) clearTimeout(persistGlobalStateTimer);
  persistGlobalStateTimer = setTimeout(() => {
    try {
      const dir = `${os.homedir()}/.termdock`;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(GLOBAL_SESSION_STATE_FILE, JSON.stringify(globalSessionState, null, 2), 'utf-8');
    } catch (error) {
      console.warn('[session-persist] Failed to persist global state:', getErrorMessage(error));
    }
  }, 200);
}

// 进程退出前立即刷盘，避免 tsx watch 重启导致状态丢失
function flushPersistAndExit(): void {
  if (persistGlobalStateTimer) {
    clearTimeout(persistGlobalStateTimer);
    persistGlobalStateTimer = null;
  }
  try {
    const dir = `${os.homedir()}/.termdock`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GLOBAL_SESSION_STATE_FILE, JSON.stringify(globalSessionState, null, 2), 'utf-8');
  } catch { /* best effort */ }
}
process.on('SIGTERM', () => { flushPersistAndExit(); persistToolbarPresetsNow(); caffeinateManager.shutdown(); process.exit(0); });
process.on('SIGINT', () => { flushPersistAndExit(); persistToolbarPresetsNow(); caffeinateManager.shutdown(); process.exit(0); });

// 服务启动时从磁盘加载（带去重，防止历史累积的重复条目复活）
loadGlobalSessionStateFromDisk();
caffeinateManager.startNetworkMonitor();

// 清理磁盘恢复后后端已不存在的 session 引用。
// 服务重启时 terminalSessions 是空的，持久化的 global state
// 全部指向已销毁的 session。shell session 的 PTY 已死无法复用，直接删除；
// tmux session 的 tmux 进程独立于 termdock，保留条目但清空 backendSessionId。
(function pruneOrphanSessions(): void {
  let changed = false;
  const cleaned = globalSessionState.sessions.filter((s) => {
    // Shell sessions with no live backend: PTY is dead, can't be reattached — remove entirely
    if (s.mode !== 'tmux') {
      if (s.backendSessionId != null && !terminalSessions.has(s.backendSessionId)) {
        changed = true;
        return false;
      }
      // backendSessionId already null but no live backend either — also dead
      if (s.backendSessionId == null) {
        changed = true;
        return false;
      }
      return true;
    }
    // Tmux sessions: tmux process may still be alive, keep but clear backend ref
    if (s.backendSessionId != null && !terminalSessions.has(s.backendSessionId)) {
      changed = true;
    }
    return true;
  }).map((s) => {
    if (s.mode === 'tmux' && s.backendSessionId != null && !terminalSessions.has(s.backendSessionId)) {
      return { ...s, backendSessionId: null };
    }
    return s;
  });

  if (!changed) return;
  globalSessionState = {
    sessions: cleaned,
    updatedAt: Date.now(),
  };
  schedulePersistGlobalState();
  broadcastClientState();
})();

// On boot, backfill termdock metadata onto every tmux session referenced by
// the persisted client states. Lets `termdock --tls` work the first time
// after upgrading from a version that didn't write `@termdock-*`.
// Dynamic fields (label/program/cwd/last-active-at) are intentionally left
// for the per-session polling to fill in lazily.
void (async () => {
  const seen = new Set<string>();
  for (const s of globalSessionState.sessions) {
    if (s.mode !== 'tmux' || !s.tmuxSessionName) continue;
    if (seen.has(s.tmuxSessionName)) continue;
    seen.add(s.tmuxSessionName);
    try {
      if (!(await tmuxSessionExists(s.tmuxSessionName))) continue;

      const baseOptions: Record<string, string> = {
        '@termdock-version': TERMDOCK_VERSION,
        '@termdock-host': TERMDOCK_HOST,
        '@termdock-pid': TERMDOCK_PID,
      };
      const existingCreatedAt = await getTmuxOption(s.tmuxSessionName, '@termdock-created-at');
      if (!existingCreatedAt) {
        baseOptions['@termdock-created-at'] = String(Date.now());
      }
      await setTmuxOptions(s.tmuxSessionName, baseOptions);

      if (s.customName === true && typeof s.name === 'string' && s.name.trim().length > 0) {
        await setTmuxOption(s.tmuxSessionName, '@termdock-friendly-name', s.name);
      }
    } catch (error) {
      console.warn(
        `[tmux] failed to backfill metadata on ${s.tmuxSessionName}: ${getErrorMessage(error)}`,
      );
    }
  }
})();

// ── end persistence ──

// ── Toolbar presets persistence (shared across all clients) ──
// Stored as a single JSON document at ~/.termdock/toolbar-presets.json.
// The schema is intentionally opaque to the server: it just round-trips
// `presets` (array) and `version` (number) so the client owns all merge /
// upgrade logic. The whole document is global (not keyed by clientId) so
// every browser pointing at this server sees the same toolbar config.
const TOOLBAR_PRESETS_FILE = `${os.homedir()}/.termdock/toolbar-presets.json`;
interface ToolbarPresetsDoc {
  version: number;
  presets: unknown[];
  updatedAt: number;
}
let toolbarPresetsDoc: ToolbarPresetsDoc | null = null;
let persistToolbarPresetsTimer: ReturnType<typeof setTimeout> | null = null;

function loadToolbarPresetsFromDisk(): void {
  try {
    if (fs.existsSync(TOOLBAR_PRESETS_FILE)) {
      const raw = fs.readFileSync(TOOLBAR_PRESETS_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ToolbarPresetsDoc>;
      toolbarPresetsDoc = {
        version: typeof parsed.version === 'number' ? parsed.version : 0,
        presets: Array.isArray(parsed.presets) ? parsed.presets : [],
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      };
    }
  } catch (error) {
    console.warn('[toolbar-presets] Failed to load from disk:', getErrorMessage(error));
  }
}

function persistToolbarPresetsNow(): void {
  if (!toolbarPresetsDoc) return;
  try {
    const dir = `${os.homedir()}/.termdock`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOOLBAR_PRESETS_FILE, JSON.stringify(toolbarPresetsDoc, null, 2), 'utf-8');
  } catch (error) {
    console.warn('[toolbar-presets] Failed to persist:', getErrorMessage(error));
  }
}

function schedulePersistToolbarPresets(): void {
  if (persistToolbarPresetsTimer) clearTimeout(persistToolbarPresetsTimer);
  persistToolbarPresetsTimer = setTimeout(persistToolbarPresetsNow, 200);
}

loadToolbarPresetsFromDisk();
// ── end toolbar presets persistence ──

// 开发模式下使用更激进的清理策略
const isDevelopment = process.env.NODE_ENV === 'development';
// idle 超时：手机锁屏后客户端 JS 被 OS 暂停 → 无法发心跳维持活动。
// DEV 原本是 5 分钟，太短，手机后台一会儿就被清掉触发 auto-recreate；
// 调到 30 分钟覆盖大多数日常使用。生产 6 小时保持不变。
const TERMINAL_IDLE_TIMEOUT = parseInt(process.env.TERMINAL_IDLE_TIMEOUT || (isDevelopment ? '1800000' : '21600000'), 10);
const CLEANUP_INTERVAL = isDevelopment ? 60 * 1000 : 5 * 60 * 1000;
const RECONNECT_SCROLLBACK = parseInt(process.env.TERMINAL_RECONNECT_SCROLLBACK || '200', 10);
const TMUX_POLL_INTERVAL = parseInt(process.env.TMUX_POLL_INTERVAL || '500', 10);
const ACTIVE_PROGRAM_POLL_INTERVAL = parseInt(process.env.TERMINAL_ACTIVE_PROGRAM_POLL_INTERVAL || '1200', 10);
const TMUX_DELIMITER = '\x1f';
// 输出历史缓冲区（限制大小）
const MAX_HISTORY_SIZE = 100 * 1024; // 100KB per session
// 给每个 chunk 加单调递增 seq，用于短线重连时按需补发增量。
interface HistoryChunk { seq: number; data: string }
const sessionHistory = new Map<string, { chunks: HistoryChunk[]; size: number; nextSeq: number }>();

function addToHistory(sessionId: string, data: string): number {
  let history = sessionHistory.get(sessionId);
  if (!history) {
    history = { chunks: [], size: 0, nextSeq: 1 };
    sessionHistory.set(sessionId, history);
  }
  const seq = history.nextSeq++;
  history.chunks.push({ seq, data });
  history.size += data.length;

  // 超出限制时移除最旧的 chunk
  while (history.size > MAX_HISTORY_SIZE && history.chunks.length > 0) {
    const removed = history.chunks.shift();
    if (removed) {
      history.size -= removed.data.length;
    }
  }
  return seq;
}

function getHistory(sessionId: string): string[] {
  const history = sessionHistory.get(sessionId);
  return history ? history.chunks.map((c) => c.data) : [];
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

// 取当前 history 的最大 seq；用于客户端首次 attach 后记录基线。
function getHistoryLastSeq(sessionId: string): number {
  const history = sessionHistory.get(sessionId);
  return history ? history.nextSeq - 1 : 0;
}

// 短线重连：返回 sinceSeq 之后的所有 chunks（含 seq）。
// 若 sinceSeq 落在已淘汰窗口之外，则需要发"超出窗口"标志，让前端走全量恢复。
function getHistorySince(sessionId: string, sinceSeq: number): {
  chunks: HistoryChunk[];
  lastSeq: number;
  outOfWindow: boolean;
} {
  const history = sessionHistory.get(sessionId);
  if (!history) {
    return { chunks: [], lastSeq: 0, outOfWindow: false };
  }
  const lastSeq = history.nextSeq - 1;
  if (sinceSeq <= 0) {
    // 客户端没有基线，按 RECONNECT_SCROLLBACK 截断。
    const chunks = RECONNECT_SCROLLBACK > 0 && history.chunks.length > RECONNECT_SCROLLBACK
      ? history.chunks.slice(-RECONNECT_SCROLLBACK)
      : history.chunks.slice();
    return { chunks, lastSeq, outOfWindow: false };
  }
  if (sinceSeq >= lastSeq) {
    return { chunks: [], lastSeq, outOfWindow: false };
  }
  const oldestSeq = history.chunks.length > 0 ? history.chunks[0].seq : history.nextSeq;
  if (sinceSeq < oldestSeq - 1) {
    // 客户端基线已被淘汰，需要全量重放可见窗口。
    const chunks = RECONNECT_SCROLLBACK > 0 && history.chunks.length > RECONNECT_SCROLLBACK
      ? history.chunks.slice(-RECONNECT_SCROLLBACK)
      : history.chunks.slice();
    return { chunks, lastSeq, outOfWindow: true };
  }
  // 正常增量：返回 seq > sinceSeq 的部分。
  // 由于 chunks 按 seq 递增，可以二分；这里数据量有限直接 filter。
  const chunks = history.chunks.filter((c) => c.seq > sinceSeq);
  return { chunks, lastSeq, outOfWindow: false };
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
    customName: candidate.customName === true ? true : undefined,
    backendSessionId: typeof candidate.backendSessionId === 'string' && candidate.backendSessionId.trim().length > 0
      ? candidate.backendSessionId
      : null,
    mode: normalizeMode(candidate.mode),
    tmuxSessionName: typeof candidate.tmuxSessionName === 'string' && candidate.tmuxSessionName.trim().length > 0
      ? candidate.tmuxSessionName
      : null,
    createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
      ? Math.floor(candidate.createdAt)
      : Date.now(),
    lastActivity: typeof candidate.lastActivity === 'number' && Number.isFinite(candidate.lastActivity)
      ? Math.floor(candidate.lastActivity)
      : Date.now(),
  };
}

function normalizeGlobalSessionState(input: unknown): GlobalSessionState {
  if (!input || typeof input !== 'object') {
    return { sessions: [], updatedAt: Date.now() };
  }

  const candidate = input as Partial<GlobalSessionState> & { sessions?: unknown[] };
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions
      .map((session) => normalizePersistedClientSession(session))
      .filter((session): session is PersistedClientSession => session !== null)
    : [];

  return {
    sessions,
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

// ── tmux user-option helpers (`@termdock-*`) ──
//
// We use tmux user options to attach termdock metadata (program/cwd/label/
// friendly-name/client-count/etc.) to each managed session. They live with the
// session, propagate across attaches, and never affect session-name addressing.
// Failures are non-fatal — we only warn once per call site so a transient tmux
// hiccup never blocks layout broadcast or session creation.

async function setTmuxOption(sessionName: string, key: string, value: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await runTmux(['set-option', '-t', sessionName, key, value]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  console.warn(
    `[tmux] failed to set option ${key} on ${sessionName}: ${getErrorMessage(lastError)}`,
  );
}

async function setTmuxOptions(
  sessionName: string,
  options: Record<string, string>,
): Promise<void> {
  await Promise.all(
    Object.entries(options).map(([key, value]) => setTmuxOption(sessionName, key, value)),
  );
}

async function unsetTmuxOption(sessionName: string, key: string): Promise<void> {
  try {
    await runTmux(['set-option', '-t', sessionName, '-u', key]);
  } catch (error) {
    console.warn(
      `[tmux] failed to unset option ${key} on ${sessionName}: ${getErrorMessage(error)}`,
    );
  }
}

async function getTmuxOption(sessionName: string, key: string): Promise<string | null> {
  try {
    const value = (await runTmux(['show-option', '-vqt', sessionName, key])).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await runTmux(['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

// ── end tmux user-option helpers ──

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

// ── Agent status detection for AI coding tools ──

const AGENT_BUF_CAP = 4096;  // 滚动缓冲区容量

// ── Agent detection rules (user-configurable) ──

interface AgentRule {
  pattern: string;   // regex pattern string
  status: string;    // status label, e.g. "running"
  color?: string;    // CSS color for the tab dot, e.g. "#4ade80" or "green"
  indicator?: AgentIndicator;
  clearDelayMs?: number;
}

type AgentIndicator = 'spinner' | 'pulse' | 'dot' | 'ring' | 'badge' | 'terminal' | 'question';

const AGENT_INDICATORS = new Set<AgentIndicator>(['spinner', 'pulse', 'dot', 'ring', 'badge', 'terminal', 'question']);
const DEFAULT_AGENT_CLEAR_DELAY_MS = 450;
const MIN_AGENT_CLEAR_DELAY_MS = 80;
const MAX_AGENT_CLEAR_DELAY_MS = 10_000;

interface AgentProgramConfig {
  // 兼容旧格式：单程序字段
  program?: string;
  // 新格式：一组程序名
  programs?: string[];
  rules: AgentRule[];
}

// Built-in default rules
const BUILTIN_AGENT_RULES: AgentProgramConfig[] = [
  {
    program: 'claude',
    rules: [
      // 雪花符号(spinner) + 1-25 个中英文字母 + 3 个点(英文 ... 或中文 …)
      // 严格按"结构"匹配,不依赖具体词,排除 token 数字/输入回显
      { pattern: '[✢✶✻✽][A-Za-z\\u4E00-\\u9FA5]{1,25}(?:\\.{3}|…)', status: 'running', color: '#4ade80', indicator: 'spinner', clearDelayMs: 700 },
    ],
  },
  {
    program: 'opencode',
    rules: [
      { pattern: 'thinking|working|generating', status: 'running', color: '#4ade80', indicator: 'pulse', clearDelayMs: 900 },
      { pattern: 'confirm|approve|permission|continue\\?', status: 'waiting', color: '#facc15', indicator: 'question', clearDelayMs: 10000 },
    ],
  },
  {
    program: 'coco',
    rules: [
      { pattern: 'Tab/Arrow keys to navigate|Esc to|select ·|Coco 等待态采样|AskUserQuestion|User\'s answers', status: 'waiting', color: '#facc15', indicator: 'question', clearDelayMs: 10000 },
      { pattern: '[·✢❋❇✽] (thinking|working|generating)', status: 'running', color: '#4ade80', indicator: 'spinner', clearDelayMs: 700 },
      { pattern: 'confirm|approve|permission|continue\\?', status: 'waiting', color: '#facc15', indicator: 'question', clearDelayMs: 10000 },
    ],
  },
  {
    program: 'aider',
    rules: [
      { pattern: 'Thinking|Generating|Working', status: 'running', color: '#4ade80', indicator: 'pulse', clearDelayMs: 900 },
    ],
  },
];

// Runtime cache: program → compiled rules
let agentRulesCache: Map<string, { status: string; color: string | undefined; indicator: AgentIndicator; clearDelayMs: number; regex: RegExp }[]> = new Map();
let agentRulesVersion = 0;

function normalizeAgentIndicator(value: unknown): AgentIndicator {
  return typeof value === 'string' && AGENT_INDICATORS.has(value as AgentIndicator)
    ? value as AgentIndicator
    : 'pulse';
}

function normalizeAgentClearDelay(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_AGENT_CLEAR_DELAY_MS;
  return Math.min(MAX_AGENT_CLEAR_DELAY_MS, Math.max(MIN_AGENT_CLEAR_DELAY_MS, n));
}

function loadAgentRules(): Map<string, { status: string; color: string | undefined; indicator: AgentIndicator; clearDelayMs: number; regex: RegExp }[]> {
  const rules = loadAgentRulesFromDisk();
  const map = new Map<string, { status: string; color: string | undefined; indicator: AgentIndicator; clearDelayMs: number; regex: RegExp }[]>();
  for (const config of rules) {
    const compiled = config.rules.map(r => ({
      status: r.status,
      color: r.color,
      indicator: normalizeAgentIndicator(r.indicator),
      clearDelayMs: normalizeAgentClearDelay(r.clearDelayMs),
      regex: new RegExp(r.pattern, 'i'),
    }));

    const programNames = Array.isArray(config.programs)
      ? config.programs
      : (typeof config.program === 'string' ? [config.program] : []);

    for (const name of programNames) {
      const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
      if (!normalized) continue;
      map.set(normalized, compiled);
    }
  }
  agentRulesCache = map;
  agentRulesVersion++;
  return map;
}

const AGENT_RULES_FILE = `${os.homedir()}/.termdock/agent-rules.json`;

function loadAgentRulesFromDisk(): AgentProgramConfig[] {
  try {
    const data = fs.readFileSync(AGENT_RULES_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch { /* file doesn't exist or invalid, use builtins */ }
  return BUILTIN_AGENT_RULES;
}

function saveAgentRulesToDisk(rules: AgentProgramConfig[]): void {
  const dir = path.dirname(AGENT_RULES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AGENT_RULES_FILE, JSON.stringify(rules, null, 2));
  loadAgentRules();
}

// Initialize on startup
loadAgentRules();

function isAiToolProgram(command: string | null | undefined): boolean {
  if (!command) return false;
  return agentRulesCache.has(command.toLowerCase());
}

/**
 * 去除 ANSI 转义序列，保留纯文本内容
 */
function stripAnsi(data: string): string {
  return data
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')           // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')  // OSC sequences
    .replace(/\x1b[()][AB0-2]/g, '')                   // Charset
    .replace(/\x1b[^[\]()0-9]/g, '')                   // Other escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');    // Control chars
}

/**
 * 基于可配置规则匹配检测 AI 工具状态
 * 只看实际输出文本，不受 resize/布局变化影响
 */
function detectAgentStatus(command: string, buf: string): { status: string; color: string | undefined; indicator: AgentIndicator; clearDelayMs: number } | null {
  if (!buf || buf.length < 2) return null;

  const rules = agentRulesCache.get(command.toLowerCase());
  if (!rules) return null;

  // 只看最后 1KB，这是最新的输出
  const tail = buf.slice(-1024);

  for (const rule of rules) {
    if (rule.regex.test(tail)) {
      return { status: rule.status, color: rule.color, indicator: rule.indicator, clearDelayMs: rule.clearDelayMs };
    }
  }

  return null;
}

function clearAgentStatusTimer(session: TerminalSession): void {
  if (session.agentStatusTimer) {
    clearTimeout(session.agentStatusTimer);
    session.agentStatusTimer = null;
  }
}

function evaluateAgentStatus(sessionId: string, session: TerminalSession, latestChunk?: string): void {
  const previousStatus = session.agentStatus;
  const command = session.activeProgram?.command;

  if (!command || !isAiToolProgram(command)) {
    if (previousStatus !== null) {
      clearAgentStatusTimer(session);
      session.agentStatus = null;
      session.agentColor = null;
      session.agentIndicator = null;
      session.agentStatusClearDelayMs = DEFAULT_AGENT_CLEAR_DELAY_MS;
      broadcastEvent(sessionId, { type: 'agent-status', agentStatus: null, agentColor: null, agentIndicator: null });
    }
    return;
  }

  const detected = detectAgentStatus(command, latestChunk || session.agentStatusBuf);

  if (detected) {
    clearAgentStatusTimer(session);
    const newStatus = detected.status;
    const newColor = detected.color ?? null;
    const newIndicator = detected.indicator;
    session.agentStatusClearDelayMs = detected.clearDelayMs;
    if (newStatus !== previousStatus || newColor !== session.agentColor || newIndicator !== session.agentIndicator) {
      session.agentStatus = newStatus;
      session.agentColor = newColor;
      session.agentIndicator = newIndicator;
      broadcastEvent(sessionId, { type: 'agent-status', agentStatus: newStatus, agentColor: newColor, agentIndicator: newIndicator });
    }
    return;
  }

  if (previousStatus !== null && !session.agentStatusTimer) {
    session.agentStatusTimer = setTimeout(() => {
      session.agentStatusTimer = null;
      const recheck = detectAgentStatus(command, session.agentStatusBuf.slice(-256));
      if (!recheck) {
        session.agentStatus = null;
        session.agentColor = null;
        session.agentIndicator = null;
        session.agentStatusClearDelayMs = DEFAULT_AGENT_CLEAR_DELAY_MS;
        broadcastEvent(sessionId, { type: 'agent-status', agentStatus: null, agentColor: null, agentIndicator: null });
      }
    }, session.agentStatusClearDelayMs);
  }
}

// ── end Agent status detection ──

/**
 * Resolve the "real" program name for a tmux pane.
 *
 * tmux's `#{pane_current_command}` only returns the kernel comm (e.g. "node"),
 * which is too coarse — we can't distinguish `aiden x claude` from `node server.js`.
 * So we use the pane's shell PID + `ps` to find the foreground child process
 * and extract a meaningful label from its full command line.
 */

/** Programs where `pane_current_command` is too generic and we should try harder */
const GENERIC_PROGRAM_NAMES = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'java']);

async function resolveTmuxPaneProgram(pane: TmuxPane): Promise<{
  command: string | null;
  source: 'tmux-pane' | 'tmux-tty';
  rawArgs: string | null;
} | null> {
  // If pane command is a known shell, try to find a child foreground process
  const isShell = pane.command && SHELL_NAMES_BACKEND.has(pane.command);
  // If pane command is NOT a shell but also too generic (e.g. "node"), also try
  const isGeneric = pane.command && GENERIC_PROGRAM_NAMES.has(pane.command);

  if (!isShell && !isGeneric) {
    // Non-shell, non-generic command — pane_current_command is good enough
    return { command: normalizeProgramName(pane.command), source: 'tmux-pane', rawArgs: null };
  }

  if (!pane.pid) {
    return { command: normalizeProgramName(pane.command), source: 'tmux-pane', rawArgs: null };
  }

  try {
    // Use ps to find the foreground process group on this TTY
    const { stdout } = await execFileAsync('ps', [
      '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,comm=,args=',
    ], { timeout: 3000, maxBuffer: 512 * 1024 });

    const rows = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // ps -o format: PID PPID PGID TPGID STAT COMM ARGS
        // COMM is a single token; ARGS is the rest of the line
        const match = line.match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (!match) return null;
        return {
          pid: parseInt(match[1], 10),
          ppid: parseInt(match[2], 10),
          pgid: parseInt(match[3], 10),
          tpgid: parseInt(match[4], 10),
          stat: match[5],
          comm: match[6],
          args: match[7].trim(),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    // Find processes that are children of the pane's shell (pane.pid)
    // and are in the foreground process group
    const foregroundChildren = rows.filter(
      (row) => row.pid !== pane.pid && row.tpgid > 0 && row.pgid === row.tpgid && !row.stat.startsWith('Z'),
    );

    // Prefer children of the shell PID
    const shellChildren = foregroundChildren.filter((row) => {
      // Walk up parent chain — is pane.pid an ancestor?
      let current = row;
      for (let depth = 0; depth < 10; depth++) {
        if (current.ppid === pane.pid) return true;
        const parent = rows.find((r) => r.pid === current.ppid);
        if (!parent) break;
        current = parent;
      }
      return false;
    });

    const target = shellChildren[0] ?? foregroundChildren[0];
    if (target?.args) {
      const resolved = extractProgramLabel(target.args);
      return { command: resolved, source: 'tmux-tty', rawArgs: target.args };
    }
  } catch (err) {
    // Fall through to pane_current_command fallback
  }

  return { command: normalizeProgramName(pane.command), source: 'tmux-pane', rawArgs: null };
}

/** Known CLI wrapper scripts that wrap another tool. */
const WRAPPER_SCRIPT_NAMES = new Set(['aiden', 'ttadk', 'coco', 'npx', 'yarn', 'dlx']);

/**
 * Extract a human-readable program label from a full command line.
 *
 * e.g. "node /path/to/aiden x claude --flag" → "claude"
 *      "node /path/to/ttadk claude --flag" → "claude"
 *      "node /path/to/npm install" → "npm"
 *      "node /path/to/server.js" → "server"
 *      "python3 /path/to/train.py" → "train"
 *      "vim /path/to/file.txt" → "vim"
 *      "/usr/bin/git status" → "git"
 */
function extractProgramLabel(args: string): string | null {
  if (!args) return null;

  const parts = args.split(/\s+/);
  const exe = parts[0]; // e.g. "/usr/bin/node" or "node"
  const exeName = exe.split(/[\\/]/).pop() || exe; // basename

  // For generic interpreters/runtimes, try to derive label from the script
  if (GENERIC_PROGRAM_NAMES.has(exeName) && parts.length > 1) {
    const script = parts[1];
    const scriptName = script.split(/[\\/]/).pop() || script;

    // Remove common extensions
    const withoutExt = scriptName.replace(/\.(js|ts|mjs|cjs|py|sh|rb|pl|lua)$/, '');

    if (withoutExt && withoutExt.length > 0) {
      // If the script is a known wrapper, try to find the real program inside
      if (WRAPPER_SCRIPT_NAMES.has(withoutExt)) {
        const remaining = parts.slice(2);
        // Known CLI wrapper patterns: <script> <subcommand> <real-program>
        // "x" is a common subcommand in CLI wrappers (e.g. "aiden x claude")
        const skipTokens = new Set(['x', 'run', 'exec', 'use']);
        let idx = 0;
        if (remaining.length > 0 && skipTokens.has(remaining[0])) {
          idx = 1;
        }
        // The next non-flag token is likely the real program name
        for (let i = idx; i < remaining.length; i++) {
          const token = remaining[i];
          if (token.startsWith('-')) continue;
          return token;
        }
        // Fallback: couldn't find a sub-program, use the wrapper name
        return withoutExt;
      }

      // For other scripts (npm, pip, etc.), just use the script name directly
      return withoutExt;
    }
  }

  return exeName;
}

function getActiveProgramFromTmuxLayout(layout: TmuxLayout): { command: string | null; source: 'tmux-pane' | 'tmux-tty'; updatedAt: number; rawArgs: string | null } | null {
  const activeWindow = layout.windows.find((window) => window.id === layout.activeWindowId);
  const activePane = activeWindow?.panes.find((pane) => pane.id === layout.activePaneId);

  if (!activePane) {
    return null;
  }

  const command = normalizeProgramName(activePane.command);
  if (!command) {
    return null;
  }

  // For shell/generic programs, we'll resolve asynchronously in the caller
  // Here we just return the basic info; the caller will call resolveTmuxPaneProgram
  return {
    command,
    source: 'tmux-pane',
    updatedAt: Date.now(),
    rawArgs: null,
  };
}

function getCwdFromTmuxLayout(layout: TmuxLayout): string | null {
  const activeWindow = layout.windows.find((window) => window.id === layout.activeWindowId);
  const activePane = activeWindow?.panes.find((pane) => pane.id === layout.activePaneId);
  return activePane?.currentPath || null;
}

// ── label builder (mirrors the frontend `getTabDisplayLines` semantics) ──
//
// Used to populate the `@termdock-label` tmux user option so external tools
// (e.g. `termdock --tls`) can show a meaningful one-line summary that matches
// what the user sees on the tab in the browser.

const SHELL_NAMES_BACKEND = new Set([
  'bash',
  'zsh',
  'fish',
  'sh',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
]);

function getCwdLeafBackend(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.trim();
  if (!trimmed) return null;
  if (trimmed === '/') return '/';
  const normalized = trimmed.replace(/[\\/]+$/, '');
  if (!normalized) return '/';
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const leaf = segments[segments.length - 1];
  return leaf && leaf.length > 0 ? leaf : trimmed;
}

function buildTermdockLabel(input: {
  friendlyName: string | null;
  program: string | null;
  cwd: string | null;
  sessionName: string;
}): string {
  const friendly = input.friendlyName?.trim();
  if (friendly) return friendly;

  const program = input.program?.trim();
  const dir = getCwdLeafBackend(input.cwd);

  if (program && !SHELL_NAMES_BACKEND.has(program)) {
    return dir ? `${program} · ${dir}` : program;
  }

  if (dir) return dir;
  return input.sessionName;
}

// Find a friendly (custom) name for a given tmux session from the global state.
function findFriendlyNameForTmuxSession(tmuxSessionName: string): string | null {
  for (const s of globalSessionState.sessions) {
    if (
      s.mode === 'tmux' &&
      s.tmuxSessionName === tmuxSessionName &&
      s.customName === true &&
      typeof s.name === 'string' &&
      s.name.trim().length > 0
    ) {
      return s.name;
    }
  }
  return null;
}

// Push the latest dynamic metadata (program / cwd / label / last-active-at)
// onto the tmux session as user options. Caller passes the previous label
// and last-active-write timestamp so repeated polls with no change skip the
// tmux write entirely. Returns the new (label, last-active-write) pair.
const TERMDOCK_LAST_ACTIVE_REFRESH_MS = 30_000;

function syncDynamicTmuxMetadata(input: {
  tmuxSessionName: string;
  program: string | null;
  cwd: string | null;
  previousLabel: string | null;
  lastActiveWriteAt: number;
}): { label: string; lastActiveWriteAt: number } {
  const { tmuxSessionName, program, cwd, previousLabel, lastActiveWriteAt } = input;
  const friendlyName = findFriendlyNameForTmuxSession(tmuxSessionName);
  const label = buildTermdockLabel({
    friendlyName,
    program,
    cwd,
    sessionName: tmuxSessionName,
  });
  const now = Date.now();

  if (label === previousLabel) {
    // Cheap path: refresh last-active-at at most every 30 s so external
    // tools see the session as alive without flooding tmux every 500 ms.
    if (now - lastActiveWriteAt >= TERMDOCK_LAST_ACTIVE_REFRESH_MS) {
      void setTmuxOption(tmuxSessionName, '@termdock-last-active-at', String(now));
      return { label, lastActiveWriteAt: now };
    }
    return { label, lastActiveWriteAt };
  }

  void setTmuxOptions(tmuxSessionName, {
    '@termdock-label': label,
    '@termdock-program': program ?? '',
    '@termdock-cwd': cwd ?? '',
    '@termdock-last-active-at': String(now),
  });
  return { label, lastActiveWriteAt: now };
}

async function detectShellActiveProgram(session: TerminalSession): Promise<{
  command: string | null;
  source: 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown';
  rawArgs: string | null;
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
          rawArgs: null,
          updatedAt: Date.now(),
        };
      }

      const shellRow = rows.find((row) => row.pid === pid && row.command);
      if (shellRow?.command) {
        return {
          command: shellRow.command,
          source: 'shell-pid',
          rawArgs: null,
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
    rawArgs: null,
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
      `#{pane_id}${TMUX_DELIMITER}#{pane_index}${TMUX_DELIMITER}#{pane_active}${TMUX_DELIMITER}#{pane_width}${TMUX_DELIMITER}#{pane_height}${TMUX_DELIMITER}#{pane_top}${TMUX_DELIMITER}#{pane_left}${TMUX_DELIMITER}#{pane_current_command}${TMUX_DELIMITER}#{pane_pid}${TMUX_DELIMITER}#{pane_title}${TMUX_DELIMITER}#{pane_current_path}`,
    ]);

    const panes: TmuxPane[] = panesRaw.trim().split('\n').filter(Boolean).map((paneLine) => {
      const paneRow = parseDelimitedRow(paneLine, 11);
      if (!paneRow) {
        return null;
      }

      const [paneId, paneIndexRaw, paneActiveRaw, widthRaw, heightRaw, topRaw, leftRaw, command, pidRaw, title, currentPath] = paneRow;
      return {
        id: paneId,
        index: parseInt(paneIndexRaw || '0', 10),
        active: paneActiveRaw === '1',
        width: parseInt(widthRaw || '0', 10),
        height: parseInt(heightRaw || '0', 10),
        top: parseInt(topRaw || '0', 10),
        left: parseInt(leftRaw || '0', 10),
        command: command || '',
        pid: parseInt(pidRaw || '0', 10) || 0,
        title: title || '',
        currentPath: currentPath || '',
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

// Mirror the current SSE+WS client count onto the session's tmux user
// option `@termdock-client-count`. No-op for shell sessions.
function syncClientCountToTmux(sessionId: string): void {
  const session = terminalSessions.get(sessionId);
  if (!session || session.mode !== 'tmux' || !session.tmuxSessionName) return;
  void setTmuxOption(
    session.tmuxSessionName,
    '@termdock-client-count',
    String(getTotalClients(sessionId)),
  );
}

function closeClient(session: TerminalSession, sessionId: string, clientId: string): void {
  const client = session.clients.get(clientId);
  if (!client) {
    return;
  }

  session.clients.delete(clientId);
  syncClientCountToTmux(sessionId);

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

  if (session.agentStatusTimer) {
    clearTimeout(session.agentStatusTimer);
    session.agentStatusTimer = null;
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

  // Fast-path cleanup for natural shell exits (PTY died on its own, not via
  // our DELETE /:id path). Drop the persisted client-state entry so every
  // browser sees the tab vanish within one WS tick, instead of waiting up to
  // 30s for the reconciler. Only fires for shell mode: a tmux wrapper
  // exiting is normal (the user can detach/reconnect) and the tmux daemon
  // itself is independent of the wrapper.
  if (options.killProcess === false && session.mode === 'shell') {
    const beforeCount = globalSessionState.sessions.length;
    globalSessionState = {
      sessions: globalSessionState.sessions.filter((s) => s.backendSessionId !== sessionId),
      updatedAt: Date.now(),
    };
    if (globalSessionState.sessions.length !== beforeCount) {
      schedulePersistGlobalState();
      broadcastClientState();
    }
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

    // Agent status detection for AI coding tools
    try {
      if (isAiToolProgram(session.activeProgram?.command)) {
        // Append stripped text to rolling buffer for pattern matching
        const stripped = stripAnsi(data);
        if (stripped) {
          const buf = session.agentStatusBuf + stripped;
          session.agentStatusBuf = buf.length > AGENT_BUF_CAP ? buf.slice(-AGENT_BUF_CAP / 2) : buf;
          // Log spinner/prompt patterns for debugging (capped at 512KB)
          const tail = session.agentStatusBuf.slice(-200);
          if (/[·✢✳✶✻✽❋❇⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠁⠂⠃⠄⠅⠆⠉⠊]/.test(tail) || /Tab\/Arrow keys to navigate|Esc to|select ·|AskUserQuestion/i.test(tail)) {
            try {
              const logPath = `${os.homedir()}/.termdock/agent-debug.log`;
              const { statSync, appendFileSync } = fs;
              let size = 0;
              try { size = statSync(logPath).size; } catch { /* not exists yet */ }
              if (size > 512 * 1024) fs.writeFileSync(logPath, ''); // truncate if too large
              appendFileSync(logPath, `[${new Date().toISOString()}] program=${session.activeProgram?.command} tail=${JSON.stringify(tail)}\n`);
            } catch { /* logging failure should never block */ }
          }
        }

        // Content-based detection on every data chunk
        evaluateAgentStatus(sessionId, session, stripped);
      }
    } catch { /* agent status detection failure should never block data */ }

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
    hasWrittenData: false,
    activeProgram: null,
    oscSniffBuf: '',
    lastOscCwd: null,
    agentStatus: null,
    agentColor: null,
    agentIndicator: null,
    agentStatusBuf: '',
    agentStatusTimer: null,
    agentStatusClearDelayMs: DEFAULT_AGENT_CLEAR_DELAY_MS,
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

    // Stamp termdock metadata as tmux user options so external tools (e.g.
    // `termdock --tls`) can identify and describe this session.
    void (async () => {
      const baseOptions: Record<string, string> = {
        '@termdock-version': TERMDOCK_VERSION,
        '@termdock-host': TERMDOCK_HOST,
        '@termdock-pid': TERMDOCK_PID,
      };
      // Preserve `@termdock-created-at` if a previous termdock instance
      // already stamped it on this tmux session.
      const existingCreatedAt = await getTmuxOption(tmuxSessionName, '@termdock-created-at');
      if (!existingCreatedAt) {
        baseOptions['@termdock-created-at'] = String(Date.now());
      }
      await setTmuxOptions(tmuxSessionName, baseOptions);
    })();

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

    if (idleTooLong) {
      console.log(`Cleaning up terminal session: ${sessionId}, idleTooLong=${idleTooLong}`);
      cleanupSession(sessionId, { killProcess: true });
    }
  }
}, CLEANUP_INTERVAL);

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

router.delete('/tmux/sessions/:name', async (req, res) => {
  const rawName = typeof req.params.name === 'string' ? req.params.name.trim() : '';
  if (!rawName) {
    return res.status(400).json({ error: 'tmux session name is required' });
  }
  // tmux session names cannot contain ':' or '.'; reject anything that doesn't look right.
  if (/[:.\s]/.test(rawName)) {
    return res.status(400).json({ error: 'invalid tmux session name' });
  }

  // Detach any local terminal sessions still wired to this tmux session so that
  // their pty (the tmux client) is cleaned up alongside the kill-session call.
  const affectedSessionIds: string[] = [];
  for (const [sessionId, session] of terminalSessions.entries()) {
    if (session.mode === 'tmux' && session.tmuxSessionName === rawName) {
      affectedSessionIds.push(sessionId);
    }
  }

  try {
    await runTmux(['kill-session', '-t', rawName]);
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (/can't find session|no server running|session not found/i.test(errorMessage)) {
      // Already gone; treat as success and still clean up any orphan ptys.
      for (const id of affectedSessionIds) {
        try { cleanupSession(id, { killProcess: true }); } catch {}
      }
      return res.json({ success: true, alreadyGone: true, cleanedSessions: affectedSessionIds });
    }
    if (isTmuxUnavailableMessage(errorMessage)) {
      return res.status(503).json({ error: 'tmux is not installed or not available in PATH.' });
    }
    return res.status(500).json({ error: errorMessage || 'Failed to kill tmux session' });
  }

  for (const id of affectedSessionIds) {
    try { cleanupSession(id, { killProcess: true }); } catch (error) {
      console.error(`[tmux] cleanup attached session ${id} failed:`, getErrorMessage(error));
    }
  }

  // Also drop any persisted client-state entries that pointed at this tmux
  // session. Without this, every connected browser would still see a tab
  // whose backing tmux server is gone, and only the 30s reconciler would
  // notice. Doing it inline + broadcasting keeps cross-device UX instant.
  const beforeCount = globalSessionState.sessions.length;
  globalSessionState = {
    sessions: globalSessionState.sessions.filter((s) => !(s.mode === 'tmux' && s.tmuxSessionName === rawName)),
    updatedAt: Date.now(),
  };
  if (globalSessionState.sessions.length !== beforeCount) {
    schedulePersistGlobalState();
    broadcastClientState();
  }

  console.log(`[tmux] killed session: ${rawName} (cleaned ${affectedSessionIds.length} attached pty, dropped ${beforeCount - globalSessionState.sessions.length} client-state entries)`);
  res.json({ success: true, cleanedSessions: affectedSessionIds });
});

router.post('/serialize-state', async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? new Set((req.body.ids as unknown[]).filter((item): item is string => typeof item === 'string'))
    : null;

  const states = await Promise.all(
    Array.from(terminalSessions.entries())
      .filter(([sessionId]) => (ids ? ids.has(sessionId) : true))
      .map(async ([sessionId, session]) => ({
        sessionId,
        cwd: session.cwd,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        backend: session.ptyBackend,
        mode: session.mode,
        tmuxSessionName: session.tmuxSessionName,
        history: await getRestoreHistory(sessionId, session),
      }))
  );

  res.json({
    serialized: JSON.stringify({ version: 1, states }),
    states,
  });
});

router.get('/client-state', (_req, res) => {
  res.json(globalSessionState);
});

router.put('/client-state', (req, res) => {
  const previousState = { ...globalSessionState };
  const state = normalizeGlobalSessionState(req.body);
  globalSessionState = state;
  schedulePersistGlobalState();
  broadcastClientState();

  // Sync friendly-name to tmux user options for any tmux session whose
  // customName flag flipped, or whose name changed while customName=true.
  // Only fires for tmux-mode sessions; shell sessions have no tmux to write to.
  void (async () => {
    const previousByTmux = new Map<string, PersistedClientSession>();
    for (const s of previousState.sessions) {
      if (s.mode === 'tmux' && s.tmuxSessionName) {
        previousByTmux.set(s.tmuxSessionName, s);
      }
    }

    for (const session of state.sessions) {
      if (session.mode !== 'tmux' || !session.tmuxSessionName) continue;
      const prev = previousByTmux.get(session.tmuxSessionName);
      const wasCustom = prev?.customName === true;
      const isCustom = session.customName === true;
      const nameChanged = prev?.name !== session.name;

      if (isCustom && (!wasCustom || nameChanged)) {
        await setTmuxOption(session.tmuxSessionName, '@termdock-friendly-name', session.name);
      } else if (!isCustom && wasCustom) {
        await unsetTmuxOption(session.tmuxSessionName, '@termdock-friendly-name');
      }
    }
  })();

  res.json(state);
});

router.delete('/client-state', (_req, res) => {
  globalSessionState = { sessions: [], updatedAt: Date.now() };
  schedulePersistGlobalState();
  broadcastClientState();
  res.status(204).send();
});

router.get('/toolbar-presets', (_req, res) => {
  res.json(toolbarPresetsDoc ?? { version: 0, presets: [], updatedAt: 0 });
});

router.put('/toolbar-presets', (req, res) => {
  const body = (req.body ?? {}) as Partial<ToolbarPresetsDoc>;
  const version = typeof body.version === 'number' ? body.version : 0;
  const presets = Array.isArray(body.presets) ? body.presets : [];
  toolbarPresetsDoc = { version, presets, updatedAt: Date.now() };
  schedulePersistToolbarPresets();
  res.json(toolbarPresetsDoc);
});

// ── Settings (prevent sleep) ──────────────────────────────────────────
router.get('/settings', (_req, res) => {
  res.json({
    preventSleep: caffeinateManager.getPreventSleep(),
    caffeinateActive: caffeinateManager.isActive(),
    networkAvailable: caffeinateManager.isNetworkAvailable(),
  });
});

router.put('/settings', (req, res) => {
  const body = req.body ?? {};
  if (typeof body.preventSleep === 'boolean') {
    caffeinateManager.setPreventSleep(body.preventSleep);
  }
  res.json({
    preventSleep: caffeinateManager.getPreventSleep(),
    caffeinateActive: caffeinateManager.isActive(),
    networkAvailable: caffeinateManager.isNetworkAvailable(),
  });
});

// ── Agent detection rules API ──

router.get('/agent-rules', (_req, res) => {
  res.json(loadAgentRulesFromDisk());
});

router.put('/agent-rules', (req, res) => {
  const rules = req.body;
  if (!Array.isArray(rules)) {
    res.status(400).json({ error: 'Expected array of program configs' });
    return;
  }
  // Basic validation
  for (const config of rules) {
    const hasProgram = typeof config.program === 'string' && config.program.trim().length > 0;
    const hasPrograms = Array.isArray(config.programs) && config.programs.some((name: unknown) => typeof name === 'string' && name.trim().length > 0);
    if ((!hasProgram && !hasPrograms) || !Array.isArray(config.rules)) {
      res.status(400).json({ error: 'Each config must have program/programs and rules' });
      return;
    }
    for (const rule of config.rules) {
      if (!rule.pattern || !rule.status) {
        res.status(400).json({ error: 'Each rule must have pattern and status' });
        return;
      }
      // Validate regex
      try { new RegExp(rule.pattern, 'i'); } catch {
        res.status(400).json({ error: `Invalid regex: ${rule.pattern}` });
        return;
      }
      if (rule.indicator !== undefined && !AGENT_INDICATORS.has(rule.indicator)) {
        res.status(400).json({ error: `Invalid indicator: ${rule.indicator}` });
        return;
      }
      if (rule.clearDelayMs !== undefined) {
        const delay = Number(rule.clearDelayMs);
        if (!Number.isFinite(delay) || delay < MIN_AGENT_CLEAR_DELAY_MS || delay > MAX_AGENT_CLEAR_DELAY_MS) {
          res.status(400).json({ error: `clearDelayMs must be ${MIN_AGENT_CLEAR_DELAY_MS}-${MAX_AGENT_CLEAR_DELAY_MS}` });
          return;
        }
      }
    }
  }
  saveAgentRulesToDisk(rules);
  res.json(rules);
});

router.delete('/agent-rules', (_req, res) => {
  // Remove custom rules file so builtins take effect again
  try { fs.unlinkSync(AGENT_RULES_FILE); } catch { /* already gone */ }
  loadAgentRules();
  res.json(BUILTIN_AGENT_RULES);
});

router.post('/create', async (req, res) => {
  try {
    const { cwd: inputCwd, cols, rows, mode, tmuxSessionName } = req.body;
    const normalizedMode = normalizeMode(mode);
    const normalizedTmuxName = normalizedMode === 'tmux' ? normalizeTmuxSessionName(tmuxSessionName) : null;

    // Deduplicate: if a TerminalSession for this tmux session already exists,
    // return it instead of creating a duplicate wrapper.  tmux's own
    // new-session -A already prevents duplicate tmux sessions.
    if (normalizedMode === 'tmux' && normalizedTmuxName) {
      for (const [id, s] of terminalSessions.entries()) {
        if (s.mode === 'tmux' && s.tmuxSessionName === normalizedTmuxName) {
          console.log(`Reusing existing terminal session ${id} for tmux:${normalizedTmuxName}`);
          // Refresh host/pid/version on reuse so a restarted server claims the
          // session in tmux user options; created-at is left untouched.
          void setTmuxOptions(normalizedTmuxName, {
            '@termdock-version': TERMDOCK_VERSION,
            '@termdock-host': TERMDOCK_HOST,
            '@termdock-pid': TERMDOCK_PID,
          });
          return res.json({
            sessionId: id,
            mode: s.mode,
            tmuxSessionName: s.tmuxSessionName,
            activeProgram: s.activeProgram?.command ?? null,
            activeProgramRaw: s.activeProgram?.rawArgs ?? null,
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
    });

    console.log(`Created terminal session: ${spawned.sessionId} in ${spawned.session.cwd}`);
    res.json({
      sessionId: spawned.sessionId,
      cols: cols || 80,
      rows: rows || 24,
      mode: spawned.session.mode,
      tmuxSessionName: spawned.session.tmuxSessionName,
      activeProgram: spawned.session.activeProgram?.command ?? null,
      activeProgramRaw: spawned.session.activeProgram?.rawArgs ?? null,
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
  syncClientCountToTmux(sessionId);

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
    activeProgramRaw: session.activeProgram?.rawArgs ?? null,
    activeProgramSource: session.activeProgram?.source ?? null,
    agentStatus: session.agentStatus,
    agentColor: session.agentColor,
    agentIndicator: session.agentIndicator,
  });

  let tmuxInterval: ReturnType<typeof setInterval> | null = null;
  let activeProgramInterval: ReturnType<typeof setInterval> | null = null;
  let lastTmuxLayoutSnapshot = '';
  let lastActiveProgramSnapshot = JSON.stringify(session.activeProgram ?? null);
  let lastTmuxMetaLabel: string | null = null;
  let lastTmuxMetaWriteAt = 0;

  const maybeWriteActiveProgram = (activeProgram: TerminalSession['activeProgram']) => {
    const snapshot = JSON.stringify(activeProgram ? { command: activeProgram.command, source: activeProgram.source } : null);
    if (snapshot === lastActiveProgramSnapshot) {
      return;
    }

    lastActiveProgramSnapshot = snapshot;
    session.activeProgram = activeProgram;

    // Agent status: react to AI tool start/exit
    evaluateAgentStatus(sessionId, session);

    console.log(
      `[active-program][shell-sse] session=${sessionId} client=${clientId} cmd=${activeProgram?.command ?? null} source=${activeProgram?.source ?? null}`,
    );
    writeSse(res, {
      type: 'active-program',
      activeProgram: activeProgram?.command ?? null,
      activeProgramRaw: activeProgram?.rawArgs ?? null,
      activeProgramSource: activeProgram?.source ?? null,
    });
  };

  const sendTmuxLayout = async () => {
    if (session.mode !== 'tmux' || !session.tmuxSessionName) {
      return;
    }

    try {
      const layout = await getTmuxLayout(session.tmuxSessionName);

      // Resolve the active program — try ps-based detection for generic commands
      const activeWindow = layout.windows.find((window) => window.id === layout.activeWindowId);
      const activePane = activeWindow?.panes.find((pane) => pane.id === layout.activePaneId);
      if (activePane) {
        const resolved = await resolveTmuxPaneProgram(activePane);
        if (resolved) {
          maybeWriteActiveProgram({
            command: resolved.command,
            source: resolved.source,
            rawArgs: resolved.rawArgs,
            updatedAt: Date.now(),
          });
        } else {
          maybeWriteActiveProgram(getActiveProgramFromTmuxLayout(layout));
        }
      } else {
        maybeWriteActiveProgram(getActiveProgramFromTmuxLayout(layout));
      }

      const newCwd = getCwdFromTmuxLayout(layout);
      if (newCwd && newCwd !== session.cwd) {
        session.cwd = newCwd;
        console.log(`[tmux-cwd][sse] session=${sessionId} cwd=${newCwd}`);
        writeSse(res, { type: 'cwd', cwd: newCwd });
      }
      // Mirror dynamic metadata onto tmux user options (cheap when nothing
      // changed thanks to the label cache).
      const meta = syncDynamicTmuxMetadata({
        tmuxSessionName: session.tmuxSessionName,
        program: session.activeProgram?.command ?? null,
        cwd: session.cwd ?? null,
        previousLabel: lastTmuxMetaLabel,
        lastActiveWriteAt: lastTmuxMetaWriteAt,
      });
      lastTmuxMetaLabel = meta.label;
      lastTmuxMetaWriteAt = meta.lastActiveWriteAt;

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
      activeProgramRaw: session.activeProgram?.rawArgs ?? null,
      activeProgramSource: session.activeProgram?.source ?? null,
    });
 });

router.get('/:sessionId/attach', async (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.lastActivity = Date.now();

  const history = await getRestoreHistory(sessionId, session);
  // 把当前 history 的最后 seq 一并返回，前端用它作为 WS 重连补帧的基线。
  // tmux 模式下 sessionHistory 里没东西（capture pane 走不同通道），lastSeq 仍取 0。
  const lastSeq = session.mode === 'shell' ? getHistoryLastSeq(sessionId) : 0;

  res.json({
    sessionId,
    cwd: session.cwd,
    backend: session.ptyBackend,
    clients: getTotalClients(sessionId),
    mode: session.mode,
    tmuxSessionName: session.tmuxSessionName,
    history,
    lastSeq,
    activeProgram: session.activeProgram?.command ?? null,
    activeProgramRaw: session.activeProgram?.rawArgs ?? null,
    activeProgramSource: session.activeProgram?.source ?? null,
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
    return res.json({ success: true, alreadyGone: true });
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
  const { cwd: inputCwd, cols, rows, mode, tmuxSessionName } = req.body;

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
    });

    console.log(`Restarted terminal session: ${sessionId} -> ${newSessionId} in ${session.cwd}`);
    res.json({
      sessionId: newSessionId,
      cols: cols || 80,
      rows: rows || 24,
      mode: session.mode,
      tmuxSessionName: session.tmuxSessionName,
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

export function handleTerminalWebSocket(
  ws: WebSocket,
  sessionId: string,
  clientId: string,
  options: { sinceSeq?: number } = {},
): void {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    ws.close(4001, 'Session not found');
    return;
  }
  const sinceSeq = options.sinceSeq ?? 0;

  // Register client
  let clients = wsClients.get(sessionId);
  if (!clients) {
    clients = new Map();
    wsClients.set(sessionId, clients);
  }
  clients.set(clientId, ws);
  session.lastActivity = Date.now();
  syncClientCountToTmux(sessionId);

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

    // 计算重连补帧：
    // - sinceSeq > 0：短线重连，shell 模式按 seq 补增量；超出窗口则发 outOfWindow + 全量。
    // - sinceSeq == 0：首次连接（包括手机 PWA 冷启动）。以前这里只回 lastSeq、不带数据，
    //   靠客户端单独走 HTTP /attach 拿 scrollback；但那条路径会阻塞 MultiTerminalView 的
    //   "Restoring sessions..." 全屏 loading（蜂窝 RTT 1-3 秒）。现在直接把 restore history
    //   塞进 'connected' 事件，省掉一次 HTTP 往返，前端 UI 可以立刻渲染、scrollback 随 WS
    //   到达即填充。tmux 模式发 capture-pane 输出（带 clear-screen 前缀，避免与 xterm 默认
    //   内容拼接），shell 模式发 ring buffer 内容（最多 100KB）。
    //
    //   replayOutOfWindow=true 的语义在 sinceSeq=0 时是"你没有基线，请清空已有内容
    //   再应用 replayChunks"。这正好覆盖客户端"localStorage hydrate 出来的缓存 buffer"
    //   场景：缓存内容会被服务端权威版本干净地替换，不会出现重复或顺序错位。
    let replayChunks: string[] = [];
    let replayLastSeq = 0;
    let replayOutOfWindow = false;
    if (sinceSeq > 0 && session.mode === 'shell') {
      const since = getHistorySince(sessionId, sinceSeq);
      replayChunks = since.chunks.map((c) => c.data);
      replayLastSeq = since.lastSeq;
      replayOutOfWindow = since.outOfWindow;
    } else {
      // 首次连接：直接补全量 scrollback，并强制让客户端清空已有内容（处理缓存 hydrate）
      try {
        replayChunks = await getRestoreHistory(sessionId, session);
      } catch (error) {
        console.warn(`[ws] getRestoreHistory failed for ${sessionId}: ${getErrorMessage(error)}`);
        replayChunks = [];
      }
      replayLastSeq = session.mode === 'shell' ? getHistoryLastSeq(sessionId) : 0;
      replayOutOfWindow = replayChunks.length > 0;
    }

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
      activeProgramRaw: session.activeProgram?.rawArgs ?? null,
      activeProgramSource: session.activeProgram?.source ?? null,
      agentStatus: session.agentStatus,
      agentColor: session.agentColor,
      agentIndicator: session.agentIndicator,
      // 短线重连补帧：
      // replayChunks 为补发数据；replayLastSeq 是客户端应记录的新基线；
      // replayOutOfWindow 表示客户端基线已被服务端淘汰，前端可以选择清屏后再回放。
      replayChunks,
      replayLastSeq,
      replayOutOfWindow,
    }));
  })();

  // Tmux layout polling (per-client, like the SSE stream does)
  let tmuxInterval: ReturnType<typeof setInterval> | null = null;
  let activeProgramInterval: ReturnType<typeof setInterval> | null = null;

  if (session.mode === 'tmux' && session.tmuxSessionName) {
    let lastTmuxLayoutSnapshot = '';
    let lastActiveProgramSnapshot = JSON.stringify(session.activeProgram ?? null);
    let lastTmuxMetaLabel: string | null = null;
    let lastTmuxMetaWriteAt = 0;

    const sendTmuxLayout = async () => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        const layout = await getTmuxLayout(session.tmuxSessionName!);
        // Update active program — try ps-based detection for generic commands
        const activeWindow = layout.windows.find((window) => window.id === layout.activeWindowId);
        const activePane = activeWindow?.panes.find((pane) => pane.id === layout.activePaneId);
        let ap: TerminalSession['activeProgram'] = null;
        if (activePane) {
          const resolved = await resolveTmuxPaneProgram(activePane);
          if (resolved) {
            ap = { command: resolved.command, source: resolved.source, rawArgs: resolved.rawArgs, updatedAt: Date.now() };
          } else {
            ap = getActiveProgramFromTmuxLayout(layout);
          }
        } else {
          ap = getActiveProgramFromTmuxLayout(layout);
        }
        const apSnapshot = JSON.stringify(ap ? { command: ap.command, source: ap.source } : null);
        if (apSnapshot !== lastActiveProgramSnapshot) {
          lastActiveProgramSnapshot = apSnapshot;
          session.activeProgram = ap;

          // Agent status: react to AI tool start/exit
          evaluateAgentStatus(sessionId, session);

          console.log(
            `[active-program][ws] session=${sessionId} cmd=${ap?.command ?? null} source=${ap?.source ?? null}`,
          );
          ws.send(JSON.stringify({
            type: 'active-program',
            activeProgram: ap?.command ?? null,
            activeProgramRaw: ap?.rawArgs ?? null,
            activeProgramSource: ap?.source ?? null,
          }));
        }
        // Update cwd from active pane
        const newCwd = getCwdFromTmuxLayout(layout);
        if (newCwd && newCwd !== session.cwd) {
          session.cwd = newCwd;
          console.log(`[tmux-cwd][ws] session=${sessionId} cwd=${newCwd}`);
          ws.send(JSON.stringify({ type: 'cwd', cwd: newCwd }));
        }
        // Mirror dynamic metadata onto tmux user options.
        const meta = syncDynamicTmuxMetadata({
          tmuxSessionName: session.tmuxSessionName!,
          program: session.activeProgram?.command ?? null,
          cwd: session.cwd ?? null,
          previousLabel: lastTmuxMetaLabel,
          lastActiveWriteAt: lastTmuxMetaWriteAt,
        });
        lastTmuxMetaLabel = meta.label;
        lastTmuxMetaWriteAt = meta.lastActiveWriteAt;

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
    let lastApSnapshot = JSON.stringify(session.activeProgram ? { command: session.activeProgram.command, source: session.activeProgram.source } : null);

    const pollActiveProgram = async () => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        const ap = await detectShellActiveProgram(session);
        const snapshot = JSON.stringify(ap ? { command: ap.command, source: ap.source } : null);
        if (snapshot !== lastApSnapshot) {
          lastApSnapshot = snapshot;
          session.activeProgram = ap;

          // Agent status: react to AI tool start/exit
          evaluateAgentStatus(sessionId, session);

          ws.send(JSON.stringify({
            type: 'active-program',
            activeProgram: ap?.command ?? null,
            activeProgramRaw: ap?.rawArgs ?? null,
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
            console.log('[WS input] sessionId=', sessionId, 'data=', JSON.stringify(msg.data), 'len=', msg.data.length, 'ts=', Date.now());
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
          // 心跳算活动：客户端每 20s 发一次 ping，没有这一行就会出现
          // "用户开着页面看 agent 跑、自己不动键盘"被 idle-cleanup 误杀的情况。
          session.lastActivity = Date.now();
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
      }
    }
    syncClientCountToTmux(sessionId);
  });

  ws.on('error', () => {
    // close handler will clean up
  });
}

// Refresh global WheelUpPane/WheelDownPane bindings on every server start
// so existing tmux sessions pick up the latest copy-mode flags.
configureTmuxWheelBindings().catch(() => {});

// ── Control WebSocket handler ──
//
// A separate, lightweight WS that exists purely to push client-state changes
// to every connected browser. We don't accept commands here (mutations still
// go through HTTP PUT/DELETE for CSRF + auth reuse); this channel is one-way
// server→client, with a server-initiated snapshot on connect and a small
// heartbeat to detect zombie sockets on iOS PWA resumes.
export function handleControlWebSocket(ws: WebSocket, clientId: string): void {
  controlClients.set(clientId, ws);

  // Initial snapshot — same shape the HTTP GET returns, so the client can
  // hydrate directly without a separate round-trip.
  try {
    ws.send(JSON.stringify({ type: 'client-state', state: globalSessionState }));
  } catch {
    controlClients.delete(clientId);
    return;
  }

  // Heartbeat: client never has to send anything. We just send a tiny ping
  // every 30s; if the underlying socket is dead the close will surface and
  // the reconnect-on-client-side path takes over.
  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(heartbeat);
      controlClients.delete(clientId);
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'control-ping', ts: Date.now() }));
    } catch {
      clearInterval(heartbeat);
      controlClients.delete(clientId);
    }
  }, 30_000);

  // Clients may send pong (or nothing). We accept and ignore.
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.type === 'pong') {
        // heartbeat ack, nothing to do
      }
    } catch { /* ignore malformed input */ }
  });

  const cleanup = (): void => {
    clearInterval(heartbeat);
    if (controlClients.get(clientId) === ws) {
      controlClients.delete(clientId);
    }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

// ── Periodic reconciler ──
//
// `pruneOrphanSessions` only runs at boot, so anything that goes wrong at
// runtime (external `tmux kill-session`, a shell wrapper whose PTY exited
// but whose entry was never PUT/DELETE'd) leaks into globalSessionState.
// Walk the persisted list every 30s and drop entries whose backing
// session/tmux server is no longer alive; broadcast the cleaned list.
const CLIENT_STATE_RECONCILE_INTERVAL_MS = 30_000;
const reconcileTimer: ReturnType<typeof setInterval> = setInterval(() => {
  void reconcileClientState();
}, CLIENT_STATE_RECONCILE_INTERVAL_MS);
// Don't keep the event loop alive for housekeeping.
reconcileTimer.unref?.();

async function reconcileClientState(): Promise<void> {
  if (globalSessionState.sessions.length === 0) return;

  const toRemove: string[] = [];
  for (const entry of globalSessionState.sessions) {
    if (entry.mode === 'shell') {
      // Shell wrapper: backendSessionId must map to a live terminal session.
      // No live wrapper → the shell process is gone, can't reattach.
      if (!entry.backendSessionId || !terminalSessions.has(entry.backendSessionId)) {
        toRemove.push(entry.sessionId);
      }
    } else if (entry.mode === 'tmux' && entry.tmuxSessionName) {
      // Tmux entry: the tmux daemon (independent of termdock) must still
      // own this session name. We deliberately do NOT require a live
      // terminal wrapper here — detaching from the wrapper doesn't kill
      // the tmux session.
      try {
        const alive = await tmuxSessionExists(entry.tmuxSessionName);
        if (!alive) toRemove.push(entry.sessionId);
      } catch {
        // tmux itself is down — leave the entry alone; the next tick (or
        // boot-time prune) will clean it up once tmux is back.
      }
    }
  }

  if (toRemove.length === 0) return;
  globalSessionState = {
    sessions: globalSessionState.sessions.filter((s) => !toRemove.includes(s.sessionId)),
    updatedAt: Date.now(),
  };
  schedulePersistGlobalState();
  broadcastClientState();
  console.log(`[reconcile] removed ${toRemove.length} orphan client-state entries: ${toRemove.join(', ')}`);
}

export default router;
