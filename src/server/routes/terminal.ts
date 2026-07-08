import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import type { WebSocket } from 'ws';
import { caffeinateManager } from '../utils/caffeinate.js';
import { localAccessManager } from '../utils/localAccess.js';
import { normalizeLocalAccessName } from '../utils/settings.js';
import { getOnboardingServerUrl } from '../onboardingServer.js';
import {
  getFocusSequence,
  removeClientFocusState,
  scanFocusTrackingMode,
  setClientFocusState,
  type FocusAggregationState,
} from '../utils/tmuxFocus.js';
import {
  extractProgramLabelFromArgs,
  normalizeProgramName,
  normalizeTmuxMetadataProgram,
  selectTmuxForegroundProgram,
  tmuxMetadataChanged,
  type TmuxProcessRow,
} from '../utils/tmuxProgramDetection.js';

const router: express.Router = express.Router();
const execFileAsync = promisify(execFile);
const TERMDOCK_DIR = `${os.homedir()}/.termdock`;

async function readJsonFileIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

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
const TERMDOCK_GUI_DETACHED_AT_OPTION = '@termdock-gui-detached-at';

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
  tty: string;
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
  // 当前 pty 真实尺寸：每次 resize 后更新并广播给所有 ws client，让其他
  // 客户端的 lastServerSize 跟服务端事实保持一致，避免多端切换时用陈旧
  // 值误判"尺寸没变，不发"。
  cols: number;
  rows: number;
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
  lastOscTitle: string | null;
  lastPromptState: 'idle' | 'running' | null;
  tuiProgress: TuiProgressReport | null;
  agentStatus: string | null;
  agentColor: string | null;
  agentIndicator: AgentIndicator | null;
  agentStatusBuf: string;      // 去除 ANSI 后的纯文本滚动缓冲区
  agentStatusTimer: ReturnType<typeof setTimeout> | null;
  agentStatusClearDelayMs: number;
  focusTrackingRequested: boolean;
  focusModeSniffBuf: string;
  focusAggregation: FocusAggregationState;
  flowPausedClients: Set<string>;
  flowPausedClientTimers: Map<string, ReturnType<typeof setTimeout>>;
  ptyPausedForFlowControl: boolean;
}

type TuiProgressReport = {
  state: 'remove' | 'set' | 'error' | 'indeterminate' | 'pause';
  progress: number | null;
};

interface PersistedClientSession {
  sessionId: string;
  name: string;
  customName?: boolean;
  backendSessionId: string | null;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  createdAt: number;
  lastActivity: number;
  cwd?: string | null;
}

interface GlobalSessionState {
  sessions: PersistedClientSession[];
  updatedAt: number;
}

interface TmuxInventoryMeta {
  name: string;
  windows: number;
  attachedCount: number;
  friendlyName: string | null;
  program: string | null;
  cwd: string | null;
  label: string | null;
  clientCount: number | null;
  host: string | null;
  pid: number | null;
  version: string | null;
  createdAt: number | null;
  lastActiveAt: number | null;
  guiDetachedAt: number | null;
}

interface SessionInventoryClientSession extends PersistedClientSession {
  frontendSessionId: string;
  customName: boolean;
  connected: boolean;
  live: boolean;
  restorable: boolean;
  // 展示名提示：tab 名按 activeProgram + cwd 计算（见前端 display.ts）。
  // 这两个值随 inventory 一起返回，让前端冷启动 / 缓存 hydrate 时无需等
  // WS 连上轮询 tmux 就能算出「coco termdock」，消除「先 wt-xxx 再跳变」。
  // 仅作展示用，非持久化字段（不写进 PersistedClientSession / 磁盘）。
  activeProgram?: string | null;
  cwd?: string | null;
}

interface SessionInventoryTmuxSession {
  name: string;
  windows: number;
  attached: number;
  attachedCount: number;
  createdAt: number | null;
  boundFrontendSessionId: string | null;
  connected: boolean;
  live: boolean;
  restorable: boolean;
  friendlyName: string | null;
  label: string | null;
  program: string | null;
  cwd: string | null;
  clientCount: number | null;
  lastActiveAt: number | null;
}

interface SessionInventory {
  clientSessions: SessionInventoryClientSession[];
  tmuxSessions: SessionInventoryTmuxSession[];
  tmuxStatus: { available: boolean; version: string | null; reason: string | null };
  updatedAt: number;
}

interface OpenInventoryResult {
  session: SessionInventoryClientSession;
  terminalSession: {
    sessionId: string;
    cols: number;
    rows: number;
    mode: TerminalMode;
    tmuxSessionName: string | null;
    activeProgram?: string | null;
    activeProgramRaw?: string | null;
    activeProgramSource?: 'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
    cwd?: string | null;
  };
  inventory: SessionInventory;
  reused: boolean;
}

class HttpStatusError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

const terminalSessions = new Map<string, TerminalSession>();
let globalSessionState: GlobalSessionState = { sessions: [], updatedAt: Date.now() };
// ── 持久化 globalSessionState 到磁盘，防止服务重启后丢失 ──
const GLOBAL_SESSION_STATE_FILE = `${TERMDOCK_DIR}/global-session-state.json`;
const CLIENT_STATES_FILE = `${TERMDOCK_DIR}/client-states.json`; // 保留用于迁移
let persistGlobalStateTimer: ReturnType<typeof setTimeout> | null = null;
let globalSessionStateWatcher: fs.FSWatcher | null = null;
let globalSessionStateReloadTimer: ReturnType<typeof setTimeout> | null = null;

// ── Control WebSocket: pushes the canonical client-state to every connected
// browser in real time. Each client gets a fresh snapshot on connect, then
// receives deltas on every mutation (PUT/DELETE client-state, dead-session
// reconciliation, etc.). Replaces the 5-second poll on the front-end. ──
const controlClients = new Map<string, WebSocket>();

let latestSessionInventory: SessionInventory | null = null;
let latestSessionInventoryAt = 0;
let sessionInventoryBuildPromise: Promise<SessionInventory> | null = null;
let broadcastInventorySeq = 0;
let broadcastClientStateTimer: ReturnType<typeof setTimeout> | null = null;
let broadcastClientStateInFlight = false;
let broadcastClientStateNeedsRerun = false;
let lastBroadcastClientStateSignature: string | null = null;
const inventoryOpenLocks = new Map<string, Promise<OpenInventoryResult>>();

const CONTROL_BROADCAST_COALESCE_MS = 50;
const SESSION_INVENTORY_CACHE_TTL_MS = 1500;

async function getSessionInventorySnapshot(options: { refresh?: boolean } = {}): Promise<SessionInventory> {
  const now = Date.now();
  if (!options.refresh && latestSessionInventory && now - latestSessionInventoryAt < SESSION_INVENTORY_CACHE_TTL_MS) {
    return latestSessionInventory;
  }
  if (!options.refresh && sessionInventoryBuildPromise) {
    return sessionInventoryBuildPromise;
  }
  const promise = buildSessionInventory()
    .then((inventory) => {
      latestSessionInventory = inventory;
      latestSessionInventoryAt = Date.now();
      return inventory;
    })
    .finally(() => {
      if (sessionInventoryBuildPromise === promise) sessionInventoryBuildPromise = null;
    });
  sessionInventoryBuildPromise = promise;
  return promise;
}

function getClientStateSemanticSignature(state: GlobalSessionState, inventory: SessionInventory | null | undefined): string {
  return JSON.stringify({
    sessions: state.sessions.map((session) => ({
      sessionId: session.sessionId,
      name: session.name,
      customName: session.customName === true,
      backendSessionId: session.backendSessionId,
      mode: session.mode,
      tmuxSessionName: session.tmuxSessionName,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
    })),
    inventory: inventory ? {
      clientSessions: inventory.clientSessions.map((session) => ({
        sessionId: session.sessionId,
        frontendSessionId: session.frontendSessionId,
        name: session.name,
        customName: session.customName === true,
        backendSessionId: session.backendSessionId,
        mode: session.mode,
        tmuxSessionName: session.tmuxSessionName,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        connected: session.connected,
        live: session.live,
        restorable: session.restorable,
      })),
      tmuxSessions: inventory.tmuxSessions.map((session) => ({
        name: session.name,
        windows: session.windows,
        attached: session.attached,
        attachedCount: session.attachedCount,
        createdAt: session.createdAt,
        boundFrontendSessionId: session.boundFrontendSessionId,
        connected: session.connected,
        live: session.live,
        restorable: session.restorable,
        friendlyName: session.friendlyName,
        label: session.label,
        program: session.program,
        cwd: session.cwd,
        clientCount: session.clientCount,
      })),
      tmuxStatus: inventory.tmuxStatus,
    } : null,
  });
}

function sendClientStatePayload(payload: string): void {
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

function broadcastControlEvent(payload: unknown): void {
  sendClientStatePayload(JSON.stringify(payload));
}

async function flushClientStateBroadcast(): Promise<void> {
  if (broadcastClientStateInFlight) {
    broadcastClientStateNeedsRerun = true;
    return;
  }

  broadcastClientStateInFlight = true;
  try {
    const inventory = await getSessionInventorySnapshot().catch((error) => {
      console.warn('[session-inventory] failed to build snapshot for broadcast:', getErrorMessage(error));
      return latestSessionInventory;
    });

    const effectiveInventory = inventory ?? latestSessionInventory;
    const signature = getClientStateSemanticSignature(globalSessionState, effectiveInventory);
    if (signature === lastBroadcastClientStateSignature) {
      return;
    }

    lastBroadcastClientStateSignature = signature;
    const seq = ++broadcastInventorySeq;
    sendClientStatePayload(JSON.stringify({
      type: 'client-state',
      seq,
      state: globalSessionState,
      inventory: effectiveInventory,
    }));
  } finally {
    broadcastClientStateInFlight = false;
    if (broadcastClientStateNeedsRerun) {
      broadcastClientStateNeedsRerun = false;
      broadcastClientState();
    }
  }
}

function broadcastClientState(): void {
  if (broadcastClientStateTimer) {
    return;
  }
  broadcastClientStateTimer = setTimeout(() => {
    broadcastClientStateTimer = null;
    void flushClientStateBroadcast();
  }, CONTROL_BROADCAST_COALESCE_MS);
  broadcastClientStateTimer.unref?.();
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

async function migrateFromClientStatesFile(): Promise<GlobalSessionState | null> {
  try {
    const data = await readJsonFileIfExists<Record<string, { sessions: unknown[] }>>(CLIENT_STATES_FILE);
    if (!data) return null;
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

async function loadGlobalSessionStateFromDisk(): Promise<void> {
  try {
    const data = await readJsonFileIfExists<GlobalSessionState>(GLOBAL_SESSION_STATE_FILE);
    if (data) {
      globalSessionState = {
        sessions: deduplicateGlobalSessions(
          (data.sessions || []).map(s => normalizePersistedClientSession(s)).filter((s): s is PersistedClientSession => s !== null)
        ),
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
      };
      console.log(`[session-persist] Loaded ${globalSessionState.sessions.length} sessions from global state`);
      return;
    }
    const migrated = await migrateFromClientStatesFile();
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

async function reloadGlobalSessionStateFromDisk(source: 'watch' | 'manual'): Promise<void> {
  try {
    const previous = JSON.stringify(globalSessionState);
    await loadGlobalSessionStateFromDisk();
    const next = JSON.stringify(globalSessionState);
    if (previous === next) {
      return;
    }
    console.log(`[session-persist] Reloaded global state from disk via ${source}`);
    broadcastClientState();
  } catch (error) {
    console.warn('[session-persist] Failed to reload global state:', getErrorMessage(error));
  }
}

function scheduleReloadGlobalSessionState(): void {
  if (globalSessionStateReloadTimer) {
    clearTimeout(globalSessionStateReloadTimer);
  }
  globalSessionStateReloadTimer = setTimeout(() => {
    globalSessionStateReloadTimer = null;
    void reloadGlobalSessionStateFromDisk('watch');
  }, 120);
  globalSessionStateReloadTimer.unref?.();
}

async function watchGlobalSessionStateFile(): Promise<void> {
  try {
    const dir = path.dirname(GLOBAL_SESSION_STATE_FILE);
    await fs.promises.mkdir(dir, { recursive: true });
    globalSessionStateWatcher?.close();
    globalSessionStateWatcher = fs.watch(dir, (_eventType, filename) => {
      if (filename !== path.basename(GLOBAL_SESSION_STATE_FILE)) {
        return;
      }
      scheduleReloadGlobalSessionState();
    });
    globalSessionStateWatcher.on('error', (error) => {
      console.warn('[session-persist] Global state watcher failed:', getErrorMessage(error));
    });
  } catch (error) {
    console.warn('[session-persist] Failed to watch global state file:', getErrorMessage(error));
  }
}

function schedulePersistGlobalState(): void {
  if (persistGlobalStateTimer) clearTimeout(persistGlobalStateTimer);
  persistGlobalStateTimer = setTimeout(() => {
    try {
      void writeJsonFile(GLOBAL_SESSION_STATE_FILE, globalSessionState).catch((error) => {
        console.warn('[session-persist] Failed to persist global state:', getErrorMessage(error));
      });
    } catch (error) {
      console.warn('[session-persist] Failed to persist global state:', getErrorMessage(error));
    }
  }, 200);
}

async function persistGlobalStateNow(): Promise<void> {
  if (persistGlobalStateTimer) {
    clearTimeout(persistGlobalStateTimer);
    persistGlobalStateTimer = null;
  }
  try {
    await writeJsonFile(GLOBAL_SESSION_STATE_FILE, globalSessionState);
  } catch (error) {
    console.warn('[session-persist] Failed to persist global state:', getErrorMessage(error));
  }
}

// 进程退出前立即刷盘，避免 tsx watch 重启导致状态丢失
function flushPersistAndExit(): void {
  if (persistGlobalStateTimer) {
    clearTimeout(persistGlobalStateTimer);
    persistGlobalStateTimer = null;
  }
  try {
    fs.mkdirSync(TERMDOCK_DIR, { recursive: true });
    fs.writeFileSync(GLOBAL_SESSION_STATE_FILE, JSON.stringify(globalSessionState, null, 2), 'utf-8');
  } catch { /* best effort */ }
}
process.on('SIGTERM', () => { flushPersistAndExit(); void persistToolbarPresetsNow(); caffeinateManager.shutdown(); process.exit(0); });
process.on('SIGINT', () => { flushPersistAndExit(); void persistToolbarPresetsNow(); caffeinateManager.shutdown(); process.exit(0); });

// 服务启动时从磁盘加载（带去重，防止历史累积的重复条目复活）
void (async () => {
  await loadGlobalSessionStateFromDisk();
  await watchGlobalSessionStateFile();
  pruneOrphanSessions();
  await backfillPersistedTmuxMetadata();
})();
caffeinateManager.startNetworkMonitor();

// 清理磁盘恢复后后端已不存在的 session 引用。
// 服务重启时 terminalSessions 是空的，持久化的 global state
// 全部指向已销毁的 session。shell session 的 PTY 已死无法复用，直接删除；
// tmux session 的 tmux 进程独立于 termdock，保留条目但清空 backendSessionId。
function pruneOrphanSessions(): void {
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
}

// On boot, backfill termdock metadata onto every tmux session referenced by
// the persisted client states. Lets `termdock --tls` work the first time
// after upgrading from a version that didn't write `@termdock-*`.
// Dynamic fields (label/program/cwd/last-active-at) are intentionally left
// for the per-session polling to fill in lazily.
async function backfillPersistedTmuxMetadata(): Promise<void> {
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
}

// ── end persistence ──

// ── Toolbar presets persistence (shared across all clients) ──
// Stored as a single JSON document at ~/.termdock/toolbar-presets.json.
// The schema is intentionally opaque to the server: it just round-trips
// `presets` (array) and `version` (number) so the client owns all merge /
// upgrade logic. The whole document is global (not keyed by clientId) so
// every browser pointing at this server sees the same toolbar config.
const TOOLBAR_PRESETS_FILE = `${TERMDOCK_DIR}/toolbar-presets.json`;
interface ToolbarPresetsDoc {
  version: number;
  presets: unknown[];
  updatedAt: number;
}
let toolbarPresetsDoc: ToolbarPresetsDoc | null = null;
let persistToolbarPresetsTimer: ReturnType<typeof setTimeout> | null = null;

async function loadToolbarPresetsFromDisk(): Promise<void> {
  try {
    const parsed = await readJsonFileIfExists<Partial<ToolbarPresetsDoc>>(TOOLBAR_PRESETS_FILE);
    if (parsed) {
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

async function persistToolbarPresetsNow(): Promise<void> {
  if (!toolbarPresetsDoc) return;
  try {
    await writeJsonFile(TOOLBAR_PRESETS_FILE, toolbarPresetsDoc);
  } catch (error) {
    console.warn('[toolbar-presets] Failed to persist:', getErrorMessage(error));
  }
}

function schedulePersistToolbarPresets(): void {
  if (persistToolbarPresetsTimer) clearTimeout(persistToolbarPresetsTimer);
  persistToolbarPresetsTimer = setTimeout(() => { void persistToolbarPresetsNow(); }, 200);
}

void loadToolbarPresetsFromDisk();
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
const FLOW_CONTROL_PAUSE_LEASE_MS = parseInt(process.env.TERMINAL_FLOW_CONTROL_PAUSE_LEASE_MS || '15000', 10);
const TMUX_DELIMITER = '\x1f';
const parsedTmuxHistoryLimit = Number.parseInt(process.env.TERMDOCK_TMUX_HISTORY_LIMIT || '10000', 10);
const TERMDOCK_TMUX_HISTORY_LIMIT = Number.isFinite(parsedTmuxHistoryLimit) && parsedTmuxHistoryLimit > 0
  ? parsedTmuxHistoryLimit
  : 10000;
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
    cwd: typeof candidate.cwd === 'string' && candidate.cwd.trim().length > 0
      ? candidate.cwd
      : null,
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

function parseNumberOption(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

interface TmuxRuntimeMetadata {
  program: string | null;
  cwd: string | null;
  label: string;
}

function isTermdockManagedTmuxSession(session: TmuxInventoryMeta): boolean {
  return !!(session.version || session.host || session.pid || session.createdAt || session.lastActiveAt || session.label || session.program || session.cwd || session.guiDetachedAt);
}

function normalizeMetadataProgram(program: string | null | undefined): string | null {
  return normalizeTmuxMetadataProgram(program, { shellNames: shellNamesBackend });
}

function getActivePaneFromLayout(layout: TmuxLayout): TmuxPane | null {
  const activeWindow = layout.windows.find((window) => window.id === layout.activeWindowId);
  return activeWindow?.panes.find((pane) => pane.id === layout.activePaneId) ?? null;
}

function buildRuntimeTmuxMetadata(input: {
  tmuxSessionName: string;
  program: string | null;
  cwd: string | null;
}): TmuxRuntimeMetadata {
  const program = normalizeMetadataProgram(input.program);
  const cwd = input.cwd ?? null;
  const friendlyName = findFriendlyNameForTmuxSession(input.tmuxSessionName);
  const label = buildTermdockLabel({
    friendlyName,
    program,
    cwd,
    sessionName: input.tmuxSessionName,
  });
  return { program, cwd, label };
}

function maybeRepairTmuxOptions(sessionName: string, current: {
  program: string | null;
  cwd: string | null;
  label: string | null;
}, next: TmuxRuntimeMetadata): void {
  const currentSnapshot = {
    program: current.program ?? null,
    cwd: current.cwd ?? null,
    label: current.label ?? '',
  };
  if (!tmuxMetadataChanged(currentSnapshot, next)) {
    return;
  }
  void setTmuxOptions(sessionName, {
    '@termdock-label': next.label,
    '@termdock-program': next.program ?? '',
    '@termdock-cwd': next.cwd ?? '',
    '@termdock-last-active-at': String(Date.now()),
  });
}

function makeTerminalSessionPayload(
  backendSessionId: string,
  session: TerminalSession,
  cols = 80,
  rows = 24,
): OpenInventoryResult['terminalSession'] {
  return {
    sessionId: backendSessionId,
    cols,
    rows,
    mode: session.mode,
    tmuxSessionName: session.tmuxSessionName,
    activeProgram: session.activeProgram?.command ?? null,
    activeProgramRaw: session.activeProgram?.rawArgs ?? null,
    activeProgramSource: session.activeProgram?.source ?? null,
    cwd: session.cwd ?? null,
  };
}

function findBackendSessionForTmux(tmuxSessionName: string): [string, TerminalSession] | null {
  for (const entry of terminalSessions.entries()) {
    const [, session] = entry;
    if (session.mode === 'tmux' && session.tmuxSessionName === tmuxSessionName) {
      return entry;
    }
  }
  return null;
}

function persistAndBroadcastGlobalState(): void {
  globalSessionState = {
    sessions: deduplicateGlobalSessions(globalSessionState.sessions),
    updatedAt: Date.now(),
  };
  schedulePersistGlobalState();
  broadcastClientState();
}

function makeInventoryOpenLockKey(input: {
  preferredFrontendSessionId?: unknown;
  mode?: unknown;
  tmuxSessionName?: unknown;
  createIfEmpty?: unknown;
}): string {
  const preferredFrontendSessionId = typeof input.preferredFrontendSessionId === 'string'
    ? input.preferredFrontendSessionId.trim()
    : '';
  if (preferredFrontendSessionId) {
    return `frontend:${preferredFrontendSessionId}`;
  }

  if (input.createIfEmpty === true) {
    return 'default-if-empty';
  }

  const mode = normalizeMode(input.mode);
  if (mode === 'tmux') {
    const rawTmuxName = typeof input.tmuxSessionName === 'string'
      ? input.tmuxSessionName.trim()
      : '';
    if (rawTmuxName) {
      return `tmux:${rawTmuxName}`;
    }
  }

  return `new:${randomUUID()}`;
}

async function withInventoryOpenLock(
  key: string,
  task: () => Promise<OpenInventoryResult>,
): Promise<OpenInventoryResult> {
  const previous = inventoryOpenLocks.get(key);
  if (previous) {
    return previous;
  }

  let pending!: Promise<OpenInventoryResult>;
  pending = task().finally(() => {
    if (inventoryOpenLocks.get(key) === pending) {
      inventoryOpenLocks.delete(key);
    }
  });
  inventoryOpenLocks.set(key, pending);
  return pending;
}

function upsertGlobalSessionRecord(record: PersistedClientSession): PersistedClientSession {
  const normalized = normalizePersistedClientSession(record);
  if (!normalized) {
    throw new Error('invalid session record');
  }

  const next: PersistedClientSession[] = [];
  let replaced = false;
  for (const existing of globalSessionState.sessions) {
    if (existing.sessionId === normalized.sessionId) {
      next.push(normalized);
      replaced = true;
      continue;
    }
    if (
      normalized.mode === 'tmux' &&
      normalized.tmuxSessionName &&
      existing.mode === 'tmux' &&
      existing.tmuxSessionName === normalized.tmuxSessionName
    ) {
      continue;
    }
    next.push(existing);
  }
  if (!replaced) {
    next.push(normalized);
  }

  globalSessionState = {
    sessions: deduplicateGlobalSessions(next),
    updatedAt: Date.now(),
  };
  return normalized;
}

function removeGlobalSessionRecord(frontendSessionId: string): boolean {
  const before = globalSessionState.sessions.length;
  globalSessionState = {
    sessions: globalSessionState.sessions.filter((session) => session.sessionId !== frontendSessionId),
    updatedAt: Date.now(),
  };
  return globalSessionState.sessions.length !== before;
}

function getTrustedCwdFromRecord(record: PersistedClientSession): string | undefined {
  return typeof record.cwd === 'string' && record.cwd.trim().length > 0
    ? record.cwd
    : undefined;
}

async function markAllPersistedTmuxSessionsDetached(): Promise<void> {
  const detachedAt = String(Date.now());
  const tmuxSessionNames = new Set(
    globalSessionState.sessions
      .map((session) => session.mode === 'tmux' ? session.tmuxSessionName : null)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
  try {
    const liveTmuxSessions = await listLiveTmuxInventorySessions();
    for (const tmux of liveTmuxSessions) {
      if (isTermdockManagedTmuxSession(tmux)) {
        tmuxSessionNames.add(tmux.name);
      }
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (!isTmuxServerMissingMessage(errorMessage)) {
      console.warn('[session-inventory] failed to list tmux sessions for clear-all:', errorMessage);
    }
  }
  await Promise.all(Array.from(tmuxSessionNames).map((tmuxSessionName) =>
    setTmuxOption(tmuxSessionName, TERMDOCK_GUI_DETACHED_AT_OPTION, detachedAt),
  ));
}

function getClientSessionView(inventory: SessionInventory, frontendSessionId: string): SessionInventoryClientSession {
  const session = inventory.clientSessions.find((entry) => entry.sessionId === frontendSessionId);
  if (!session) {
    throw new Error(`session inventory entry missing after mutation: ${frontendSessionId}`);
  }
  return session;
}

async function ensureBackendSessionForRecord(
  req: express.Request,
  record: PersistedClientSession,
  options: { cwd?: string; cols?: number; rows?: number; termType?: string; allowDefaultCwd?: boolean } = {},
): Promise<{ backendSessionId: string; session: TerminalSession; cols: number; rows: number; changed: boolean }> {
  if (record.backendSessionId) {
    const existing = terminalSessions.get(record.backendSessionId);
    if (existing) {
      record.cwd = existing.cwd ?? record.cwd ?? null;
      return {
        backendSessionId: record.backendSessionId,
        session: existing,
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        changed: false,
      };
    }
  }

  if (record.mode === 'tmux' && record.tmuxSessionName) {
    await unsetTmuxOption(record.tmuxSessionName, TERMDOCK_GUI_DETACHED_AT_OPTION);
    const existingTmuxBackend = findBackendSessionForTmux(record.tmuxSessionName);
    if (existingTmuxBackend) {
      const [backendSessionId, session] = existingTmuxBackend;
      await prepareManagedTmuxSession(record.tmuxSessionName, options.cwd);
      record.backendSessionId = backendSessionId;
      record.cwd = session.cwd ?? record.cwd ?? null;
      record.lastActivity = Date.now();
      return {
        backendSessionId,
        session,
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        changed: true,
      };
    }
  }

  let spawnCwd = options.cwd ?? getTrustedCwdFromRecord(record);
  if (!spawnCwd && record.mode === 'tmux' && record.tmuxSessionName) {
    try {
      const metadata = await resolveLiveTmuxMetadata(record.tmuxSessionName);
      spawnCwd = metadata?.cwd ?? undefined;
      if (spawnCwd) {
        record.cwd = spawnCwd;
      }
    } catch {
      // If the tmux target is gone and no cwd was remembered, the persisted
      // record is stale. Avoid silently recreating it in the user's home dir.
    }
  }

  if (!spawnCwd && options.allowDefaultCwd !== true) {
    if (removeGlobalSessionRecord(record.sessionId)) {
      persistAndBroadcastGlobalState();
    }
    throw new HttpStatusError(
      410,
      'session can no longer be restored without a working directory',
      'STALE_SESSION_RESTORE_REJECTED',
    );
  }

  const spawned = await spawnTerminalSession(req, {
    cwd: spawnCwd,
    cols: options.cols,
    rows: options.rows,
    mode: record.mode,
    tmuxSessionName: record.tmuxSessionName ?? undefined,
    termType: options.termType,
  });
  record.backendSessionId = spawned.sessionId;
  record.mode = spawned.session.mode;
  record.tmuxSessionName = spawned.session.tmuxSessionName;
  record.cwd = spawned.session.cwd ?? spawnCwd ?? record.cwd ?? null;
  record.lastActivity = Date.now();
  return {
    backendSessionId: spawned.sessionId,
    session: spawned.session,
    cols: spawned.cols,
    rows: spawned.rows,
    changed: true,
  };
}

function updateGlobalBindingForBackendSession(
  backendSessionId: string,
  patch: Partial<Pick<PersistedClientSession, 'backendSessionId' | 'tmuxSessionName' | 'mode' | 'lastActivity' | 'cwd'>>,
): boolean {
  const idx = globalSessionState.sessions.findIndex((session) => session.backendSessionId === backendSessionId);
  if (idx < 0) return false;

  const current = globalSessionState.sessions[idx];
  const updated: PersistedClientSession = {
    ...current,
    ...patch,
    backendSessionId: patch.backendSessionId === undefined ? current.backendSessionId : patch.backendSessionId,
    tmuxSessionName: patch.tmuxSessionName === undefined ? current.tmuxSessionName : patch.tmuxSessionName,
    mode: patch.mode ?? current.mode,
    cwd: patch.cwd === undefined ? current.cwd : patch.cwd,
    lastActivity: patch.lastActivity ?? Date.now(),
  };
  upsertGlobalSessionRecord(updated);
  return true;
}

async function openInventorySession(
  req: express.Request,
  input: {
    preferredFrontendSessionId?: unknown;
    name?: unknown;
    customName?: unknown;
    mode?: unknown;
    tmuxSessionName?: unknown;
    cwd?: unknown;
    cols?: unknown;
    rows?: unknown;
    termType?: unknown;
    createIfEmpty?: unknown;
    requireExisting?: unknown;
  },
): Promise<OpenInventoryResult> {
  const normalizedMode = normalizeMode(input.mode);
  const normalizedTmuxName = normalizedMode === 'tmux'
    ? normalizeTmuxSessionName(input.tmuxSessionName)
    : null;
  const preferredFrontendSessionId = typeof input.preferredFrontendSessionId === 'string'
    ? input.preferredFrontendSessionId.trim()
    : '';
  const createIfEmpty = input.createIfEmpty === true;
  const requireExisting = input.requireExisting === true;
  const now = Date.now();

  let record = preferredFrontendSessionId
    ? globalSessionState.sessions.find((session) => session.sessionId === preferredFrontendSessionId) ?? null
    : null;
  let reused = !!record;

  if (!record && normalizedMode === 'tmux' && normalizedTmuxName) {
    record = globalSessionState.sessions.find(
      (session) => session.mode === 'tmux' && session.tmuxSessionName === normalizedTmuxName,
    ) ?? null;
    reused = !!record;
  }

  if (!record && createIfEmpty && globalSessionState.sessions.length === 0) {
    await getSessionInventorySnapshot({ refresh: true });
    if (globalSessionState.sessions.length > 0) {
      record = [...globalSessionState.sessions]
        .sort((a, b) => b.lastActivity - a.lastActivity)[0] ?? null;
      reused = !!record;
    }
  }

  if (!record && createIfEmpty && globalSessionState.sessions.length > 0) {
    record = [...globalSessionState.sessions]
      .sort((a, b) => b.lastActivity - a.lastActivity)[0] ?? null;
    reused = !!record;
  }

  if (!record && requireExisting) {
    throw new HttpStatusError(404, 'session not found');
  }

  if (!record) {
    const sessionId = preferredFrontendSessionId || randomUUID();
    const defaultName = normalizedMode === 'tmux' && normalizedTmuxName
      ? `tmux:${normalizedTmuxName}`
      : `terminal-${now.toString(36)}`;
    const name = typeof input.name === 'string' && input.name.trim().length > 0
      ? input.name.trim()
      : defaultName;
    record = {
      sessionId,
      name,
      customName: input.customName === true ? true : undefined,
      backendSessionId: null,
      mode: normalizedMode,
      tmuxSessionName: normalizedTmuxName,
      createdAt: now,
      lastActivity: now,
    };
  } else {
    record = { ...record };
    record.lastActivity = now;
    if (record.mode === 'tmux' && !record.tmuxSessionName && normalizedTmuxName) {
      record.tmuxSessionName = normalizedTmuxName;
    }
  }

  const requestedCwd = typeof input.cwd === 'string' && input.cwd.trim().length > 0
    ? input.cwd
    : undefined;
  const cols = typeof input.cols === 'number' && Number.isFinite(input.cols) ? Math.floor(input.cols) : undefined;
  const rows = typeof input.rows === 'number' && Number.isFinite(input.rows) ? Math.floor(input.rows) : undefined;
  const termType = typeof input.termType === 'string' ? input.termType : undefined;
  const allowDefaultCwd = !reused && preferredFrontendSessionId.length === 0;
  const backend = await ensureBackendSessionForRecord(req, record, { cwd: requestedCwd, cols, rows, termType, allowDefaultCwd });
  const savedRecord = upsertGlobalSessionRecord(record);
  persistAndBroadcastGlobalState();

  if (savedRecord.mode === 'tmux' && savedRecord.tmuxSessionName) {
    void setTmuxOptions(savedRecord.tmuxSessionName, {
      '@termdock-version': TERMDOCK_VERSION,
      '@termdock-host': TERMDOCK_HOST,
      '@termdock-pid': TERMDOCK_PID,
    });
  }

  const inventory = await getSessionInventorySnapshot({ refresh: true });
  return {
    session: getClientSessionView(inventory, savedRecord.sessionId),
    terminalSession: makeTerminalSessionPayload(backend.backendSessionId, backend.session, backend.cols, backend.rows),
    inventory,
    reused,
  };
}

function getTmuxBinary(): string {
  return process.env.TMUX_BIN || 'tmux';
}

async function runTmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(getTmuxBinary(), args, {
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
  const process = spawn(getTmuxBinary(), ['-C', 'attach', '-t', sessionName], {
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
  const child = execFile(getTmuxBinary(), args, { timeout: 5000 });
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

function isTmuxServerMissingMessage(errorMessage: string): boolean {
  return /no server running|error connecting to .*\(No such file or directory\)/i.test(errorMessage);
}

function isTmuxSessionMissingMessage(errorMessage: string): boolean {
  return /can't find session|session not found/i.test(errorMessage) || isTmuxServerMissingMessage(errorMessage);
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
  await runTmux([
    'bind-key', '-n', 'MouseDown1Pane',
    "select-pane -t= ; set-option -p -F @termdock-mouse-down-x '#{mouse_x}' ; set-option -p -F @termdock-mouse-down-y '#{mouse_y}' ; if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M'",
  ]);
  await runTmux([
    'bind-key', '-n', 'MouseDrag1Pane',
    "if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'if-shell -F \"#{||:#{e|>=:#{e|-:#{mouse_x},#{@termdock-mouse-down-x}},1},#{e|>=:#{e|-:#{@termdock-mouse-down-x},#{mouse_x}},1},#{e|>=:#{e|-:#{mouse_y},#{@termdock-mouse-down-y}},1},#{e|>=:#{e|-:#{@termdock-mouse-down-y},#{mouse_y}},1}}\" \"copy-mode -M\"'",
  ]);

  // tmux defaults MouseDragEnd1Pane in copy-mode to copy-pipe-and-cancel:
  // selecting text with the mouse copies successfully, then immediately exits
  // copy-mode on button release. Termdock keeps copy-mode open so users can
  // continue inspecting scrollback after one selection.
  for (const table of ['copy-mode', 'copy-mode-vi']) {
    try {
      await runTmux(['bind-key', '-T', table, 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-pipe-no-clear']);
    } catch {
      await runTmux(['bind-key', '-T', table, 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-selection']);
    }
  }
}

async function applyTmuxScrollbackProfile(sessionName?: string): Promise<void> {
  const commands: string[][] = [
    ['set-option', '-g', 'history-limit', String(TERMDOCK_TMUX_HISTORY_LIMIT)],
    ['set-option', '-gw', 'scroll-on-clear', 'off'],
  ];
  if (sessionName) {
    commands.push(
      ['set-option', '-t', sessionName, 'history-limit', String(TERMDOCK_TMUX_HISTORY_LIMIT)],
    );
  }

  for (const args of commands) {
    try {
      await runTmux(args);
    } catch (error) {
      console.warn(`[tmux] failed to apply scrollback profile (${args.join(' ')}): ${getErrorMessage(error)}`);
    }
  }

  if (!sessionName) return;

  try {
    const windowsRaw = await runTmux(['list-windows', '-t', sessionName, '-F', '#{window_id}']);
    const windowIds = windowsRaw.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const windowId of windowIds) {
      try {
        await runTmux(['set-option', '-w', '-t', windowId, 'scroll-on-clear', 'off']);
      } catch (error) {
        console.warn(`[tmux] failed to disable scroll-on-clear for ${windowId}: ${getErrorMessage(error)}`);
      }
    }
  } catch (error) {
    console.warn(`[tmux] failed to list windows for scrollback profile on ${sessionName}: ${getErrorMessage(error)}`);
  }
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
    const errorMessage = getErrorMessage(error);
    if (isTmuxSessionMissingMessage(errorMessage)) {
      return;
    }
    console.warn(
      `[tmux] failed to unset option ${key} on ${sessionName}: ${errorMessage}`,
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

async function ensureTmuxColorEnvironment(sessionName?: string): Promise<void> {
  const forceColor = process.env.TERMDOCK_FORCE_COLOR === '1';
  await runTmux(['set-environment', '-g', 'COLORTERM', 'truecolor']);
  if (forceColor) {
    await runTmux(['set-environment', '-g', 'FORCE_COLOR', '1']);
    await runTmux(['set-environment', '-g', '-u', 'NO_COLOR']);
  } else {
    // Clear the legacy Termdock override so tmux sessions can respect user color prefs.
    await runTmux(['set-environment', '-g', '-u', 'FORCE_COLOR']);
  }
  if (sessionName) {
    await runTmux(['set-environment', '-t', sessionName, 'COLORTERM', 'truecolor']);
    if (forceColor) {
      await runTmux(['set-environment', '-t', sessionName, 'FORCE_COLOR', '1']);
      await runTmux(['set-environment', '-t', sessionName, '-u', 'NO_COLOR']);
    } else {
      await runTmux(['set-environment', '-t', sessionName, '-u', 'FORCE_COLOR']);
    }
  }
}

async function listLiveTmuxInventorySessions(): Promise<TmuxInventoryMeta[]> {
  const format = [
    '#{session_name}',
    '#{session_windows}',
    '#{session_attached}',
    '#{@termdock-friendly-name}',
    '#{@termdock-program}',
    '#{@termdock-cwd}',
    '#{@termdock-label}',
    '#{@termdock-client-count}',
    '#{@termdock-host}',
    '#{@termdock-pid}',
    '#{@termdock-version}',
    '#{@termdock-created-at}',
    '#{@termdock-last-active-at}',
    `#{${TERMDOCK_GUI_DETACHED_AT_OPTION}}`,
  ].join(TMUX_DELIMITER);

  try {
    const raw = await runTmux(['list-sessions', '-F', format]);
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseDelimitedRow(line, 14))
      .filter((row): row is string[] => row !== null)
      .map(([
        name,
        windowsRaw,
        attachedRaw,
        friendlyName,
        program,
        cwd,
        label,
        clientCountRaw,
        host,
        pidRaw,
        version,
        createdAtRaw,
        lastActiveAtRaw,
        guiDetachedAtRaw,
      ]) => ({
        name,
        windows: Number.parseInt(windowsRaw || '0', 10) || 0,
        attachedCount: Number.parseInt(attachedRaw || '0', 10) || 0,
        friendlyName: friendlyName || null,
        program: program || null,
        cwd: cwd || null,
        label: label || null,
        clientCount: parseNumberOption(clientCountRaw),
        host: host || null,
        pid: parseNumberOption(pidRaw),
        version: version || null,
        createdAt: parseNumberOption(createdAtRaw),
        lastActiveAt: parseNumberOption(lastActiveAtRaw),
        guiDetachedAt: parseNumberOption(guiDetachedAtRaw),
      }))
      .sort((a, b) => {
        const aCreated = a.createdAt ?? Number.POSITIVE_INFINITY;
        const bCreated = b.createdAt ?? Number.POSITIVE_INFINITY;
        if (aCreated !== bCreated) return aCreated - bCreated;
        return a.name.localeCompare(b.name);
      });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (isTmuxServerMissingMessage(errorMessage)) {
      return [];
    }
    throw error;
  }
}

async function buildSessionInventory(): Promise<SessionInventory> {
  const tmuxStatus = await getTmuxStatus();
  let liveTmuxSessions: TmuxInventoryMeta[] = [];
  if (tmuxStatus.available) {
    try {
      liveTmuxSessions = await listLiveTmuxInventorySessions();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (!isTmuxServerMissingMessage(errorMessage)) {
        console.warn('[session-inventory] failed to list tmux sessions:', errorMessage);
      }
      liveTmuxSessions = [];
    }
  }

  const refreshedTmuxSessions = await Promise.all(liveTmuxSessions.map(async (tmux): Promise<TmuxInventoryMeta> => {
    if (!isTermdockManagedTmuxSession(tmux)) {
      return tmux;
    }

    try {
      const metadata = await resolveLiveTmuxMetadata(tmux.name);
      if (!metadata) {
        return tmux;
      }
      maybeRepairTmuxOptions(tmux.name, tmux, metadata);
      return {
        ...tmux,
        program: metadata.program,
        cwd: metadata.cwd,
        label: metadata.label,
        lastActiveAt: Date.now(),
      };
    } catch {
      return tmux;
    }
  }));

  let discoveredManagedTmuxSession = false;
  for (const tmux of refreshedTmuxSessions) {
    if (!isTermdockManagedTmuxSession(tmux)) continue;
    if (tmux.guiDetachedAt !== null) continue;
    const exists = globalSessionState.sessions.some((session) =>
      session.mode === 'tmux' && session.tmuxSessionName === tmux.name,
    );
    if (exists) continue;

    const liveBackend = findBackendSessionForTmux(tmux.name);
    const friendlyName = tmux.friendlyName?.trim() || null;
    upsertGlobalSessionRecord({
      sessionId: randomUUID(),
      name: friendlyName ?? `tmux:${tmux.name}`,
      customName: friendlyName ? true : undefined,
      backendSessionId: liveBackend?.[0] ?? null,
      mode: 'tmux',
      tmuxSessionName: tmux.name,
      createdAt: tmux.createdAt ?? Date.now(),
      lastActivity: tmux.lastActiveAt ?? Date.now(),
    });
    discoveredManagedTmuxSession = true;
  }
  if (discoveredManagedTmuxSession) {
    schedulePersistGlobalState();
  }

  const liveTmuxByName = new Map(refreshedTmuxSessions.map((session) => [session.name, session]));
  let synchronizedTmuxFriendlyName = false;
  globalSessionState = {
    sessions: globalSessionState.sessions.map((session) => {
      if (session.mode !== 'tmux' || !session.tmuxSessionName) {
        return session;
      }
      const friendlyName = liveTmuxByName.get(session.tmuxSessionName)?.friendlyName?.trim();
      if (!friendlyName) {
        return session;
      }
      if (session.customName === true && session.name === friendlyName) {
        return session;
      }
      synchronizedTmuxFriendlyName = true;
      return {
        ...session,
        name: friendlyName,
        customName: true,
      };
    }),
    updatedAt: synchronizedTmuxFriendlyName ? Date.now() : globalSessionState.updatedAt,
  };
  if (synchronizedTmuxFriendlyName) {
    schedulePersistGlobalState();
  }

  const clientSessions = globalSessionState.sessions.map((session): SessionInventoryClientSession => {
    const backendLive = !!session.backendSessionId && terminalSessions.has(session.backendSessionId);
    const tmuxLive = session.mode === 'tmux' && !!session.tmuxSessionName && liveTmuxByName.has(session.tmuxSessionName);
    const live = session.mode === 'tmux' ? tmuxLive : backendLive;

    // 展示名提示（activeProgram / cwd）：优先取在线 backend session 的实时值，
    // 其次回退到 tmux 清单里的 program/cwd（tmux 模式即使 backend 未 attach，
    // tmux 服务端仍能给出当前 pane 的程序与目录）。让前端 hydrate 即可显示。
    const backend = backendLive ? terminalSessions.get(session.backendSessionId!) : undefined;
    const tmuxMeta = session.tmuxSessionName ? liveTmuxByName.get(session.tmuxSessionName) : undefined;
    const activeProgram = backend?.activeProgram?.command ?? tmuxMeta?.program ?? null;
    const cwd = backend?.cwd ?? tmuxMeta?.cwd ?? null;

    return {
      ...session,
      frontendSessionId: session.sessionId,
      customName: session.customName === true,
      connected: backendLive,
      live,
      restorable: session.mode === 'tmux' && tmuxLive && !backendLive,
      activeProgram,
      cwd,
    };
  });

  const clientByTmux = new Map<string, SessionInventoryClientSession>();
  for (const session of clientSessions) {
    if (session.mode === 'tmux' && session.tmuxSessionName && !clientByTmux.has(session.tmuxSessionName)) {
      clientByTmux.set(session.tmuxSessionName, session);
    }
  }

  const tmuxOrder = new Map<string, number>();
  globalSessionState.sessions.forEach((session, index) => {
    if (session.mode === 'tmux' && session.tmuxSessionName && !tmuxOrder.has(session.tmuxSessionName)) {
      tmuxOrder.set(session.tmuxSessionName, index);
    }
  });

  const tmuxSessions = refreshedTmuxSessions
    .slice()
    .sort((a, b) => {
      const aRank = tmuxOrder.get(a.name) ?? Number.POSITIVE_INFINITY;
      const bRank = tmuxOrder.get(b.name) ?? Number.POSITIVE_INFINITY;
      if (aRank !== bRank) return aRank - bRank;
      const aCreated = a.createdAt ?? Number.POSITIVE_INFINITY;
      const bCreated = b.createdAt ?? Number.POSITIVE_INFINITY;
      if (aCreated !== bCreated) return aCreated - bCreated;
      return a.name.localeCompare(b.name);
    })
    .map((tmux): SessionInventoryTmuxSession => {
    const bound = clientByTmux.get(tmux.name) ?? null;
    return {
      name: tmux.name,
      windows: tmux.windows,
      attached: tmux.attachedCount,
      attachedCount: tmux.attachedCount,
      createdAt: tmux.createdAt,
      boundFrontendSessionId: bound?.sessionId ?? null,
      connected: bound?.connected === true,
      live: true,
      restorable: bound?.restorable === true,
      friendlyName: tmux.friendlyName,
      label: tmux.label,
      program: tmux.program,
      cwd: tmux.cwd,
      clientCount: tmux.clientCount,
      lastActiveAt: tmux.lastActiveAt,
    };
  });

  return {
    clientSessions,
    tmuxSessions,
    tmuxStatus,
    updatedAt: Date.now(),
  };
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

// ── OSC sniffing for CWD tracking + prompt state + title ──

const OSC_SNIFF_CAP = 32768; // 32 KB rolling buffer

// Match all OSC sequences we care about:
//   OSC 0;... / OSC 2;...  → title (may contain cwd or command name)
//   OSC 7;...              → cwd report (kitty-shell-cwd://host/path)
//   OSC 133;A / P          → prompt start (idle)
//   OSC 133;C              → command start (running)
//   OSC 133;D[;exitcode]   → command end (idle, with optional exit code)
const OSC_ANY_PATTERN = /\x1b\](\d+);([^\x07\x1b]*)(\x07|\x1b\\)/g;

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

function parseOsc7Cwd(data: string, home: string): string | null {
  // Format: kitty-shell-cwd://hostname/path or file://hostname/path
  const match = data.match(/^(?:kitty-shell-cwd|file):\/\/[^/]+(.+)/i);
  if (match) {
    const p = match[1];
    if (p.startsWith('~/')) return home + p.slice(1);
    if (p.startsWith('/')) return p;
  }
  return null;
}

export interface OscSniffResult {
  cwd: string | null;
  title: string | null;
  promptState: 'idle' | 'running' | null;
  exitCode: number | null;
  tuiProgress: TuiProgressReport | null;
  remaining: string;
}

function parseConEmuProgressReport(data: string): TuiProgressReport | null {
  if (!data.startsWith('4;') || data.length < 3) return null;
  const stateCode = data[2];
  const state = stateCode === '0'
    ? 'remove'
    : stateCode === '1'
      ? 'set'
      : stateCode === '2'
        ? 'error'
        : stateCode === '3'
          ? 'indeterminate'
          : stateCode === '4'
            ? 'pause'
            : null;
  if (!state) return null;

  let progress: number | null = null;
  if ((state === 'set' || state === 'error' || state === 'pause') && data[3] === ';') {
    const value = Number.parseInt(data.slice(4), 10);
    if (Number.isFinite(value)) {
      progress = Math.min(100, Math.max(0, value));
    }
  }

  return { state, progress };
}

function sniffOsc(buf: string, home: string): OscSniffResult {
  let match: RegExpExecArray | null;
  let lastCwd: string | null = null;
  let lastTitle: string | null = null;
  let promptState: 'idle' | 'running' | null = null;
  let exitCode: number | null = null;
  let tuiProgress: TuiProgressReport | null = null;
  let lastMatchEnd = 0;

  OSC_ANY_PATTERN.lastIndex = 0;

  while ((match = OSC_ANY_PATTERN.exec(buf)) !== null) {
    const oscNum = match[1];
    const oscData = match[2] || '';
    lastMatchEnd = match.index + match[0].length;

    if (oscNum === '0' || oscNum === '2') {
      // Title — could be cwd or command name
      lastTitle = oscData;
      const cwd = parseTitleCwd(oscData, home);
      if (cwd) lastCwd = cwd;
    } else if (oscNum === '7') {
      // CWD report
      const cwd = parseOsc7Cwd(oscData, home);
      if (cwd) lastCwd = cwd;
    } else if (oscNum === '133') {
      // Semantic prompt marks
      if (oscData.startsWith('C')) {
        promptState = 'running';
      } else if (oscData.startsWith('D')) {
        promptState = 'idle';
        // Parse optional exit code: 133;D;exitcode
        const parts = oscData.split(';');
        if (parts.length >= 2) {
          const code = parseInt(parts[1], 10);
          if (!isNaN(code)) exitCode = code;
        }
      } else if (oscData.startsWith('A') || oscData.startsWith('P')) {
        promptState = 'idle';
      }
    } else if (oscNum === '9') {
      const progress = parseConEmuProgressReport(oscData);
      if (progress) tuiProgress = progress;
    }
  }

  const remaining = buf.slice(lastMatchEnd).slice(-128);

  return { cwd: lastCwd, title: lastTitle, promptState, exitCode, tuiProgress, remaining };
}

// ── end OSC sniffing ──

// ── Agent status detection for AI coding tools (DISABLED — see setupPtyHandlers) ──

// const AGENT_BUF_CAP = 4096;  // 滚动缓冲区容量

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
const COCO_WAITING_RULE_PATTERN = '(?:Tab/Arrow keys to navigate[\\s\\S]{0,200}(?:select ·|Enter))|Coco\\s*等待态采样';

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
      { pattern: '~ Asking questions', status: 'waiting', color: '#facc15', indicator: 'question', clearDelayMs: 10000 },
    ],
  },
  {
    program: 'coco',
    rules: [
      { pattern: COCO_WAITING_RULE_PATTERN, status: 'waiting', color: '#facc15', indicator: 'question', clearDelayMs: 10000 },
      { pattern: '[·✢❋❇✽] (thinking|working|generating)', status: 'running', color: '#4ade80', indicator: 'spinner', clearDelayMs: 700 },
    ],
  },
];

function isSameAgentRule(a: AgentRule, b: AgentRule): boolean {
  return a.pattern === b.pattern &&
    a.status === b.status &&
    a.color === b.color &&
    a.indicator === b.indicator &&
    a.clearDelayMs === b.clearDelayMs;
}

function isSingleProgramConfig(config: AgentProgramConfig, program: string): boolean {
  const programs = Array.isArray(config.programs)
    ? config.programs.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    : (typeof config.program === 'string' && config.program.trim().length > 0 ? [config.program] : []);
  return programs.length === 1 && programs[0]?.trim().toLowerCase() === program;
}

function migrateAgentRules(rules: AgentProgramConfig[]): { rules: AgentProgramConfig[]; changed: boolean } {
  let changed = false;
  const deprecatedCocoConfirmRule: AgentRule = {
    pattern: 'confirm|approve|permission|continue\\?',
    status: 'waiting',
    color: '#facc15',
    indicator: 'question',
    clearDelayMs: 10000,
  };
  const deprecatedCocoBroadWaitingRule: AgentRule = {
    pattern: 'Tab/Arrow keys to navigate|Esc to|select ·|Coco 等待态采样|AskUserQuestion|User\'s answers',
    status: 'waiting',
    color: '#facc15',
    indicator: 'question',
    clearDelayMs: 10000,
  };
  const cocoWaitingRule: AgentRule = {
    pattern: COCO_WAITING_RULE_PATTERN,
    status: 'waiting',
    color: '#facc15',
    indicator: 'question',
    clearDelayMs: 10000,
  };

  const nextRules = rules
    .filter((config) => {
      const shouldRemove = isSingleProgramConfig(config, 'aider') &&
        config.rules.length === 1 &&
        isSameAgentRule(config.rules[0]!, {
          pattern: 'Thinking|Generating|Working',
          status: 'running',
          color: '#4ade80',
          indicator: 'pulse',
          clearDelayMs: 900,
        });
      if (shouldRemove) changed = true;
      return !shouldRemove;
    })
    .map((config) => {
      if (!isSingleProgramConfig(config, 'coco')) return config;
      let nextRules = config.rules.filter((rule) => !isSameAgentRule(rule, deprecatedCocoConfirmRule));
      nextRules = nextRules.map((rule) => isSameAgentRule(rule, deprecatedCocoBroadWaitingRule) ? cocoWaitingRule : rule);
      if (nextRules.length === config.rules.length && nextRules.every((rule, index) => isSameAgentRule(rule, config.rules[index]!))) return config;
      changed = true;
      return { ...config, rules: nextRules };
    });

  return { rules: nextRules, changed };
}

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

function compileAgentRules(rules: AgentProgramConfig[]): Map<string, { status: string; color: string | undefined; indicator: AgentIndicator; clearDelayMs: number; regex: RegExp }[]> {
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

const AGENT_RULES_FILE = `${TERMDOCK_DIR}/agent-rules.json`;

async function loadAgentRulesFromDisk(): Promise<AgentProgramConfig[]> {
  try {
    const parsed = await readJsonFileIfExists<unknown>(AGENT_RULES_FILE);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const migrated = migrateAgentRules(parsed);
      if (migrated.changed) {
        await writeJsonFile(AGENT_RULES_FILE, migrated.rules);
      }
      return migrated.rules;
    }
  } catch { /* file doesn't exist or invalid, use builtins */ }
  return BUILTIN_AGENT_RULES;
}

async function loadAgentRules(): Promise<Map<string, { status: string; color: string | undefined; indicator: AgentIndicator; clearDelayMs: number; regex: RegExp }[]>> {
  return compileAgentRules(await loadAgentRulesFromDisk());
}

async function saveAgentRulesToDisk(rules: AgentProgramConfig[]): Promise<void> {
  await writeJsonFile(AGENT_RULES_FILE, rules);
  compileAgentRules(rules);
}

// Initialize on startup
void loadAgentRules();

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
// Retained for potential future re-enablement of agent status detection.
void stripAnsi;

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

// ── Program detection config (persisted to ~/.termdock/program-detection.json) ──

const PROGRAM_DETECTION_FILE = `${TERMDOCK_DIR}/program-detection.json`;

interface ProgramDetectionConfig {
  genericProgramNames: string[];
  wrapperScriptNames: string[];
  shellNames: string[];
}

const DEFAULT_PROGRAM_DETECTION: ProgramDetectionConfig = {
  genericProgramNames: ['node', 'python', 'python3', 'ruby', 'perl', 'java'],
  wrapperScriptNames: ['aiden', 'ttadk', 'npx', 'yarn', 'dlx'],
  shellNames: ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu'],
};

let genericProgramNames = new Set(DEFAULT_PROGRAM_DETECTION.genericProgramNames);
let wrapperScriptNames = new Set(DEFAULT_PROGRAM_DETECTION.wrapperScriptNames);
let shellNamesBackend = new Set(DEFAULT_PROGRAM_DETECTION.shellNames);

async function loadProgramDetectionFromDisk(): Promise<ProgramDetectionConfig> {
  try {
    const parsed = await readJsonFileIfExists<Partial<ProgramDetectionConfig>>(PROGRAM_DETECTION_FILE);
    if (!parsed) return { ...DEFAULT_PROGRAM_DETECTION };
    return {
      genericProgramNames: Array.isArray(parsed.genericProgramNames) ? parsed.genericProgramNames : DEFAULT_PROGRAM_DETECTION.genericProgramNames,
      wrapperScriptNames: Array.isArray(parsed.wrapperScriptNames) ? parsed.wrapperScriptNames : DEFAULT_PROGRAM_DETECTION.wrapperScriptNames,
      shellNames: Array.isArray(parsed.shellNames) ? parsed.shellNames : DEFAULT_PROGRAM_DETECTION.shellNames,
    };
  } catch { /* file doesn't exist or invalid, use defaults */ }
  return { ...DEFAULT_PROGRAM_DETECTION };
}

function applyProgramDetectionConfig(config: ProgramDetectionConfig): void {
  genericProgramNames = new Set(config.genericProgramNames);
  wrapperScriptNames = new Set(config.wrapperScriptNames);
  shellNamesBackend = new Set(config.shellNames);
}

async function saveProgramDetectionToDisk(config: ProgramDetectionConfig): Promise<void> {
  await writeJsonFile(PROGRAM_DETECTION_FILE, config);
  applyProgramDetectionConfig(config);
}

// Initialize on startup
void loadProgramDetectionFromDisk().then(applyProgramDetectionConfig);

async function resolveTmuxPaneProgram(pane: TmuxPane): Promise<{
  command: string | null;
  source: 'tmux-pane' | 'tmux-tty';
  rawArgs: string | null;
} | null> {
  // If pane command is a known shell, try to find a child foreground process
  const command = normalizeProgramName(pane.command);
  const commandKey = command?.toLowerCase() ?? null;
  const isShell = commandKey ? shellNamesBackend.has(commandKey) : false;
  // If pane command is NOT a shell but also too generic (e.g. "node"), also try
  const isGeneric = commandKey ? genericProgramNames.has(commandKey) : false;

  if (!isShell && !isGeneric) {
    // Non-shell, non-generic command — pane_current_command is good enough
    return { command, source: 'tmux-pane', rawArgs: null };
  }

  if (!pane.pid) {
    return { command, source: 'tmux-pane', rawArgs: null };
  }

  try {
    const psArgs = pane.tty
      ? ['-t', pane.tty.replace(/^\/dev\//, ''), '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,comm=,args=']
      : ['-o', 'pid=,ppid=,pgid=,tpgid=,stat=,comm=,args='];
    const { stdout } = await execFileAsync('ps', psArgs, { timeout: 3000, maxBuffer: 512 * 1024 });

    const rows = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): TmuxProcessRow | null => {
        // ps -o format: PID PPID PGID TPGID STAT COMM ARGS
        // COMM is a single token; ARGS is the rest of the line
        const match = line.match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (!match) return null;
        return {
          pid: Number.parseInt(match[1] || '0', 10),
          ppid: Number.parseInt(match[2] || '0', 10),
          pgid: Number.parseInt(match[3] || '0', 10),
          tpgid: Number.parseInt(match[4] || '0', 10),
          stat: match[5] || '',
          comm: match[6] || '',
          args: match[7]?.trim() || '',
        };
      })
      .filter((row): row is TmuxProcessRow => row !== null);

    const selected = selectTmuxForegroundProgram({
      panePid: pane.pid,
      rows,
      shellNames: shellNamesBackend,
      genericProgramNames,
      extractProgramLabel,
    });

    if (selected) {
      return { command: selected.command, source: 'tmux-tty', rawArgs: selected.rawArgs };
    }
  } catch {
    // Fall through to pane_current_command fallback
  }

  return { command, source: 'tmux-pane', rawArgs: null };
}

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
  return extractProgramLabelFromArgs(args, { genericProgramNames, wrapperScriptNames });
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

async function resolveLiveTmuxMetadata(tmuxSessionName: string): Promise<TmuxRuntimeMetadata | null> {
  const layout = await getTmuxLayout(tmuxSessionName);
  const activePane = getActivePaneFromLayout(layout);
  if (!activePane) {
    return null;
  }
  const resolved = await resolveTmuxPaneProgram(activePane);
  const fallback = getActiveProgramFromTmuxLayout(layout);
  const program = resolved?.command ?? fallback?.command ?? null;
  const cwd = getCwdFromTmuxLayout(layout);
  return buildRuntimeTmuxMetadata({ tmuxSessionName, program, cwd });
}

// ── label builder (mirrors the frontend `getSessionDisplayLines` semantics) ──
//
// Used to populate the `@termdock-label` tmux user option so external tools
// (e.g. `termdock --tls`) can show a meaningful one-line summary that matches
// what the user sees on the tab in the browser.

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

  const program = normalizeMetadataProgram(input.program);
  const dir = getCwdLeafBackend(input.cwd);

  if (program && !shellNamesBackend.has(program)) {
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
// onto the tmux session as user options. Caller passes the previous metadata
// snapshot and last-active-write timestamp so repeated polls with no change
// skip the tmux write entirely. Returns the new snapshot + write timestamp.
const TERMDOCK_LAST_ACTIVE_REFRESH_MS = 30_000;

function syncDynamicTmuxMetadata(input: {
  tmuxSessionName: string;
  program: string | null;
  cwd: string | null;
  previousMetadata: TmuxRuntimeMetadata | null;
  lastActiveWriteAt: number;
}): TmuxRuntimeMetadata & { lastActiveWriteAt: number } {
  const { tmuxSessionName, program, cwd, previousMetadata, lastActiveWriteAt } = input;
  const metadata = buildRuntimeTmuxMetadata({ tmuxSessionName, program, cwd });
  const now = Date.now();

  if (!tmuxMetadataChanged(previousMetadata, metadata)) {
    // Cheap path: refresh last-active-at at most every 30 s so external
    // tools see the session as alive without flooding tmux every 500 ms.
    if (now - lastActiveWriteAt >= TERMDOCK_LAST_ACTIVE_REFRESH_MS) {
      void setTmuxOption(tmuxSessionName, '@termdock-last-active-at', String(now));
      return { ...metadata, lastActiveWriteAt: now };
    }
    return { ...metadata, lastActiveWriteAt };
  }

  void setTmuxOptions(tmuxSessionName, {
    '@termdock-label': metadata.label,
    '@termdock-program': metadata.program ?? '',
    '@termdock-cwd': metadata.cwd ?? '',
    '@termdock-last-active-at': String(now),
  });
  return { ...metadata, lastActiveWriteAt: now };
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

async function ensureTmuxSessionExists(sessionName: string, cwd?: string): Promise<void> {
  let serverWasMissing = false;
  try {
    await runTmux(['has-session', '-t', sessionName]);
    await ensureTmuxColorEnvironment(sessionName);
    return;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    serverWasMissing = isTmuxServerMissingMessage(errorMessage);
    if (!isTmuxSessionMissingMessage(errorMessage)) {
      throw error;
    }
  }

  if (!serverWasMissing) {
    await ensureTmuxColorEnvironment();
  }

  const args = ['new-session', '-d', '-s', sessionName, '-e', 'COLORTERM=truecolor'];
  if (process.env.TERMDOCK_FORCE_COLOR === '1') {
    args.push('-e', 'FORCE_COLOR=1');
  }
  if (cwd) {
    args.push('-c', cwd);
  }
  await runTmux(args);
  await ensureTmuxColorEnvironment(sessionName);

  // Inject shell integration env into the tmux session so inner shells
  // get the same OSC 133/2/7 marks as direct shell mode.
  await injectTmuxShellIntegration(sessionName);
}

/**
 * Inject shell integration environment variables into a tmux session.
 *
 * tmux's `set-environment` makes vars available to processes spawned in
 * that session (i.e. the inner shell). We detect the shell type from
 * the tmux session's default-command / default-shell, then inject the
 * same env vars as injectShellIntegration does for direct shell mode.
 */
async function injectTmuxShellIntegration(sessionName: string): Promise<void> {
  // Determine the shell used inside tmux. tmux's default-shell is usually
  // the user's $SHELL, but can be overridden. We read it.
  let shellPath = process.env.SHELL || '/bin/bash';
  try {
    const tmuxShell = (await runTmux(['show-options', '-t', sessionName, '-v', 'default-shell'])).trim();
    if (tmuxShell) shellPath = tmuxShell;
  } catch {
    // default-shell not set for this session, use global $SHELL
  }

  const shellType = detectShellType(shellPath);
  const integrationDir = await resolveShellIntegrationDir();
  if (!integrationDir) return;

  const home = (process.env.HOME || '/root').replace(/\/+$/, '') || '/';

  if (shellType === 'zsh') {
    // Create a temporary ZDOTDIR for tmux's inner zsh.
    // Use session name in the dir to avoid collisions between sessions.
    const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const zdotdir = '/tmp/termdock-zsh-tmux-' + safeName;
    try {
      await fs.promises.mkdir(zdotdir, { recursive: true });
      await fs.promises.writeFile(zdotdir + '/.zshenv',
        '[[ -f "' + home + '/.zshenv" ]] && source "' + home + '/.zshenv"\n');
      await fs.promises.writeFile(zdotdir + '/.zshrc',
        'ZDOTDIR=\n' +
        '[[ -f "' + home + '/.zshrc" ]] && source "' + home + '/.zshrc"\n' +
        'source "' + integrationDir + '/termdock.zsh"\n');
      await runTmux(['set-environment', '-t', sessionName, 'ZDOTDIR', zdotdir]);
    } catch {
      // If we can't create the ZDOTDIR, skip integration
    }
  } else if (shellType === 'bash') {
    const scriptPath = path.join(integrationDir, 'termdock.bash');
    await runTmux(['set-environment', '-t', sessionName, 'BASH_ENV', scriptPath]);
    // Also set a bootstrap PROMPT_COMMAND for interactive bash
    const bootstrap = 'source "' + scriptPath + '" 2>/dev/null';
    await runTmux(['set-environment', '-t', sessionName, 'TERMDOCK_BASH_BOOTSTRAP', bootstrap]);
  } else if (shellType === 'fish') {
    const scriptPath = path.join(integrationDir, 'termdock.fish');
    await runTmux(['set-environment', '-t', sessionName, 'TERMDOCK_FISH_INTEGRATION', scriptPath]);
  }
}

async function enableTmuxFocusEvents(): Promise<void> {
  const current = (await runTmux(['show-options', '-gqv', 'focus-events'])).trim();
  if (current === 'on') return;
  await runTmux(['set-option', '-g', 'focus-events', 'on']);
  console.log('[tmux-focus] enabled global focus-events');
}

async function ensureSharedTmuxServerReady(): Promise<void> {
  await ensureTmuxColorEnvironment();
  await applyTmuxScrollbackProfile();
  await enableTmuxFocusEvents();
  await configureTmuxWheelBindings();
}

async function stampTmuxMetadata(sessionName: string): Promise<void> {
  const baseOptions: Record<string, string> = {
    '@termdock-version': TERMDOCK_VERSION,
    '@termdock-host': TERMDOCK_HOST,
    '@termdock-pid': TERMDOCK_PID,
  };
  const existingCreatedAt = await getTmuxOption(sessionName, '@termdock-created-at');
  if (!existingCreatedAt) {
    baseOptions['@termdock-created-at'] = String(Date.now());
  }
  await setTmuxOptions(sessionName, baseOptions);
}

async function ensureManagedTmuxSessionReady(sessionName: string): Promise<void> {
  try {
    await ensureTmuxColorEnvironment(sessionName);
  } catch (error) {
    console.warn(`Failed to set tmux color environment for ${sessionName}: ${getErrorMessage(error)}`);
  }

  try {
    await disableTmuxStatus(sessionName);
  } catch (error) {
    console.warn(`Failed to disable tmux status for ${sessionName}: ${getErrorMessage(error)}`);
  }

  try {
    await enableTmuxMouse(sessionName);
  } catch (error) {
    console.warn(`Failed to enable tmux mouse for ${sessionName}: ${getErrorMessage(error)}`);
  }

  await applyTmuxScrollbackProfile(sessionName);
  await stampTmuxMetadata(sessionName);
}

async function prepareManagedTmuxSession(sessionName: string, cwd?: string): Promise<void> {
  await ensureTmuxSessionExists(sessionName, cwd);
  await ensureSharedTmuxServerReady();
  await ensureManagedTmuxSessionReady(sessionName);
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
      `#{pane_id}${TMUX_DELIMITER}#{pane_index}${TMUX_DELIMITER}#{pane_active}${TMUX_DELIMITER}#{pane_width}${TMUX_DELIMITER}#{pane_height}${TMUX_DELIMITER}#{pane_top}${TMUX_DELIMITER}#{pane_left}${TMUX_DELIMITER}#{pane_current_command}${TMUX_DELIMITER}#{pane_pid}${TMUX_DELIMITER}#{pane_tty}${TMUX_DELIMITER}#{pane_title}${TMUX_DELIMITER}#{pane_current_path}`,
    ]);

    const panes: TmuxPane[] = panesRaw.trim().split('\n').filter(Boolean).map((paneLine) => {
      const paneRow = parseDelimitedRow(paneLine, 12);
      if (!paneRow) {
        return null;
      }

      const [paneId, paneIndexRaw, paneActiveRaw, widthRaw, heightRaw, topRaw, leftRaw, command, pidRaw, tty, title, currentPath] = paneRow;
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
        tty: tty || '',
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
        // capture-pane returns a line-oriented snapshot with LF separators.
        // In tmux mode the frontend intentionally keeps xterm.convertEol=false
        // so live TUI output preserves exact terminal semantics; feeding bare LF
        // during restore moves down without carriage return and renders as sparse
        // diagonal characters after reconnect. Normalize only this synthetic
        // snapshot to CRLF so each captured tmux line starts at column 0.
        ? ['\u001b[H\u001b[2J\u001b[3J', snapshot.replace(/\r?\n/g, '\r\n')]
        : [];
    } catch (error) {
      console.warn(`Failed to capture tmux pane for ${session.tmuxSessionName}: ${getErrorMessage(error)}`);
      return [];
    }
  }

  return getReconnectionHistory(sessionId);
}

async function resolveWorkingDirectory(req: express.Request, inputCwd?: string): Promise<string> {
  const requestedCwd = inputCwd || os.homedir();

  if (req.pathValidator) {
    return req.pathValidator.validateAsync(requestedCwd);
  }

  try {
    await fs.promises.access(requestedCwd, fs.constants.R_OK | fs.constants.X_OK);
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
  removeClientFocus(sessionId, session, clientId);
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
  for (const timer of session.flowPausedClientTimers.values()) {
    clearTimeout(timer);
  }
  session.flowPausedClientTimers.clear();
  session.flowPausedClients.clear();
  if (session.ptyPausedForFlowControl) {
    applyPtyFlowControl(sessionId, session, false, 'session-cleanup');
  }

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

function broadcastToWs(sessionId: string, data: string, excludeClientId?: string): void {
  const clients = wsClients.get(sessionId);
  const session = terminalSessions.get(sessionId);
  if (!clients) return;
  for (const [clientId, ws] of clients.entries()) {
    if (excludeClientId && clientId === excludeClientId) continue;
    try {
      ws.send(data);
    } catch {
      clients.delete(clientId);
      if (session) removeClientFlowPaused(sessionId, session, clientId, 'ws-send-failed');
    }
  }
}

function broadcastJsonWs(sessionId: string, payload: unknown, excludeClientId?: string): void {
  broadcastToWs(sessionId, JSON.stringify(payload), excludeClientId);
}

// 统一的 pty resize 入口：调用 ptyProcess.resize 改变 pty size 之后，把
// 真实尺寸广播给除发起方之外的所有 ws client。多端场景下，B 端把 pty
// 拉小后，A 端能立即知道 server 真实尺寸跟自己 lastServerSize 不一致，
// 下次 fit 才能正确触发 push。发起方自己已经知道这个尺寸（自己刚发的），
// 不必再回声一份，避免无意义的 lastServerSize 重复写、pending timer 取消。
function applyPtyResize(
  sessionId: string,
  session: TerminalSession,
  cols: number,
  rows: number,
  source: string,
  originClientId?: string,
): boolean {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    return false;
  }
  const cleanCols = Math.floor(cols);
  const cleanRows = Math.floor(rows);
  const changed = session.cols !== cleanCols || session.rows !== cleanRows;
  try {
    session.ptyProcess.resize(cleanCols, cleanRows);
  } catch (error) {
    console.warn(`[pty-resize] failed session=${sessionId} cols=${cleanCols} rows=${cleanRows}: ${getErrorMessage(error)}`);
    return false;
  }
  session.cols = cleanCols;
  session.rows = cleanRows;
  session.lastActivity = Date.now();
  if (changed) {
    broadcastJsonWs(
      sessionId,
      { type: 'pty-size', cols: cleanCols, rows: cleanRows, source },
      originClientId,
    );
  }
  return true;
}

function getFlowPausedClients(session: TerminalSession): Set<string> {
  if (!session.flowPausedClients) {
    session.flowPausedClients = new Set();
  }
  return session.flowPausedClients;
}

function getFlowPausedClientTimers(session: TerminalSession): Map<string, ReturnType<typeof setTimeout>> {
  if (!session.flowPausedClientTimers) {
    session.flowPausedClientTimers = new Map();
  }
  return session.flowPausedClientTimers;
}

function clearFlowPauseLease(session: TerminalSession, clientId: string): void {
  const timers = getFlowPausedClientTimers(session);
  const timer = timers.get(clientId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(clientId);
  }
}

function refreshFlowPauseLease(sessionId: string, session: TerminalSession, clientId: string): void {
  clearFlowPauseLease(session, clientId);
  const timer = setTimeout(() => {
    const currentSession = terminalSessions.get(sessionId);
    if (!currentSession) return;
    console.warn(`[flow-control] pause lease expired session=${sessionId} client=${clientId}`);
    removeClientFlowPaused(sessionId, currentSession, clientId, 'pause-lease-expired');
  }, FLOW_CONTROL_PAUSE_LEASE_MS);
  timer.unref?.();
  getFlowPausedClientTimers(session).set(clientId, timer);
}

function applyPtyFlowControl(sessionId: string, session: TerminalSession, paused: boolean, reason: string): void {
  if (session.ptyPausedForFlowControl === paused) return;
  session.ptyPausedForFlowControl = paused;

  const method = paused ? session.ptyProcess.pause : session.ptyProcess.resume;
  if (typeof method !== 'function') {
    console.warn(`[flow-control] PTY backend has no ${paused ? 'pause' : 'resume'} method session=${sessionId} reason=${reason}`);
    return;
  }

  try {
    method.call(session.ptyProcess);
  } catch (error) {
    console.warn(`[flow-control] failed to ${paused ? 'pause' : 'resume'} PTY session=${sessionId} reason=${reason}: ${getErrorMessage(error)}`);
  }
}

function closeFlowControlledWsClient(sessionId: string, clientId: string, reason: string): void {
  const clients = wsClients.get(sessionId);
  const ws = clients?.get(clientId);
  if (!ws) return;

  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'reconnecting',
        reason: 'flow-control',
        detail: reason,
      }));
    }
  } catch {
    // The close path below will clean up the client map.
  }

  try {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(1013, 'Client output backlog');
    }
  } catch {
    clients?.delete(clientId);
    const session = terminalSessions.get(sessionId);
    if (session) {
      removeClientFocus(sessionId, session, clientId);
      removeClientFlowPaused(sessionId, session, clientId, 'flow-control-close-failed');
    }
    if (clients?.size === 0) {
      wsClients.delete(sessionId);
    }
    syncClientCountToTmux(sessionId);
  }
}

function setClientFlowPaused(sessionId: string, session: TerminalSession, clientId: string, paused: boolean, reason: string): void {
  const clients = getFlowPausedClients(session);
  const wasPaused = clients.has(clientId);
  if (paused) {
    clients.add(clientId);
    refreshFlowPauseLease(sessionId, session, clientId);
    console.warn(`[flow-control] disconnecting slow client session=${sessionId} client=${clientId} reason=${reason}`);
    closeFlowControlledWsClient(sessionId, clientId, reason);
  } else {
    clients.delete(clientId);
    clearFlowPauseLease(session, clientId);
  }
  if (wasPaused === paused) {
    return;
  }
  if (!paused && session.ptyPausedForFlowControl && clients.size === 0) {
    applyPtyFlowControl(sessionId, session, false, reason);
  }
}

function removeClientFlowPaused(sessionId: string, session: TerminalSession, clientId: string, reason: string): void {
  clearFlowPauseLease(session, clientId);
  const clients = getFlowPausedClients(session);
  if (!clients.delete(clientId)) return;
  if (session.ptyPausedForFlowControl && clients.size === 0) {
    applyPtyFlowControl(sessionId, session, false, reason);
  }
}

function emitFocusSequenceIfNeeded(sessionId: string, session: TerminalSession, focused: boolean, reason: string): void {
  if (session.mode !== 'tmux' || !session.focusTrackingRequested) return;
  try {
    session.ptyProcess.write(getFocusSequence(focused));
    console.log(`[tmux-focus] emitted ${focused ? 'focus-in' : 'focus-out'} session=${sessionId} reason=${reason}`);
  } catch (error) {
    console.warn(`[tmux-focus] failed to emit focus sequence session=${sessionId}: ${getErrorMessage(error)}`);
  }
}

function updateClientFocusState(sessionId: string, session: TerminalSession, clientId: string, focused: boolean, reason: string): void {
  const result = setClientFocusState(session.focusAggregation, clientId, focused);
  if (result.changed) {
    emitFocusSequenceIfNeeded(sessionId, session, result.effectiveFocused, reason);
  }
}

function removeClientFocus(sessionId: string, session: TerminalSession, clientId: string): void {
  const result = removeClientFocusState(session.focusAggregation, clientId);
  if (result.changed) {
    emitFocusSequenceIfNeeded(sessionId, session, result.effectiveFocused, 'client-disconnect');
  }
}

function updateFocusTrackingFromOutput(sessionId: string, session: TerminalSession, data: string): void {
  const result = scanFocusTrackingMode(data, {
    buffer: session.focusModeSniffBuf,
    requested: session.focusTrackingRequested,
  });
  session.focusModeSniffBuf = result.buffer;
  if (!result.changed) return;

  session.focusTrackingRequested = result.requested;
  broadcastJsonWs(sessionId, {
    type: 'focus-mode',
    focusTrackingRequested: result.requested,
  });
  console.log(`[tmux-focus] mode ${result.requested ? 'enabled' : 'disabled'} session=${sessionId}`);

  if (result.requested && session.focusAggregation.effectiveFocused) {
    emitFocusSequenceIfNeeded(sessionId, session, true, 'focus-mode-enabled');
  }
}

function setupPtyHandlers(sessionId: string, session: TerminalSession): void {
  const home = (process.env.HOME || '/root').replace(/\/+$/, '') || '/';

  session.dataDisposable = session.ptyProcess.onData((data: string) => {
    session.lastActivity = Date.now();
    session.hasWrittenData = true;
    let seq: number | undefined;
    if (session.mode === 'shell') {
      seq = addToHistory(sessionId, data);
    }
    if (session.mode === 'tmux') {
      updateFocusTrackingFromOutput(sessionId, session, data);
    }

    // Sniff OSC sequences for CWD tracking + prompt state + title
    try {
      const buf = session.oscSniffBuf + data;
      if (buf.length > OSC_SNIFF_CAP) {
        session.oscSniffBuf = buf.slice(-OSC_SNIFF_CAP / 4); // trim
      }
      const result = sniffOsc(buf, home);
      session.oscSniffBuf = result.remaining;

      // CWD change
      if (result.cwd && result.cwd !== session.lastOscCwd) {
        session.lastOscCwd = result.cwd;
        session.cwd = result.cwd;
        if (updateGlobalBindingForBackendSession(sessionId, { cwd: result.cwd, lastActivity: session.lastActivity })) {
          schedulePersistGlobalState();
        }
        broadcastEvent(sessionId, { type: 'cwd', cwd: result.cwd });
      }

      // Title change — broadcast so the frontend can update tab/sidebar
      if (result.title !== null && result.title !== session.lastOscTitle) {
        session.lastOscTitle = result.title;
        broadcastJsonWs(sessionId, { type: 'shell-title', title: result.title });
      }

      // Prompt state change (OSC 133)
      if (result.promptState !== null && result.promptState !== session.lastPromptState) {
        session.lastPromptState = result.promptState;
        broadcastJsonWs(sessionId, {
          type: 'prompt-state',
          state: result.promptState,
          exitCode: result.exitCode,
        });
      }

      if (result.tuiProgress !== null) {
        session.tuiProgress = result.tuiProgress.state === 'remove' ? null : result.tuiProgress;
        broadcastJsonWs(sessionId, {
          type: 'tui-progress',
          tuiProgress: session.tuiProgress,
        });
      }
    } catch { /* sniff failure should never block data */ }

    // Agent status content-based detection — DISABLED.
    // OSC 133 promptState now provides real-time running/idle state for all
    // programs (not just AI tools). The content-based detection was inaccurate
    // (false positives from spinner characters in normal output, false negatives
    // when AI tools changed their output format). Keeping the code for potential
    // future re-enablement but not calling it.
    // try {
    //   if (isAiToolProgram(session.activeProgram?.command)) {
    //     ...evaluateAgentStatus...
    //   }
    // } catch {}

    broadcastEvent(sessionId, seq !== undefined ? { type: 'data', data, seq } : { type: 'data', data });
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
  termType?: string;
}): Promise<{ sessionId: string; session: TerminalSession; cols: number; rows: number }> {
  const cwd = await resolveWorkingDirectory(req, input.cwd);
  const cols = input.cols || 80;
  const rows = input.rows || 24;
  const sessionId = Math.random().toString(36).substring(2, 15) +
                    Math.random().toString(36).substring(2, 15);
  const mode = normalizeMode(input.mode);
  const tmuxSessionName = mode === 'tmux' ? normalizeTmuxSessionName(input.tmuxSessionName) : null;

  if (mode === 'tmux' && tmuxSessionName) {
    await prepareManagedTmuxSession(tmuxSessionName, cwd);
  }

  const command = mode === 'tmux'
    ? getTmuxBinary()
    : (process.platform === 'win32' ? 'powershell.exe' : resolveShellCandidates()[0]);
  const args = mode === 'tmux' && tmuxSessionName
    ? ['attach-session', '-t', tmuxSessionName]
    : [];

  const envPath = buildAugmentedPath();
  const resolvedEnv = { ...process.env, PATH: envPath };

  const pty = await getPtyProvider();
  const termValue = resolveTerminalTermType(input.termType);
  const baseEnv: Record<string, string> = {
    ...resolvedEnv,
    TERM: termValue,
    COLORTERM: 'truecolor',
  };

  let ptyProcess: PtyProcess | null = null;

  if (mode === 'shell' && process.platform !== 'win32') {
    const shellCandidates = resolveShellCandidates();
    let lastError: unknown = null;

    for (const shellCandidate of shellCandidates) {
      try {
        const env = await injectShellIntegration(shellCandidate, baseEnv);
        ptyProcess = pty.spawn(shellCandidate, [], {
          name: termValue,
          cols,
          rows,
          cwd,
          env,
        });
        break;
      } catch (error) {
        lastError = error;
        if (!shouldRetryShellSpawn(error)) {
          throw error;
        }
      }
    }

    if (!ptyProcess) {
      throw lastError ?? new Error('Failed to start shell');
    }
  } else {
    ptyProcess = pty.spawn(command, args, {
      name: termValue,
      cols,
      rows,
      cwd,
      env: baseEnv,
    });
  }

  if (!ptyProcess) {
    throw new Error('Failed to start PTY process');
  }

  const session: TerminalSession = {
    ptyProcess,
    ptyBackend: pty.backend,
    cwd,
    mode,
    tmuxSessionName,
    cols,
    rows,
    lastActivity: Date.now(),
    clients: new Map(),
    createdAt: Date.now(),
    hasWrittenData: false,
    activeProgram: null,
    oscSniffBuf: '',
    lastOscCwd: null,
    lastOscTitle: null,
    lastPromptState: null,
    tuiProgress: null,
    agentStatus: null,
    agentColor: null,
    agentIndicator: null,
    agentStatusBuf: '',
    agentStatusTimer: null,
    agentStatusClearDelayMs: DEFAULT_AGENT_CLEAR_DELAY_MS,
    focusTrackingRequested: false,
    focusModeSniffBuf: '',
    focusAggregation: {
      focusedClients: new Map(),
      effectiveFocused: false,
    },
    flowPausedClients: new Set(),
    flowPausedClientTimers: new Map(),
    ptyPausedForFlowControl: false,
  };

  terminalSessions.set(sessionId, session);
  setupPtyHandlers(sessionId, session);

  if (mode === 'tmux' && tmuxSessionName) {
    // Session was prepared before attach so the first tmux client sees the
    // right server/session options immediately.
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

/**
 * Resolve the shell-integration script directory.
 *
 * In dev (tsx): scripts live at <project-root>/public/shell-integration/
 * In prod (installed): scripts are copied to <dist>/client/shell-integration/
 * by the build. We probe both locations.
 */
let cachedIntegrationDir: string | null = null;
async function resolveShellIntegrationDir(): Promise<string | null> {
  if (cachedIntegrationDir !== null) return cachedIntegrationDir;
  // 项目是 ESM (`"type": "module"`)，__dirname 不存在；用 import.meta.url 推导。
  // dev 模式下此文件位于 src/server/routes/，对应 dist 路径为 dist/server/routes/；
  // 探针覆盖 dev / 安装后 dist 两种位置。
  let sourceDir = process.cwd();
  try {
    sourceDir = path.dirname(fileURLToPath(import.meta.url));
  } catch { /* fall through to cwd */ }
  const candidates = [
    path.join(process.cwd(), 'public', 'shell-integration'),
    path.join(sourceDir, '..', '..', '..', 'client', 'shell-integration'),
    path.join(sourceDir, '..', '..', 'client', 'shell-integration'),
    path.join(process.cwd(), 'dist', 'client', 'shell-integration'),
  ];
  for (const dir of candidates) {
    try {
      await fs.promises.access(path.join(dir, 'termdock.zsh'), fs.constants.R_OK);
      cachedIntegrationDir = dir;
      return dir;
    } catch { /* access 抛错跳过这个候选 */ }
  }
  return null;
}

/**
 * Inject termdock shell integration via environment variables.
 *
 * This replaces the old injectShellTitleHooks with a full Ghostty-style
 * integration that emits OSC 133 (prompt marks), OSC 2 (title), and OSC 7 (cwd).
 *
 * Works for both shell mode (env passed to PTY spawn) and tmux mode
 * (env passed to `tmux set-environment`).
 */
async function injectShellIntegration(shellPath: string, baseEnv: Record<string, string>): Promise<Record<string, string>> {
  const shellType = detectShellType(shellPath);
  const home = (process.env.HOME || '/root').replace(/\/+$/, '') || '/';
  const integrationDir = await resolveShellIntegrationDir();
  const env = { ...baseEnv };

  if (!integrationDir) {
    // Fallback: no integration scripts found, use minimal title hooks
    if (shellType === 'bash') {
      env.PROMPT_COMMAND = 'printf "\\033]0;%s@%s:%s\\007" "${USER}" "${HOSTNAME%%.*}" "${PWD}"';
    }
    return env;
  }

  if (shellType === 'zsh') {
    // Create a temporary ZDOTDIR that sources user's zshenv/zshrc then
    // sources our integration script. Same approach as Ghostty.
    const zdotdir = '/tmp/termdock-zsh-' + String(process.pid);
    try {
      await fs.promises.mkdir(zdotdir, { recursive: true });
      await fs.promises.writeFile(zdotdir + '/.zshenv',
        '[[ -f "' + home + '/.zshenv" ]] && source "' + home + '/.zshenv"\n');
      await fs.promises.writeFile(zdotdir + '/.zshrc',
        'ZDOTDIR=\n' +
        '[[ -f "' + home + '/.zshrc" ]] && source "' + home + '/.zshrc"\n' +
        'source "' + integrationDir + '/termdock.zsh"\n');
      env.ZDOTDIR = zdotdir;
    } catch {
      // Fallback: no ZDOTDIR, integration won't load
    }
  } else if (shellType === 'bash') {
    // For bash, we use BASH_ENV to source our script. BASH_ENV is sourced
    // for non-interactive bash, but since our script checks $- for interactive,
    // it's safe. For interactive shells, bash sources .bashrc which we can't
    // easily prepend to. Instead, use PROMPT_COMMAND as a bootstrap.
    const scriptPath = path.join(integrationDir, 'termdock.bash');
    // Use ENV alias trick: set BASH_ENV for non-interactive, and for interactive
    // bash, we prepend a source command via PROMPT_COMMAND bootstrap.
    // The script itself checks $- and returns early for non-interactive.
    env.BASH_ENV = scriptPath;
    // Bootstrap: source our integration on first prompt if not already loaded.
    // This is a one-shot that self-removes from PROMPT_COMMAND.
    if (!env.PROMPT_COMMAND || !env.PROMPT_COMMAND.includes('__termdock_hook')) {
      const existing = env.PROMPT_COMMAND || '';
      env.PROMPT_COMMAND = 'source "' + scriptPath + '" 2>/dev/null' + (existing ? '; ' + existing : '');
    }
  } else if (shellType === 'fish') {
    // Fish uses vendor_conf.d for automatic sourcing. We can't easily inject
    // a vendor dir, so we use fish's --init-command equivalent: set
    // __fish_config_dir to point to a dir that includes our script.
    // Simpler: just set an env var that the user's fish config can source,
    // or use fish's XDG_DATA_DIRS to include our vendor conf.
    const scriptPath = path.join(integrationDir, 'termdock.fish');
    // Fish doesn't have a clean env-based injection. We set a variable
    // that the startup can use, but for now, rely on the user's fish
    // config or fish's native title support. The OSC 133 marks won't
    // be emitted without explicit sourcing.
    // TODO: For fish, we could create a temporary XDG_CONFIG_HOME/fish/conf.d/
    // But that's risky. Leave fish to use its native fish_title for now.
    env.TERMDOCK_FISH_INTEGRATION = scriptPath;
  }

  return env;
}

function buildAugmentedPath(): string {
  const pathEnv = process.env.PATH || '';
  const extraPaths = ['/usr/local/bin', '/usr/bin', '/bin'];
  const uniquePaths = new Set([...extraPaths, ...pathEnv.split(':').filter(Boolean)]);
  return Array.from(uniquePaths).join(':');
}

let ptyProviderPromise: Promise<PtyProvider> | null = null;

/**
 * Resolve the requested termType to the TERM value used by PTY processes.
 * Termdock now exposes only the xterm.js terminal engine, so every path uses
 * the portable xterm-256color terminfo. Older clients may still send a stale
 * value; keep accepting the field but do not pass custom TERM names through.
 */
function resolveTerminalTermType(_requested: string | undefined): string {
  return 'xterm-256color';
}

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
    const inventory = await getSessionInventorySnapshot();
    const sessions = inventory.tmuxSessions.map((session) => ({
      name: session.name,
      windows: session.windows,
      attached: session.attachedCount,
      attachedCount: session.attachedCount,
      createdAt: session.createdAt,
      boundFrontendSessionId: session.boundFrontendSessionId,
      connected: session.connected,
      live: session.live,
      restorable: session.restorable,
      friendlyName: session.friendlyName,
      label: session.label,
      program: session.program,
      cwd: session.cwd,
      clientCount: session.clientCount,
      lastActiveAt: session.lastActiveAt,
    }));
    return res.json({ sessions });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (isTmuxServerMissingMessage(errorMessage)) {
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
    if (isTmuxSessionMissingMessage(errorMessage)) {
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

router.get('/client-state', async (_req, res) => {
  const inventory = await getSessionInventorySnapshot().catch(() => null);
  res.json({ ...globalSessionState, inventory: inventory ?? latestSessionInventory });
});

router.get('/session-inventory', async (_req, res) => {
  try {
    const inventory = await getSessionInventorySnapshot();
    res.json(inventory);
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    res.status(500).json({ error: errorMessage || 'Failed to build session inventory' });
  }
});

router.post('/session-inventory/open', async (req, res) => {
  try {
    const input = req.body ?? {};
    const lockKey = makeInventoryOpenLockKey(input);
    const result = await withInventoryOpenLock(lockKey, () => openInventorySession(req, input));
    res.json(result);
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (error instanceof HttpStatusError) {
      return res.status(error.statusCode).json({
        error: errorMessage || 'Failed to open session',
        code: error.code,
      });
    }
    console.error('[session-inventory] failed to open session:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to open session' });
  }
});

router.patch('/session-inventory/sessions/:frontendSessionId', async (req, res) => {
  const frontendSessionId = typeof req.params.frontendSessionId === 'string' ? req.params.frontendSessionId.trim() : '';
  if (!frontendSessionId) {
    return res.status(400).json({ error: 'frontendSessionId is required' });
  }

  const idx = globalSessionState.sessions.findIndex((session) => session.sessionId === frontendSessionId);
  if (idx < 0) {
    return res.status(404).json({ error: 'session not found' });
  }

  const body = req.body ?? {};
  const previous = globalSessionState.sessions[idx];
  const next: PersistedClientSession = { ...previous, lastActivity: Date.now() };
  if (typeof body.name === 'string' && body.name.trim().length > 0) {
    next.name = body.name.trim();
  }
  if (typeof body.customName === 'boolean') {
    next.customName = body.customName ? true : undefined;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'backendSessionId')) {
    next.backendSessionId = typeof body.backendSessionId === 'string' && body.backendSessionId.trim().length > 0
      ? body.backendSessionId.trim()
      : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'tmuxSessionName')) {
    next.tmuxSessionName = typeof body.tmuxSessionName === 'string' && body.tmuxSessionName.trim().length > 0
      ? body.tmuxSessionName.trim()
      : null;
    if (next.tmuxSessionName) next.mode = 'tmux';
  }

  if (next.mode === 'tmux' && next.tmuxSessionName) {
    if (next.customName === true && next.name.trim().length > 0) {
      await setTmuxOption(next.tmuxSessionName, '@termdock-friendly-name', next.name);
    } else if (previous.customName === true) {
      await unsetTmuxOption(next.tmuxSessionName, '@termdock-friendly-name');
    }
  }
  upsertGlobalSessionRecord(next);
  await persistGlobalStateNow();
  broadcastClientState();

  const inventory = await getSessionInventorySnapshot({ refresh: true });
  res.json(inventory);
});

router.post('/session-inventory/reorder', async (req, res) => {
  const sessionIds = Array.isArray(req.body?.sessionIds)
    ? (req.body.sessionIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];
  const idToSession = new Map(globalSessionState.sessions.map((session) => [session.sessionId, session]));
  const covered = new Set(sessionIds);
  const reordered = sessionIds
    .map((id) => idToSession.get(id))
    .filter((session): session is PersistedClientSession => session !== undefined);
  const remaining = globalSessionState.sessions.filter((session) => !covered.has(session.sessionId));
  globalSessionState = {
    sessions: deduplicateGlobalSessions([...reordered, ...remaining]),
    updatedAt: Date.now(),
  };
  schedulePersistGlobalState();
  broadcastClientState();
  const inventory = await getSessionInventorySnapshot({ refresh: true });
  res.json(inventory);
});

router.delete('/session-inventory/sessions/:frontendSessionId', async (req, res) => {
  const frontendSessionId = typeof req.params.frontendSessionId === 'string' ? req.params.frontendSessionId.trim() : '';
  if (!frontendSessionId) {
    return res.status(400).json({ error: 'frontendSessionId is required' });
  }
  const removedSession = globalSessionState.sessions.find((session) => session.sessionId === frontendSessionId) ?? null;
  const changed = removeGlobalSessionRecord(frontendSessionId);
  if (changed) {
    if (removedSession?.mode === 'tmux' && removedSession.tmuxSessionName) {
      await setTmuxOption(
        removedSession.tmuxSessionName,
        TERMDOCK_GUI_DETACHED_AT_OPTION,
        String(Date.now()),
      );
    }
    await persistGlobalStateNow();
    broadcastClientState();
  }
  res.status(204).send();
});

router.delete('/session-inventory/sessions', async (_req, res) => {
  await markAllPersistedTmuxSessionsDetached();
  globalSessionState = { sessions: [], updatedAt: Date.now() };
  schedulePersistGlobalState();
  broadcastClientState();
  res.status(204).send();
});

router.put('/client-state', (_req, res) => {
  res.status(410).json({
    error: 'client-state replacement is no longer supported; use session-inventory endpoints',
    code: 'CLIENT_STATE_REPLACE_DISABLED',
  });
});

router.delete('/client-state', async (_req, res) => {
  await markAllPersistedTmuxSessionsDetached();
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
  const baseUpdatedAt = typeof (body as { baseUpdatedAt?: unknown }).baseUpdatedAt === 'number'
    ? (body as { baseUpdatedAt: number }).baseUpdatedAt
    : null;
  const currentUpdatedAt = toolbarPresetsDoc?.updatedAt ?? 0;
  if (baseUpdatedAt !== null && currentUpdatedAt > 0 && currentUpdatedAt !== baseUpdatedAt) {
    res.status(409).json({
      error: 'Toolbar presets changed on another client',
      code: 'TOOLBAR_PRESETS_CONFLICT',
      current: toolbarPresetsDoc ?? { version: 0, presets: [], updatedAt: 0 },
    });
    return;
  }
  const version = typeof body.version === 'number' ? body.version : 0;
  const presets = Array.isArray(body.presets) ? body.presets : [];
  toolbarPresetsDoc = { version, presets, updatedAt: Date.now() };
  schedulePersistToolbarPresets();
  broadcastControlEvent({
    type: 'config-updated',
    key: 'toolbar-presets',
    updatedAt: toolbarPresetsDoc.updatedAt,
  });
  res.json(toolbarPresetsDoc);
});

async function getSettingsPayload() {
  const localAccess = localAccessManager.getState();
  const interfaces = await Promise.all(localAccess.interfaces.map(async (entry) => {
    const url = `${localAccess.httpsEnabled ? 'https' : 'http'}://${entry.address}:9834`;
    const qrDataUrl = await QRCode.toDataURL(url, {
      margin: 1,
      width: 132,
      errorCorrectionLevel: 'M',
    }).catch(() => null);
    return { ...entry, url, qrDataUrl };
  }));
  return {
    preventSleep: caffeinateManager.getPreventSleep(),
    caffeinateActive: caffeinateManager.isActive(),
    networkAvailable: caffeinateManager.isNetworkAvailable(),
    localAccess: {
      ...localAccess,
      interfaces,
      onboardingUrl: getOnboardingServerUrl() ?? null,
    },
  };
}

// ── Settings (prevent sleep) ──────────────────────────────────────────
router.get('/settings', async (_req, res) => {
  res.json(await getSettingsPayload());
});

router.put('/settings', async (req, res) => {
  const body = req.body ?? {};
  if (typeof body.preventSleep === 'boolean') {
    caffeinateManager.setPreventSleep(body.preventSleep);
  }

  if (body.localAccess && typeof body.localAccess === 'object') {
    const localAccessBody = body.localAccess as { name?: unknown; reset?: unknown };
    if (localAccessBody.reset === true) {
      await localAccessManager.resetAutoName();
    } else if (localAccessBody.name !== undefined) {
      const normalized = normalizeLocalAccessName(localAccessBody.name);
      if (!normalized) {
        res.status(400).json({ error: 'Invalid local access name', code: 'INVALID_LOCAL_ACCESS_NAME' });
        return;
      }
      const state = await localAccessManager.updateName(normalized, 'manual');
      if (state.status === 'conflict') {
        res.status(409).json({ error: state.reason ?? 'Local access name is already in use', code: 'LOCAL_ACCESS_CONFLICT', localAccess: state });
        return;
      }
    }
  }

  res.json(await getSettingsPayload());
});

// ── Agent detection rules API ──

router.get('/agent-rules', async (_req, res) => {
  res.json(await loadAgentRulesFromDisk());
});

router.put('/agent-rules', async (req, res) => {
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
  await saveAgentRulesToDisk(rules);
  broadcastControlEvent({
    type: 'config-updated',
    key: 'agent-rules',
    updatedAt: Date.now(),
  });
  res.json(rules);
});

router.delete('/agent-rules', async (_req, res) => {
  // Remove custom rules file so builtins take effect again
  await fs.promises.unlink(AGENT_RULES_FILE).catch(() => undefined);
  compileAgentRules(BUILTIN_AGENT_RULES);
  broadcastControlEvent({
    type: 'config-updated',
    key: 'agent-rules',
    updatedAt: Date.now(),
  });
  res.json(BUILTIN_AGENT_RULES);
});

// ── Program detection config API ──

router.get('/program-detection', async (_req, res) => {
  res.json(await loadProgramDetectionFromDisk());
});

router.put('/program-detection', async (req, res) => {
  const config = req.body;
  if (!config || typeof config !== 'object') {
    res.status(400).json({ error: 'Expected object with genericProgramNames, wrapperScriptNames, shellNames' });
    return;
  }
  const validated: ProgramDetectionConfig = {
    genericProgramNames: Array.isArray(config.genericProgramNames)
      ? config.genericProgramNames.filter((s: unknown) => typeof s === 'string' && s.trim())
      : DEFAULT_PROGRAM_DETECTION.genericProgramNames,
    wrapperScriptNames: Array.isArray(config.wrapperScriptNames)
      ? config.wrapperScriptNames.filter((s: unknown) => typeof s === 'string' && s.trim())
      : DEFAULT_PROGRAM_DETECTION.wrapperScriptNames,
    shellNames: Array.isArray(config.shellNames)
      ? config.shellNames.filter((s: unknown) => typeof s === 'string' && s.trim())
      : DEFAULT_PROGRAM_DETECTION.shellNames,
  };
  await saveProgramDetectionToDisk(validated);
  broadcastControlEvent({
    type: 'config-updated',
    key: 'program-detection',
    updatedAt: Date.now(),
  });
  res.json(validated);
});

router.delete('/program-detection', async (_req, res) => {
  await fs.promises.unlink(PROGRAM_DETECTION_FILE).catch(() => undefined);
  applyProgramDetectionConfig({ ...DEFAULT_PROGRAM_DETECTION });
  broadcastControlEvent({
    type: 'config-updated',
    key: 'program-detection',
    updatedAt: Date.now(),
  });
  res.json(DEFAULT_PROGRAM_DETECTION);
});

router.post('/create', async (req, res) => {
  try {
    const { cwd: inputCwd, cols, rows, mode, tmuxSessionName, termType } = req.body;
    const normalizedMode = normalizeMode(mode);
    const normalizedTmuxName = normalizedMode === 'tmux' ? normalizeTmuxSessionName(tmuxSessionName) : null;

    // Deduplicate: if a TerminalSession for this tmux session already exists,
    // return it instead of creating a duplicate wrapper.  tmux's own
    // new-session -A already prevents duplicate tmux sessions.
    if (normalizedMode === 'tmux' && normalizedTmuxName) {
      for (const [id, s] of terminalSessions.entries()) {
        if (s.mode === 'tmux' && s.tmuxSessionName === normalizedTmuxName) {
          console.log(`Reusing existing terminal session ${id} for tmux:${normalizedTmuxName}`);
          // Heal shared tmux server/session options on reuse so long-lived
          // wrappers pick up capabilities added after they were created.
          await prepareManagedTmuxSession(normalizedTmuxName, typeof inputCwd === 'string' ? inputCwd : undefined);
          return res.json({
            sessionId: id,
            cols: cols || 80,
            rows: rows || 24,
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
      termType,
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
      const activePane = getActivePaneFromLayout(layout);
      const ap = activePane
        ? await resolveTmuxPaneProgram(activePane)
        : getActiveProgramFromTmuxLayout(layout);
      if (ap) session.activeProgram = { ...ap, updatedAt: Date.now() };
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
  if (updateGlobalBindingForBackendSession(sessionId, { cwd: session.cwd, lastActivity: session.lastActivity })) {
    persistAndBroadcastGlobalState();
  }

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
    tuiProgress: session.tuiProgress,
  });

  let tmuxInterval: ReturnType<typeof setInterval> | null = null;
  let activeProgramInterval: ReturnType<typeof setInterval> | null = null;
  let lastTmuxLayoutSnapshot = '';
  let lastActiveProgramSnapshot = JSON.stringify(session.activeProgram ?? null);
  let lastTmuxMetadata: TmuxRuntimeMetadata | null = null;
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
      const activePane = getActivePaneFromLayout(layout);
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
        if (updateGlobalBindingForBackendSession(sessionId, { cwd: newCwd, lastActivity: session.lastActivity })) {
          schedulePersistGlobalState();
        }
        writeSse(res, { type: 'cwd', cwd: newCwd });
      }
      // tmux 消费了 inner shell 发的 OSC 2/133，不透传到外层 PTY。
      // 从 tmux layout 提取 active pane 的 title 和 command 来推导。
      if (activePane) {
        const paneTitle = activePane.title || '';
        if (paneTitle && paneTitle !== session.lastOscTitle) {
          session.lastOscTitle = paneTitle;
          writeSse(res, { type: 'shell-title', title: paneTitle });
        }
        const paneCmd = activePane.command || '';
        const inferredState: 'idle' | 'running' =
          paneCmd && !shellNamesBackend.has(paneCmd) ? 'running' : 'idle';
        if (inferredState !== session.lastPromptState) {
          session.lastPromptState = inferredState;
          writeSse(res, { type: 'prompt-state', state: inferredState });
        }
      }
      // Mirror dynamic metadata onto tmux user options (cheap when nothing
      // changed thanks to the full metadata snapshot cache).
      const meta = syncDynamicTmuxMetadata({
        tmuxSessionName: session.tmuxSessionName,
        program: session.activeProgram?.command ?? null,
        cwd: session.cwd ?? null,
        previousMetadata: lastTmuxMetadata,
        lastActiveWriteAt: lastTmuxMetaWriteAt,
      });
      lastTmuxMetadata = { program: meta.program, cwd: meta.cwd, label: meta.label };
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
    const ok = applyPtyResize(sessionId, session, Number(cols), Number(rows), 'http-resize');
    if (!ok) {
      return res.status(400).json({ error: 'invalid cols/rows' });
    }
    res.json({ success: true, cols: session.cols, rows: session.rows });
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

      await prepareManagedTmuxSession(targetSessionName, session.cwd);
      await sendTmuxCommand(tmuxTarget, session.tmuxControl, ['switch-client', '-c', clientTty, '-t', targetSessionName]);
      session.tmuxSessionName = targetSessionName;
      session.lastActivity = Date.now();
      if (updateGlobalBindingForBackendSession(sessionId, {
        mode: 'tmux',
        tmuxSessionName: targetSessionName,
        cwd: session.cwd,
        lastActivity: session.lastActivity,
      })) {
        persistAndBroadcastGlobalState();
      }

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
    if (updateGlobalBindingForBackendSession(sessionId, {
      backendSessionId: newSessionId,
      mode: session.mode,
      tmuxSessionName: session.tmuxSessionName,
      cwd: session.cwd,
      lastActivity: session.lastActivity,
    })) {
      persistAndBroadcastGlobalState();
    }
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
      await prepareManagedTmuxSession(targetSessionName);
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
  if (updateGlobalBindingForBackendSession(sessionId, { cwd: session.cwd, lastActivity: session.lastActivity })) {
    persistAndBroadcastGlobalState();
  }

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
      tuiProgress: session.tuiProgress,
      focusTrackingRequested: session.focusTrackingRequested,
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
    let lastTmuxMetadata: TmuxRuntimeMetadata | null = null;
    let lastTmuxMetaWriteAt = 0;

    const sendTmuxLayout = async () => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        const layout = await getTmuxLayout(session.tmuxSessionName!);
        // Update active program — try ps-based detection for generic commands
        const activePane = getActivePaneFromLayout(layout);
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
          if (updateGlobalBindingForBackendSession(sessionId, { cwd: newCwd, lastActivity: session.lastActivity })) {
            schedulePersistGlobalState();
          }
          ws.send(JSON.stringify({ type: 'cwd', cwd: newCwd }));
        }
        // tmux 消费了 inner shell 发的 OSC 2（存入 pane_title）和 OSC 133，
        // 不透传到外层 PTY。因此从 tmux layout 提取 active pane 的 title
        // 和 command 来推导 shell-title / prompt-state。
        if (activePane) {
          const paneTitle = activePane.title || '';
          if (paneTitle && paneTitle !== session.lastOscTitle) {
            session.lastOscTitle = paneTitle;
            ws.send(JSON.stringify({ type: 'shell-title', title: paneTitle }));
          }
          // prompt-state: command 是 shell 名 → idle；否则 → running
          const paneCmd = activePane.command || '';
        const inferredState: 'idle' | 'running' =
          paneCmd && !shellNamesBackend.has(paneCmd) ? 'running' : 'idle';
        if (inferredState !== session.lastPromptState) {
          session.lastPromptState = inferredState;
          ws.send(JSON.stringify({ type: 'prompt-state', state: inferredState }));
          }
        }
        // Mirror dynamic metadata onto tmux user options.
        const meta = syncDynamicTmuxMetadata({
          tmuxSessionName: session.tmuxSessionName!,
          program: session.activeProgram?.command ?? null,
          cwd: session.cwd ?? null,
          previousMetadata: lastTmuxMetadata,
          lastActiveWriteAt: lastTmuxMetaWriteAt,
        });
        lastTmuxMetadata = { program: meta.program, cwd: meta.cwd, label: meta.label };
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
            session.ptyProcess.write(msg.data);
          }
          break;
        }
        case 'resize': {
          const cols = Number(msg.cols);
          const rows = Number(msg.rows);
          if (cols > 0 && rows > 0) {
            applyPtyResize(sessionId, session, cols, rows, `ws-resize:${clientId}`, clientId);
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
        case 'focus': {
          const focused = msg.focused === true;
          const reason = typeof msg.reason === 'string' ? msg.reason : 'client-focus';
          updateClientFocusState(sessionId, session, clientId, focused, reason);
          break;
        }
        case 'flow-control': {
          if (typeof msg.paused === 'boolean') {
            const reason = typeof msg.reason === 'string' ? msg.reason : 'client-flow-control';
            setClientFlowPaused(sessionId, session, clientId, msg.paused, reason);
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
    removeClientFocus(sessionId, session, clientId);
    removeClientFlowPaused(sessionId, session, clientId, 'client-disconnect');
    syncClientCountToTmux(sessionId);
    broadcastClientState();
  });

  ws.on('error', () => {
    // close handler will clean up
  });
}

// Refresh global tmux server options on every server start so existing tmux
// sessions pick up focus tracking and the latest copy-mode wheel bindings.
ensureSharedTmuxServerReady().catch(() => {});

// ── Control WebSocket handler ──
//
// A separate, lightweight WS that exists purely to push client-state changes
// to every connected browser. We don't accept commands here (mutations still
// go through HTTP PUT/DELETE for CSRF + auth reuse); this channel is one-way
// server→client, with a server-initiated snapshot on connect and a small
// heartbeat to detect zombie sockets on iOS PWA resumes.
export function handleControlWebSocket(ws: WebSocket, clientId: string): void {
  controlClients.set(clientId, ws);

  // Initial snapshot — same shape the HTTP GET returns, with an inventory
  // projection when tmux/backend state can be queried immediately.
  void (async () => {
    const initialSeq = broadcastInventorySeq;
    const inventory = await getSessionInventorySnapshot().catch((error) => {
      console.warn('[session-inventory] failed to build initial control snapshot:', getErrorMessage(error));
      return latestSessionInventory;
    });
    if (initialSeq !== broadcastInventorySeq) {
      // A fresher broadcast was sent while this inventory was being built.
      // Dropping this initial snapshot avoids replaying stale inventory with
      // the latest seq; the next reconnect/control broadcast will provide a
      // fresh baseline.
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'client-state', seq: initialSeq, state: globalSessionState, inventory: inventory ?? latestSessionInventory }));
    } catch {
      controlClients.delete(clientId);
      return;
    }
  })();

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
