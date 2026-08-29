import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { promisify } from 'util';
import type { WebSocket } from 'ws';
import { caffeinateManager } from '../utils/caffeinate.js';
import { gitStatusCache, type GitStatus } from '../utils/gitStatus.js';
import { getPtyHostManager, type PtyHostClient } from '../ptyhost/manager.js';
import { pathValidator } from '../utils/pathValidator.js';
import { TERMINAL, TMUX } from '../config.js';
import { localAccessManager } from '../utils/localAccess.js';
import {
  normalizeLocalAccessName,
  getLocaleSetting,
  setLocaleSetting,
  getContextDraftHeightSetting,
  setContextDraftHeightSetting,
  getAutoRenameAgentsSetting,
  setAutoRenameAgentsSetting,
  getAutoRenameNamerSetting,
  setAutoRenameNamerSetting,
  getAutoRenameModelsSetting,
  setAutoRenameModelsSetting,
  getAutoRenameIntervalMinutesSetting,
  setAutoRenameIntervalMinutesSetting,
  getAutoRenamePromptPreferenceSetting,
  setAutoRenamePromptPreferenceSetting,
  getAutoRenamePromptPayloadCharsSetting,
  setAutoRenamePromptPayloadCharsSetting,
  getNewSessionAgentSlugSetting,
  setNewSessionAgentSlugSetting,
} from '../utils/settings.js';
import { loadContextDraft, saveContextDraft } from '../utils/contextDraft.js';
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
import {
  agentBySlug,
  buildResumeCommand,
  detectAgentFromCommand,
  listAgents,
  type AgentInfo,
} from '../agent/registry.js';
import {
  applyAgentEvent,
  agentEventMatchesCurrentAgent,
  defaultAgentSessionState,
  parseAgentEvent,
  type AgentEvent,
  type AgentSessionState,
  type AgentSessionStatus,
  type AgentStatusTone,
} from '../agent/session.js';
import {
  canRestoreDeadAgentShell,
  normalizePersistedAgentResumeInfo,
  type PersistedAgentResumeInfo,
} from '../agent/resumePersistence.js';
import { AgentResumeHistoryStore, type AgentResumeHistoryReason } from '../agent/resumeHistory.js';
import { AutomationStore, normalizeAutomationSchedule, type AgentAutomation } from '../agent/automationStore.js';
import { CollaborationStore, type CollaborationMessage, type CollaborationMessageKind } from '../agent/collaborationStore.js';
import { SessionSearchStore, type SessionSearchMetadata } from '../agent/sessionSearchStore.js';
import {
  listAllHookAgents,
  refreshStaleHooksAtLaunch,
  installHooksForSlug,
  uninstallHooksForSlug,
} from '../agent/installers.js';
import {
  loadPlugins,
  savePlugin,
  removePlugin,
  readPluginIcon,
  validateManifest,
} from '../agent/plugins.js';
import {
  checkPluginPackageUpdate,
  commitPreparedPlugin,
  preparePluginPackage,
} from '../agent/pluginPackages.js';
import { clearPluginAgents, registerPluginAgents } from '../agent/registry.js';
import { notifyAgentTransition, notifyTerminalExit } from '../notifications/pushService.js';
import { setClientViewingSession } from '../notifications/pushViewers.js';
import {
  getQuotaStatus,
  refreshQuota,
  startQuotaManager,
} from '../quota/QuotaManager.js';
import type { QuotaStatusWirePayload } from '../quota/types.js';
import { TermdockAutoUpdateManager } from '../utils/autoUpdate.js';
import {
  AUTO_TITLE_LONG_RUNNING_DELAY_MS,
  AUTO_TITLE_MIN_CONTEXT_CHARS,
  cleanTerminalContext,
  generateAgentTitle,
  hasSubstantiveAutoTitleContext,
  isLongRunningAutoTitleTurnEligible,
  isNewAgentSessionId,
  isAutoTitleReevaluationDue,
  shouldReplaceAutoTitle,
} from '../agent/autoTitle.js';
import { getTitleNamerCatalog, invalidateTitleNamerCatalog, probePluginTitleNamer } from '../agent/titleNamerCatalog.js';
import { RenderedTerminalContext } from '../agent/renderedTerminalContext.js';

const router: express.Router = express.Router();
const execFileAsync = promisify(execFile);
const TERMDOCK_DIR = `${os.homedir()}/.termdock`;
const automationStore = new AutomationStore(`${TERMDOCK_DIR}/automations.json`);
const collaborationStore = new CollaborationStore(`${TERMDOCK_DIR}/collaboration-groups.json`);
const sessionSearchStore = new SessionSearchStore(`${TERMDOCK_DIR}/session-search`);
let atomicJsonWriteSequence = 0;

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
  const temporaryPath = `${filePath}.${process.pid}.${++atomicJsonWriteSequence}.tmp`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporaryPath, 'w');
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
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
  lastOutputAt: number;
  clients: Map<string, express.Response>;
  createdAt: number;
  hasWrittenData: boolean;
  activeProgram: {
    command: string | null;
    source: 'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown';
    rawArgs: string | null;
    updatedAt: number;
  } | null;
  // Recognized coding-agent identity (from argv against the registry) and the
  // rich hook-driven session state; see server/agent/*. agentSession exists
  // only while an agent is detected in the foreground.
  agent: AgentInfo | null;
  agentSession: AgentSessionState | null;
  /** A fresh shell replaced a dead PTY and still offers its persisted Agent conversation. */
  agentResumeRecovered: boolean;
  /** Rendered terminal text from the current agent turn, including bounded scrollback. */
  autoTitleContext: string;
  /** Headless terminal that collapses transient redraws before they reach title generation. */
  autoTitleTerminal: RenderedTerminalContext;
  /** Raw prompt-submit hook payloads, bounded per Agent session. */
  autoTitlePromptPayloads: string[];
  /** One delayed first-title attempt for an agent turn that has not emitted stop yet. */
  autoTitleLongRunningTimer: ReturnType<typeof setTimeout> | null;
  /** Allows stop to refine the provisional title without waiting for the normal refresh interval. */
  autoTitleGeneratedMidTurn: boolean;
  /** True after this server instance has observed a real prompt submission for the native agent session. */
  autoTitleObservedPrompt: boolean;
  /** True only between that prompt submission and its stop/session-end event. */
  autoTitleTurnActive: boolean;
  // Carries reviewed across agentSession nullification in syncAgentIdentity so
  // the yellow unread dot survives the poll window. Cleared on manual ack.
  lastAgentReviewed: boolean | null;
  // Timestamp when the agent first disappeared from the foreground poll.
  // Debounces "agent exited" notifications: a subcommand that briefly takes the
  // foreground group should not trigger a false exit. Only when the agent stays
  // absent for AGENT_EXIT_DEBOUNCE_MS do we clear the session and broadcast.
  agentLeftAt: number | null;
  // Shared git snapshot for the pane's cwd (branch +N −M), refreshed on cwd
  // change / command end / agent tool activity via the repo-root cache.
  gitStatus: GitStatus | null;
  gitStatusKey: string | null;
  gitAgentActivitySeen: number;
  dataDisposable?: { dispose: () => void };
  exitDisposable?: { dispose: () => void };
  tmuxControl?: TmuxControl;
  oscSniffBuf: string;
  lastOscCwd: string | null;
  lastOscTitle: string | null;
  lastPromptState: 'idle' | 'running' | null;
  tuiProgress: TuiProgressReport | null;
  focusTrackingRequested: boolean;
  focusModeSniffBuf: string;
  focusAggregation: FocusAggregationState;
  flowPausedClients: Set<string>;
  flowPausedClientTimers: Map<string, ReturnType<typeof setTimeout>>;
  ptyPausedForFlowControl: boolean;
  // tmux 的 resize 和随后滚轮输入必须按同一条顺序链执行。PTY winsize 已经
  // 更新并不代表浏览器里 xterm 的差分屏幕一定仍与 tmux grid 同步；首次
  // resize 后滚动前，用 capture-pane 发一份权威屏幕重建，避免错误差分继续
  // 叠加。Promise 链只等待实际 tmux 命令，不使用固定时延。
  tmuxIoChain?: Promise<void>;
  tmuxScreenSyncClients?: Set<string>;
  tmuxResizeGeneration?: number;
}

type TuiProgressReport = {
  state: 'remove' | 'set' | 'error' | 'indeterminate' | 'pause';
  progress: number | null;
};

interface PersistedClientSession {
  sessionId: string;
  name: string;
  customName?: boolean;
  /** Present only when customName was produced by Termdock, so later turns may refresh it. */
  autoTitle?: { agentSlug: string; contentHash: string; updatedAt: number } | null;
  backendSessionId: string | null;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  createdAt: number;
  lastActivity: number;
  cwd?: string | null;
  // 最后检测到的前台程序名（last-known）：live 检测只写非空值、不用 null 覆盖,
  // 这样 server 重启 / backend 掉线后 tab 标题仍能回退到最近一次识别结果。
  activeProgram?: string | null;
  // 最近一次的 agent 会话恢复信息（last-known）：agent 退出 / server 重启后
  // 仍可用其原生 session id + 启动参数重建 `claude --resume …` 恢复命令。
  agentResume?: PersistedAgentResumeInfo | null;
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
const agentResumeHistory = new AgentResumeHistoryStore(`${TERMDOCK_DIR}/agent-resume-history.json`);
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

let serverRestartScheduled = false;

function requestServerRestartAfterUpdate(): void {
  if (serverRestartScheduled) return;
  serverRestartScheduled = true;

  // The bridge is detached before this process exits. It waits for the old
  // PID to release the port, then resolves `termdock` from PATH again so an
  // npm-replaced global binary is used instead of the old loaded file.
  const bridgeSource = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const payload = JSON.parse(process.argv[1]);
const alive = () => { try { process.kill(payload.parentPid, 0); return true; } catch { return false; } };
const launch = () => {
  let fd;
  try { fd = fs.openSync(payload.logFile, 'a'); } catch { fd = 'ignore'; }
  const command = process.platform === 'win32' ? 'termdock.cmd' : 'termdock';
  const child = spawn(command, payload.args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();
  if (typeof fd === 'number') fs.closeSync(fd);
};
const deadline = Date.now() + 15000;
const timer = setInterval(() => {
  if (alive() && Date.now() < deadline) return;
  clearInterval(timer);
  setTimeout(launch, 250);
}, 100);
`;
  const payload = JSON.stringify({
    parentPid: process.pid,
    args: process.argv.slice(2),
    logFile: path.join(TERMDOCK_DIR, 'server.log'),
  });
  const bridge = spawn(process.execPath, ['-e', bridgeSource, payload], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  bridge.unref();

  const exitTimer = setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, 750);
  exitTimer.unref?.();
}

const npmAutoUpdateManager = new TermdockAutoUpdateManager({
  currentVersion: TERMDOCK_VERSION,
  stateFilePath: path.join(TERMDOCK_DIR, 'update-state.json'),
  broadcast: (state) => broadcastControlEvent({ type: 'update-state', state }),
  requestRestart: requestServerRestartAfterUpdate,
  log: (message) => console.warn(message),
});

// Packaged desktop builds already have a signed app/runtime updater. The npm
// updater only owns standalone CLI services, otherwise both mechanisms could
// race to replace the runtime.
if (process.env.TERMDOCK_DESKTOP !== '1') {
  npmAutoUpdateManager.start();
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
  // pty-host adoption runs after the state load (its record upserts must not
  // be clobbered) and before pruning (surviving shell records' backends are
  // live in the host, so they're not orphans).
  await adoptPtyHostSessions().catch((error) => {
    console.warn('[pty-host] adoption failed:', (error as Error).message);
  });
  pruneOrphanSessions();
  await backfillPersistedTmuxMetadata();
})();
caffeinateManager.startNetworkMonitor();

// 清理磁盘恢复后后端已不存在的 session 引用。
// 服务重启时 terminalSessions 是空的，持久化的 global state
// 全部指向已销毁的 session。普通 shell session 的 PTY 已死无法复用；若记录
// 带有 Agent 原生 session id，则保留条目并清空 backendSessionId，让前端在原 cwd
// 建一个新 shell 后继续恢复 Agent。tmux 仍由独立进程负责存活。
function pruneOrphanSessions(): void {
  let changed = false;
  const cleaned = globalSessionState.sessions.filter((s) => {
    // A shell PTY cannot be reattached after a host reboot, but its Agent
    // conversation can be resumed in a newly-created shell.
    if (s.mode !== 'tmux') {
      if (s.backendSessionId != null && !terminalSessions.has(s.backendSessionId)) {
        changed = true;
        return canRestoreDeadAgentShell(s);
      }
      // backendSessionId already null: only a resumable Agent record is useful.
      if (s.backendSessionId == null) {
        const keep = canRestoreDeadAgentShell(s);
        if (!keep) changed = true;
        return keep;
      }
      return true;
    }
    // Tmux sessions: tmux process may still be alive, keep but clear backend ref
    if (s.backendSessionId != null && !terminalSessions.has(s.backendSessionId)) {
      changed = true;
    }
    return true;
  }).map((s) => {
    if (s.mode === 'shell' && s.backendSessionId != null && !terminalSessions.has(s.backendSessionId)) {
      return { ...s, backendSessionId: null };
    }
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
        // Agent-hook plumbing (see ensureManagedTmuxSessionReady): backfilled
        // at startup so sessions created before this feature get it too.
        'allow-passthrough': 'on',
      };
      const existingCreatedAt = await getTmuxOption(s.tmuxSessionName, '@termdock-created-at');
      if (!existingCreatedAt) {
        baseOptions['@termdock-created-at'] = String(Date.now());
      }
      await setTmuxOptions(s.tmuxSessionName, baseOptions);
      try {
        await runTmux(['set-environment', '-t', s.tmuxSessionName, 'TERMDOCK', '1']);
      } catch { /* best effort */ }

      if (s.customName === true && typeof s.name === 'string' && s.name.trim().length > 0) {
        await setTmuxOption(s.tmuxSessionName, '@termdock-friendly-name', s.name);
      }

      // label/program/cwd 是动态值，正常由在线轮询维护；这里只在缺失时补——
      // 用持久化记录里的 last-known 计算,保证 server 重启后、首个客户端连上前,
      // CLI(td --tls / tmux show)已经能看到名字。已有值不覆盖(可能更新鲜)。
      const existingLabel = await getTmuxOption(s.tmuxSessionName, '@termdock-label');
      if (!existingLabel) {
        const program = normalizeMetadataProgram(s.activeProgram ?? null);
        const label = buildTermdockLabel({
          friendlyName: s.customName === true && s.name.trim().length > 0 ? s.name : null,
          program,
          cwd: s.cwd ?? null,
          sessionName: s.tmuxSessionName,
        });
        await setTmuxOptions(s.tmuxSessionName, {
          '@termdock-label': label,
          '@termdock-program': program ?? '',
          '@termdock-cwd': s.cwd ?? '',
        });
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

// 终端配置（从 config.ts 读环境变量，getter 保证 dotenv 加载后仍然正确）
// 以下常量从 config.ts getter 读取，不再直接读 process.env
const TERMINAL_IDLE_TIMEOUT = TERMINAL.idleTimeout;
const CLEANUP_INTERVAL = TERMINAL.cleanupInterval;
const RECONNECT_SCROLLBACK = TERMINAL.reconnectScrollback;
const TMUX_POLL_INTERVAL = parseInt(process.env.TMUX_POLL_INTERVAL || '500', 10);
const ACTIVE_PROGRAM_POLL_INTERVAL = parseInt(process.env.TERMINAL_ACTIVE_PROGRAM_POLL_INTERVAL || '1200', 10);
const TMUX_LAYOUT_CACHE_TTL_MS = Math.max(TMUX_POLL_INTERVAL, 1000);
const PROCESS_SNAPSHOT_CACHE_TTL_MS = Math.max(ACTIVE_PROGRAM_POLL_INTERVAL, 2500);
const FLOW_CONTROL_PAUSE_LEASE_MS = TERMINAL.flowControlPauseLeaseMs;
const TMUX_DELIMITER = '\x1f';
const TERMDOCK_TMUX_HISTORY_LIMIT = TMUX.historyLimit;
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
    autoTitle: candidate.autoTitle
      && typeof candidate.autoTitle.agentSlug === 'string'
      && typeof candidate.autoTitle.contentHash === 'string'
      && typeof candidate.autoTitle.updatedAt === 'number'
      ? candidate.autoTitle
      : null,
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
    activeProgram: typeof candidate.activeProgram === 'string' && candidate.activeProgram.trim().length > 0
      ? candidate.activeProgram
      : null,
    agentResume: normalizePersistedAgentResumeInfo(candidate.agentResume),
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
    activeProgram: session.activeProgram?.command ?? getPersistedActiveProgramForBackend(backendSessionId),
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
  const changed = globalSessionState.sessions.length !== before;
  if (changed) collaborationStore.removeSession(frontendSessionId);
  return changed;
}

function archiveAgentResumeRecord(record: PersistedClientSession | null | undefined, reason: AgentResumeHistoryReason): boolean {
  if (!record || record.mode !== 'shell' || !record.agentResume?.sessionId) return false;
  return agentResumeHistory.archive({
    title: record.name.trim() || 'Terminal',
    titleSource: record.customName === true ? 'custom' : record.autoTitle ? 'auto' : 'default',
    agent: record.agentResume,
    cwd: record.cwd ?? '',
    reason,
  }) !== null;
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
  const shouldOfferRecoveredAgent = record.mode === 'shell'
    && canRestoreDeadAgentShell(record)
    && (!record.backendSessionId || !terminalSessions.has(record.backendSessionId));
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

  // 记录里的 cwd 是服务端自己从 OSC 跟踪写入的（受信任）。服务重启后
  // 白名单会重置为默认值，恢复一个 cwd 在白名单外的会话（例如 Windows
  // 其它盘符）会被 resolveWorkingDirectory 拒绝——先放行再 spawn。
  if (spawnCwd) {
    await pathValidator.allowSessionCwd(spawnCwd);
  }
  const spawned = await spawnTerminalSession(req, {
    cwd: spawnCwd,
    cols: options.cols,
    rows: options.rows,
    mode: record.mode,
    tmuxSessionName: record.tmuxSessionName ?? undefined,
    termType: options.termType,
  });
  spawned.session.agentResumeRecovered = shouldOfferRecoveredAgent;
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

// 把检测到的前台程序名写进持久化记录（last-known 语义）：
// - 只在非空且与已存值不同才写,null 不覆盖（检测瞬时空窗不该抹掉上次结果）;
// - 变化频率低（程序切换才触发）,debounce 落盘即可。
function persistActiveProgramBinding(backendSessionId: string, command: string | null | undefined): void {
  if (!command) return;
  const record = globalSessionState.sessions.find((session) => session.backendSessionId === backendSessionId);
  if (!record || record.activeProgram === command) return;
  upsertGlobalSessionRecord({ ...record, activeProgram: command });
  schedulePersistGlobalState();
}

// connected / open 响应用的兜底:live 检测还没出结果时,回退到磁盘上的 last-known,
// 前端首帧就能显示上次的程序名而不是裸 session 名。
function getPersistedActiveProgramForBackend(backendSessionId: string): string | null {
  const record = globalSessionState.sessions.find((session) => session.backendSessionId === backendSessionId);
  return record?.activeProgram ?? null;
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

interface OrchestrationSessionSnapshot {
  sessionId: string;
  backendSessionId: string | null;
  name: string;
  cwd: string;
  agent: { slug: string; displayName: string } | null;
  status: AgentSessionStatus | 'shell' | 'offline';
  capability: string;
  currentTask: string;
  updatedAt: number;
}

function orchestrationSessionSnapshot(record: PersistedClientSession): OrchestrationSessionSnapshot {
  const backend = record.backendSessionId ? terminalSessions.get(record.backendSessionId) : null;
  const agent = backend?.agent ?? (record.agentResume?.slug ? agentBySlug(record.agentResume.slug) : null);
  const latestPrompt = backend?.autoTitlePromptPayloads.at(-1)?.trim() ?? '';
  return {
    sessionId: record.sessionId,
    backendSessionId: record.backendSessionId ?? null,
    name: record.name,
    cwd: backend?.cwd ?? record.cwd ?? '',
    agent: agent ? { slug: agent.slug, displayName: agent.displayName } : null,
    status: backend?.agentSession?.status ?? (backend ? 'shell' : 'offline'),
    capability: agent
      ? [agent.displayName, ...(agent.capabilities ?? []), backend?.activeProgram?.command || record.activeProgram || 'Agent 会话'].join(' · ')
      : (backend?.activeProgram?.command || record.activeProgram || 'Shell 终端'),
    currentTask: latestPrompt || record.name,
    updatedAt: backend?.lastActivity ?? record.lastActivity,
  };
}

function searchMetadataForBackend(backendSessionId: string, session: TerminalSession): SessionSearchMetadata | null {
  const record = globalSessionState.sessions.find((candidate) => candidate.backendSessionId === backendSessionId);
  if (!record) return null;
  return {
    sessionId: record.sessionId,
    backendSessionId,
    title: record.name,
    cwd: session.cwd ?? record.cwd ?? '',
    agentSlug: session.agent?.slug ?? record.agentResume?.slug ?? null,
    agentNativeSessionId: session.agentSession?.sessionId ?? record.agentResume?.sessionId ?? null,
    updatedAt: session.lastActivity,
  };
}

function writeTerminalInput(session: TerminalSession, value: string): void {
  session.ptyProcess.write(value.replace(/\r?\n/g, '\r'));
}

function deliverAutomationPromptWhenReady(backendSessionId: string, prompt: string, attempt = 0): void {
  const session = terminalSessions.get(backendSessionId);
  if (!session) return;
  if (session.agent || session.agentSession || attempt >= 60) {
    writeTerminalInput(session, `${prompt}\r`);
    return;
  }
  setTimeout(() => deliverAutomationPromptWhenReady(backendSessionId, prompt, attempt + 1), 250);
}

async function runAgentAutomation(automation: AgentAutomation, req?: express.Request): Promise<void> {
  const run = automationStore.beginRun(automation);
  let frontendSessionId: string | null = null;
  try {
    if (automation.targetSessionId) {
      const record = globalSessionState.sessions.find((candidate) => candidate.sessionId === automation.targetSessionId);
      const backend = record?.backendSessionId ? terminalSessions.get(record.backendSessionId) : null;
      if (!record || !backend) throw new Error('目标会话当前不在线');
      if (!backend.agentSession) throw new Error('目标会话当前没有运行中的 Agent');
      frontendSessionId = record.sessionId;
      const message = automation.prompt || automation.command;
      if (!message) throw new Error('自动任务没有可发送的内容');
      writeTerminalInput(backend, `${message}\r`);
    } else {
      const request = req ?? ({} as express.Request);
      const opened = await openInventorySession(request, {
        name: automation.name,
        customName: true,
        mode: 'shell',
        cwd: automation.cwd,
      });
      frontendSessionId = opened.session.sessionId;
      const backend = terminalSessions.get(opened.terminalSession.sessionId);
      if (!backend) throw new Error('自动任务会话创建失败');
      if (automation.command) writeTerminalInput(backend, `${automation.command}\r`);
      if (automation.prompt) {
        if (automation.command) deliverAutomationPromptWhenReady(opened.terminalSession.sessionId, automation.prompt);
        else writeTerminalInput(backend, `${automation.prompt}\r`);
      }
    }
    automationStore.finishRun(run.id, 'success', frontendSessionId, '任务已投递');
  } catch (error) {
    automationStore.finishRun(run.id, 'failed', frontendSessionId, getErrorMessage(error));
    throw error;
  }
}

function collaborationMessageLabel(kind: CollaborationMessageKind): string {
  return ({ message: '消息', ask: '问题', reply: '回复', task: '任务', handoff: '交接', done: '完成' } as const)[kind];
}

function resolveFrontendSessionId(input: { sessionId?: unknown; backendSessionId?: unknown; tmuxSessionName?: unknown }): string | null {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (sessionId && globalSessionState.sessions.some((record) => record.sessionId === sessionId)) return sessionId;
  const backendSessionId = typeof input.backendSessionId === 'string' ? input.backendSessionId.trim() : '';
  if (backendSessionId) {
    const resolved = globalSessionState.sessions.find((record) => record.backendSessionId === backendSessionId)?.sessionId;
    if (resolved) return resolved;
  }
  const tmuxSessionName = typeof input.tmuxSessionName === 'string' ? input.tmuxSessionName.trim() : '';
  return globalSessionState.sessions.find((record) => record.tmuxSessionName === tmuxSessionName)?.sessionId ?? null;
}

function formatCollaborationDelivery(targetSessionId: string, messages: CollaborationMessage[]): string {
  const targetGroups = new Map(collaborationStore.groupsForSession(targetSessionId).map((group) => [group.id, group]));
  const lines = messages.map((message) => {
    const from = message.fromSessionId
      ? globalSessionState.sessions.find((record) => record.sessionId === message.fromSessionId)?.name ?? message.fromSessionId
      : '用户';
    const group = targetGroups.get(message.groupId)?.name ?? '协作组';
    return `- [${collaborationMessageLabel(message.kind)} #${message.id}] ${from} → ${group}: ${message.content}`;
  });
  return `[Termdock 协作收件箱]\n${lines.join('\n')}\n请处理这些消息。需要回复时运行：td collab reply <消息ID> "回复内容"；查看成员和未读消息运行：td collab status / td collab inbox。`;
}

function tryDeliverCollaborationInbox(frontendSessionId: string): { delivered: string[]; pending: number } {
  const record = globalSessionState.sessions.find((candidate) => candidate.sessionId === frontendSessionId);
  const session = record?.backendSessionId ? terminalSessions.get(record.backendSessionId) : null;
  const pending = collaborationStore.inbox(frontendSessionId, { pendingOnly: true, limit: 10 });
  // Rich hooks let us avoid interrupting an active turn. Third-party plugins
  // without hooks still participate through the universal detected-Agent PTY
  // path; their busy state is simply unknown, so delivery is immediate.
  if (!session?.agent || pending.length === 0
    || (session.agentSession?.rich && !['idle', 'done'].includes(session.agentSession.status))) {
    return { delivered: [], pending: pending.length };
  }
  writeTerminalInput(session, `${formatCollaborationDelivery(frontendSessionId, pending)}\r`);
  collaborationStore.markDelivered(pending.map((message) => message.id));
  return { delivered: pending.map((message) => message.id), pending: 0 };
}

function getTmuxBinary(): string {
  if (process.env.TMUX_BIN) return process.env.TMUX_BIN;

  // macOS 非交互式 SSH 的 PATH 不含 Homebrew，手动探测常见路径
  const candidates = [
    'tmux',                    // PATH lookup
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/opt/local/bin/tmux',     // MacPorts
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return 'tmux';  // fallback to PATH
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
    // xterm reports button-motion in character cells. A one-cell movement is
    // common mouse jitter during an ordinary click, so require two cells before
    // treating the gesture as an intentional text-selection drag.
    "if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'if-shell -F \"#{||:#{||:#{e|>=:#{e|-:#{mouse_x},#{@termdock-mouse-down-x}},2},#{e|>=:#{e|-:#{@termdock-mouse-down-x},#{mouse_x}},2}},#{||:#{e|>=:#{e|-:#{mouse_y},#{@termdock-mouse-down-y}},2},#{e|>=:#{e|-:#{@termdock-mouse-down-y},#{mouse_y}},2}}}\" \"copy-mode -M\"'",
  ]);
  await runTmux([
    'bind-key', '-n', 'DoubleClick1Pane',
    "select-pane -t= ; if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'copy-mode -H ; send-keys -X select-word ; run-shell -d 0.3 ; send-keys -X copy-pipe-no-clear'",
  ]);
  await runTmux([
    'bind-key', '-n', 'TripleClick1Pane',
    "select-pane -t= ; if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'copy-mode -H ; send-keys -X select-line ; run-shell -d 0.3 ; send-keys -X copy-pipe-no-clear'",
  ]);

  // tmux defaults mouse selection shortcuts to copy-pipe-and-cancel:
  // selecting text with the mouse copies successfully, then immediately exits
  // copy-mode on release/double-click. Termdock keeps copy-mode open so users
  // can continue inspecting scrollback after one selection.
  for (const table of ['copy-mode', 'copy-mode-vi']) {
    try {
      await runTmux(['bind-key', '-T', table, 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-pipe-no-clear']);
    } catch {
      await runTmux(['bind-key', '-T', table, 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-selection']);
    }

    for (const [key, selectionCommand] of [
      ['DoubleClick1Pane', 'select-word'],
      ['TripleClick1Pane', 'select-line'],
    ] as const) {
      try {
        await runTmux([
          'bind-key', '-T', table, key,
          `select-pane ; send-keys -X ${selectionCommand} ; run-shell -d 0.3 ; send-keys -X copy-pipe-no-clear`,
        ]);
      } catch {
        await runTmux([
          'bind-key', '-T', table, key,
          `select-pane ; send-keys -X ${selectionCommand} ; run-shell -d 0.3 ; send-keys -X copy-selection`,
        ]);
      }
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
  let synchronizedPersistedFields = false;
  globalSessionState = {
    sessions: globalSessionState.sessions.map((session) => {
      let next = session;

      // CLI 侧改了 @termdock-friendly-name → 反向同步进持久化记录（tmux 限定）。
      if (next.mode === 'tmux' && next.tmuxSessionName) {
        const friendlyName = liveTmuxByName.get(next.tmuxSessionName)?.friendlyName?.trim();
        if (friendlyName && !(next.customName === true && next.name === friendlyName)) {
          next = { ...next, name: friendlyName, customName: true };
          synchronizedPersistedFields = true;
        }
      }

      // 展示名数据（activeProgram / cwd）回写:last-known 持久化,server 重启 /
      // backend 掉线后 inventory hint 仍能给出上次的程序名与目录。
      // live 值只以非空覆盖——检测空窗(null)不抹掉已存结果。
      const backend = next.backendSessionId ? terminalSessions.get(next.backendSessionId) : undefined;
      const tmuxMeta = next.tmuxSessionName ? liveTmuxByName.get(next.tmuxSessionName) : undefined;
      const liveProgram = backend?.activeProgram?.command ?? tmuxMeta?.program ?? null;
      const liveCwd = backend?.cwd ?? tmuxMeta?.cwd ?? null;
      if (liveProgram && liveProgram !== (next.activeProgram ?? null)) {
        next = { ...next, activeProgram: liveProgram };
        synchronizedPersistedFields = true;
      }
      if (liveCwd && liveCwd !== (next.cwd ?? null)) {
        next = { ...next, cwd: liveCwd };
        synchronizedPersistedFields = true;
      }
      return next;
    }),
    updatedAt: synchronizedPersistedFields ? Date.now() : globalSessionState.updatedAt,
  };
  if (synchronizedPersistedFields) {
    schedulePersistGlobalState();
  }

  const clientSessions = globalSessionState.sessions.map((session): SessionInventoryClientSession => {
    const backendLive = !!session.backendSessionId && terminalSessions.has(session.backendSessionId);
    const tmuxLive = session.mode === 'tmux' && !!session.tmuxSessionName && liveTmuxByName.has(session.tmuxSessionName);
    const live = session.mode === 'tmux' ? tmuxLive : backendLive;

    // 展示名提示（activeProgram / cwd）：优先取在线 backend session 的实时值，
    // 其次回退到 tmux 清单里的 program/cwd（tmux 模式即使 backend 未 attach，
    // tmux 服务端仍能给出当前 pane 的程序与目录），最后回退到持久化记录里的
    // last-known 值（server 重启 / tmux 已死也能显示上次的标题）。让前端 hydrate 即可显示。
    const backend = backendLive ? terminalSessions.get(session.backendSessionId!) : undefined;
    const tmuxMeta = session.tmuxSessionName ? liveTmuxByName.get(session.tmuxSessionName) : undefined;
    const activeProgram = backend?.activeProgram?.command ?? tmuxMeta?.program ?? session.activeProgram ?? null;
    const cwd = backend?.cwd ?? tmuxMeta?.cwd ?? session.cwd ?? null;

    return {
      ...session,
      frontendSessionId: session.sessionId,
      customName: session.customName === true,
      connected: backendLive,
      live,
      restorable: !backendLive && (
        (session.mode === 'tmux' && tmuxLive)
        || (session.mode === 'shell' && canRestoreDeadAgentShell(session))
      ),
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

const TMUX_SCREEN_RESET = '\u001b[H\u001b[2J\u001b[3J';

function buildTmuxScreenSnapshot(snapshot: string): string[] {
  return [
    TMUX_SCREEN_RESET,
    // capture-pane is line-oriented, whereas live tmux output contains the
    // carriage returns required by convertEol=false.
    snapshot.replace(/\r?\n/g, '\r\n'),
  ];
}

function enqueueTmuxIo<T>(session: TerminalSession, operation: () => Promise<T> | T): Promise<T> {
  const previous = session.tmuxIoChain ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  // Keep the sequencing tail fulfilled so one failed capture/command cannot
  // permanently poison all later input for the session.
  session.tmuxIoChain = result.then(() => undefined, () => undefined);
  return result;
}

function markTmuxClientsForScreenSync(sessionId: string, session: TerminalSession): void {
  if (session.mode !== 'tmux') return;
  const clients = wsClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const pending = session.tmuxScreenSyncClients ?? new Set<string>();
  for (const clientId of clients.keys()) pending.add(clientId);
  session.tmuxScreenSyncClients = pending;
  session.tmuxResizeGeneration = (session.tmuxResizeGeneration ?? 0) + 1;
}

function isTmuxWheelInput(data: string): boolean {
  return /^(?:\u001b\[<6[45];\d+;\d+[Mm])+$/.test(data);
}

async function syncTmuxScreenBeforeScroll(
  sessionId: string,
  clientId: string,
  session: TerminalSession,
  ws: WebSocket,
): Promise<void> {
  if (
    session.mode !== 'tmux'
    || !session.tmuxSessionName
    || !session.tmuxScreenSyncClients?.has(clientId)
  ) {
    return;
  }

  const generation = session.tmuxResizeGeneration ?? 0;
  try {
    // This command enters tmux's own event loop after node-pty has applied the
    // new winsize. It is an ordering barrier based on real work, not a timeout.
    // The following capture is therefore taken from tmux's resized grid.
    const preferredClientPid = getPtyProcessPid(session.ptyProcess);
    const clientTty = await resolveTmuxClientTty(session.tmuxSessionName, preferredClientPid);
    if (clientTty) {
      await runTmux(['refresh-client', '-t', clientTty]);
    }

    const snapshot = await captureTmuxPane(session.tmuxSessionName);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'tmux-screen-sync',
        chunks: buildTmuxScreenSnapshot(snapshot),
        cols: session.cols,
        rows: session.rows,
        generation,
      }));
      session.tmuxScreenSyncClients.delete(clientId);
      if (session.tmuxScreenSyncClients.size === 0) {
        session.tmuxScreenSyncClients = undefined;
      }
    }
  } catch (error) {
    // Keep the client marked dirty. Its next wheel event retries the exact
    // synchronization instead of permanently accepting a partial screen.
    console.warn(
      `[tmux-screen-sync] failed session=${sessionId} client=${clientId}: ${getErrorMessage(error)}`,
    );
  }
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
  const parsePathPart = (pathPart: string): string | null => {
    const trimmedPath = pathPart.trim();
    if (!trimmedPath) return null;
    if (trimmedPath.startsWith('~/') || trimmedPath.startsWith('~\\')) return home + trimmedPath.slice(1);
    if (trimmedPath === '~') return home;
    if (trimmedPath.startsWith('/') || isWindowsAbsolutePath(trimmedPath)) return trimmedPath;
    return null;
  };

  // Format: user@host:/path/to/dir
  const atIdx = title.lastIndexOf('@');
  if (atIdx >= 0) {
    const afterAt = title.slice(atIdx + 1);
    const colonIdx = afterAt.indexOf(':');
    if (colonIdx >= 0) {
      const pathPart = afterAt.slice(colonIdx + 1).trim();
      const parsed = parsePathPart(pathPart);
      if (parsed) return parsed;
      return home + '/' + pathPart;
    }
  }

  // Direct path format
  const directPath = parsePathPart(title);
  if (directPath) return directPath;

  return null;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(value);
}

// Git-Bash/MSYS 环境上报的 cwd 是 "/c/foo" 形式，Windows 的 fs API 无法使用，
// 转换成 "C:/foo"。单字母首段才视为盘符（"/usr" 这类不受影响）。
function normalizeReportedCwdPath(p: string): string {
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])(?=\/|$)(.*)$/.exec(p);
    if (msys) {
      return `${msys[1].toUpperCase()}:${msys[2] || '/'}`;
    }
  }
  return p;
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
  /** Rich agent events sniffed from OSC 777 sentinel notifications. */
  agentEvents: AgentEvent[];
  /** Opaque notification body (plain OSC 9 or non-sentinel OSC 777) — the
   *  no-hooks fallback signal that an agent pinged the user. */
  notification: string | null;
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
  const agentEvents: AgentEvent[] = [];
  let notification: string | null = null;
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
      if (cwd) lastCwd = normalizeReportedCwdPath(cwd);
    } else if (oscNum === '7') {
      // CWD report
      const cwd = parseOsc7Cwd(oscData, home);
      if (cwd) lastCwd = normalizeReportedCwdPath(cwd);
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
      if (progress) {
        tuiProgress = progress;
      } else if (oscData.trim().length > 0) {
        // Plain OSC 9 notification (iTerm2-style): an agent pinging the user.
        notification = oscData;
      }
    } else if (oscNum === '777') {
      // OSC 777 notification: `notify;<title>;<body>`. termdock's agent hooks
      // use the sentinel title carrying a JSON event; anything else is an
      // opaque notification from an agent without hooks installed.
      const event = parseAgentEvent(`777;${oscData}`);
      if (event) {
        agentEvents.push(event);
      } else {
        const body = parseOsc777NotificationBody(oscData);
        if (body) notification = body;
      }
    }
  }

  const remaining = buf.slice(lastMatchEnd).slice(-128);

  return { cwd: lastCwd, title: lastTitle, promptState, exitCode, tuiProgress, agentEvents, notification, remaining };
}

/** The body of a `notify;<title>;<body>` OSC 777 payload, or null. */
function parseOsc777NotificationBody(data: string): string | null {
  if (!data.startsWith('notify;')) return null;
  const rest = data.slice('notify;'.length);
  const sep = rest.indexOf(';');
  const body = sep >= 0 ? rest.slice(sep + 1) : rest;
  return body.trim().length > 0 ? body : null;
}

// ── end OSC sniffing ──

type AgentIndicator = 'spinner' | 'pulse' | 'dot' | 'ring' | 'badge' | 'terminal' | 'question';


// ── Rich agent session tracking (identity registry + OSC 777 hook events) ──
//
// Two tiers, ported from tty7:
// 1. Identity: the activeProgram poll's rawArgs matched against the agent
//    registry answers "*which* agent runs here" (brand, accent, icon, resume).
// 2. Rich status: agent-side hooks emit OSC 777 sentinel events that the
//    sniffer collects; they drive a per-pane state machine
//    (idle/working/waiting/done) pushed to clients as `agent-status`.
// A plain OSC 9/777 notification is the no-hooks fallback: it only means
// "the agent pinged you" and never overrides rich state.

/** User-defined wrapper→agent rules from the program-detection config. */
function agentCustomCommands(): Record<string, string> {
  return agentCommandsMap;
}

/** Naive whitespace split of a captured command line into argv tokens. */
function splitCommandToArgv(command: string): string[] {
  return command
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ''))
    .filter((t) => t.length > 0);
}

/** The coding agent running in this session's foreground, per activeProgram. */
function detectSessionAgent(session: TerminalSession): AgentInfo | null {
  const ap = session.activeProgram;
  if (!ap) return null;
  const custom = agentCustomCommands();
  if (ap.rawArgs) {
    const hit = detectAgentFromCommand(ap.rawArgs, custom);
    if (hit) return hit;
  }
  if (ap.command) {
    return detectAgentFromCommand(ap.command, custom);
  }
  return null;
}

const autoTitlePending = new Set<string>();

function appendAutoTitleContext(sessionId: string, session: TerminalSession, data: string, schedule: boolean): void {
  session.autoTitleTerminal.write(data, (rendered) => {
    session.autoTitleContext = rendered;
    if (schedule) maybeScheduleLongRunningAutoTitle(sessionId, session);
  });
}

function appendAutoTitlePromptPayload(session: TerminalSession, payload: string): void {
  const maxChars = getAutoRenamePromptPayloadCharsSetting();
  const bounded = payload.slice(0, maxChars).trim();
  if (!bounded || session.autoTitlePromptPayloads.at(-1) === bounded) return;
  session.autoTitlePromptPayloads.push(bounded);
  session.autoTitlePromptPayloads = session.autoTitlePromptPayloads.slice(-12);
  while (session.autoTitlePromptPayloads.length > 1
    && session.autoTitlePromptPayloads.join('\n').length > maxChars) {
    session.autoTitlePromptPayloads.shift();
  }
}

function getBoundedAutoTitlePromptPayloads(session: TerminalSession): string[] {
  const maxChars = getAutoRenamePromptPayloadCharsSetting();
  const selected: string[] = [];
  let used = 0;
  for (let index = session.autoTitlePromptPayloads.length - 1; index >= 0; index -= 1) {
    const payload = session.autoTitlePromptPayloads[index]!.slice(0, maxChars);
    const separatorChars = selected.length > 0 ? 1 : 0;
    if (used + separatorChars + payload.length > maxChars) continue;
    selected.unshift(payload);
    used += separatorChars + payload.length;
  }
  return selected;
}

async function resolveAutoTitleContext(session: TerminalSession): Promise<string> {
  return cleanTerminalContext(await session.autoTitleTerminal.snapshot());
}

function clearAutoTitleForNewAgentSession(sessionId: string, session: TerminalSession): void {
  const record = globalSessionState.sessions.find((item) => item.backendSessionId === sessionId);
  if (!record?.autoTitle) return;
  const next: PersistedClientSession = { ...record, customName: undefined, autoTitle: null };
  upsertGlobalSessionRecord(next);
  session.autoTitleContext = '';
  session.autoTitleTerminal.reset();
  session.autoTitlePromptPayloads = [];
  if (next.mode === 'tmux' && next.tmuxSessionName) {
    void unsetTmuxOption(next.tmuxSessionName, '@termdock-friendly-name');
  }
  schedulePersistGlobalState();
  broadcastClientState();
  console.log(`[auto-title] cleared stale title for new agent session in ${sessionId}`);
}

async function maybeAutoRenameSession(
  sessionId: string,
  agent: AgentInfo,
  session: TerminalSession,
  options: { forceReevaluation?: boolean } = {},
): Promise<boolean> {
  if (autoTitlePending.has(sessionId)) return false;
  if (!getAutoRenameAgentsSetting().includes(agent.slug)) return false;

  const record = globalSessionState.sessions.find((item) => item.backendSessionId === sessionId);
  if (!record || (record.customName === true && !record.autoTitle)) return false;
  if (record.autoTitle && !options.forceReevaluation && !isAutoTitleReevaluationDue(
    record.autoTitle.updatedAt,
    getAutoRenameIntervalMinutesSetting(),
  )) return false;

  const context = await resolveAutoTitleContext(session);
  const promptSubmitPayloads = getBoundedAutoTitlePromptPayloads(session);
  // A new session gets one cheap attempt after its first real exchange. Short
  // conversations ("hi" plus a brief reply) are still valid sessions; the
  // one-hour re-evaluation guard below keeps this from becoming noisy after a
  // title exists.
  if (context.length < AUTO_TITLE_MIN_CONTEXT_CHARS) return false;
  const contentHash = createHash('sha256')
    .update(JSON.stringify({ context, promptSubmitPayloads }))
    .digest('hex');
  if (record.autoTitle?.contentHash === contentHash) return false;

  autoTitlePending.add(sessionId);
  try {
    const savedModels = getAutoRenameModelsSetting();
    const catalog = await getTitleNamerCatalog();
    const availableModels = new Map(catalog.map((namer) => [
      namer.slug,
      new Set(namer.models.map((model) => model.id)),
    ]));
    const validModels = Object.fromEntries(Object.entries(savedModels)
      .filter(([slug, model]) => availableModels.get(slug)?.has(model)));
    for (const namer of catalog) {
      if (!validModels[namer.slug] && namer.recommendedModel) {
        validModels[namer.slug] = namer.recommendedModel;
      }
    }
    const title = await generateAgentTitle(agent.slug, agent.displayName, context, {
      namer: getAutoRenameNamerSetting(),
      models: validModels,
      currentTitle: record.autoTitle ? record.name : undefined,
      userPreference: getAutoRenamePromptPreferenceSetting(),
      promptSubmitPayloads,
    });
    if (!title) return false;

    // A manual rename performed while the namer was running always wins.
    const current = globalSessionState.sessions.find((item) => item.backendSessionId === sessionId);
    if (!current || (current.customName === true && !current.autoTitle)) return false;

    if (current.autoTitle && !shouldReplaceAutoTitle(current.name, title)) {
      upsertGlobalSessionRecord({
        ...current,
        autoTitle: { agentSlug: agent.slug, contentHash, updatedAt: Date.now() },
      });
      await persistGlobalStateNow();
      console.log(`[auto-title] kept ${sessionId} title ${JSON.stringify(current.name)}`);
      return true;
    }

    const next: PersistedClientSession = {
      ...current,
      name: title,
      customName: true,
      autoTitle: { agentSlug: agent.slug, contentHash, updatedAt: Date.now() },
    };
    if (next.mode === 'tmux' && next.tmuxSessionName) {
      await setTmuxOption(next.tmuxSessionName, '@termdock-friendly-name', title);
    }
    upsertGlobalSessionRecord(next);
    await persistGlobalStateNow();
    broadcastClientState();
    console.log(`[auto-title] renamed ${sessionId} (${agent.slug}) to ${JSON.stringify(title)}`);
    return true;
  } catch (error) {
    console.warn(`[auto-title] failed for ${sessionId}: ${getErrorMessage(error)}`);
    return false;
  } finally {
    autoTitlePending.delete(sessionId);
  }
}

function cancelLongRunningAutoTitle(session: TerminalSession): void {
  if (session.autoTitleLongRunningTimer === null) return;
  clearTimeout(session.autoTitleLongRunningTimer);
  session.autoTitleLongRunningTimer = null;
}

function maybeScheduleLongRunningAutoTitle(sessionId: string, session: TerminalSession): void {
  if (session.autoTitleLongRunningTimer !== null || session.autoTitleGeneratedMidTurn) return;
  const agent = session.agent;
  if (!agent || !getAutoRenameAgentsSetting().includes(agent.slug)) return;
  const phase = session.agentSession?.status;
  if (!isLongRunningAutoTitleTurnEligible(
    phase,
    session.autoTitleObservedPrompt,
    session.autoTitleTurnActive,
  )) return;
  const record = globalSessionState.sessions.find((item) => item.backendSessionId === sessionId);
  if (!record || record.autoTitle || record.customName === true) return;
  if (!hasSubstantiveAutoTitleContext(session.autoTitleContext)) return;

  session.autoTitleLongRunningTimer = setTimeout(() => {
    session.autoTitleLongRunningTimer = null;
    const liveSession = terminalSessions.get(sessionId);
    if (liveSession !== session || liveSession.agent?.slug !== agent.slug) return;
    const phase = liveSession.agentSession?.status;
    if (!isLongRunningAutoTitleTurnEligible(
      phase,
      liveSession.autoTitleObservedPrompt,
      liveSession.autoTitleTurnActive,
    )) return;
    const current = globalSessionState.sessions.find((item) => item.backendSessionId === sessionId);
    if (!current || current.autoTitle || current.customName === true) return;
    void maybeAutoRenameSession(sessionId, agent, liveSession).then((generated) => {
      if (!generated || terminalSessions.get(sessionId) !== liveSession) return;
      const completedWhileNaming = liveSession.agentSession?.status === 'done'
        || liveSession.agentSession?.status === 'idle';
      if (completedWhileNaming) {
        void maybeAutoRenameSession(sessionId, agent, liveSession, { forceReevaluation: true });
        return;
      }
      liveSession.autoTitleGeneratedMidTurn = true;
    });
  }, AUTO_TITLE_LONG_RUNNING_DELAY_MS);
  session.autoTitleLongRunningTimer.unref?.();
}

export interface AgentStatusWirePayload {
  type: 'agent-status';
  /** State-machine value; null when no agent session is tracked. */
  agentStatus: AgentSessionStatus | null;
  agentIndicator: AgentIndicator | null;
  /** Plugin-defined status id/label/tone. `agentStatus` remains the semantic phase. */
  agentStatusDetail: {
    id: string;
    label: string;
    tone: AgentStatusTone;
  } | null;
  agent: {
    slug: string;
    displayName: string;
    accentColor: string;
    icon: string | null;
    isPlugin?: boolean;
    iconMode?: 'mask' | 'native';
    iconVersion?: number;
  } | null;
  agentMessage: string | null;
  /** Whether the user has acknowledged the current 'done' turn result. Server-authoritative. */
  reviewed: boolean | null;
  /** The agent's native session id, for resume. */
  agentNativeSessionId: string | null;
  /** This PTY was rebuilt after a crash and the persisted Agent is awaiting user recovery. */
  agentResumeRecovered: boolean;
  /** Whether state comes from installed hooks (rich) vs the notification fallback. */
  agentRich: boolean;
  /** Monotonic tool-completion counter; only the *change* means anything. */
  agentActivity: number;
  /** The agent's own cwd claim (tracks internal chdirs e.g. worktrees). */
  agentCwd: string | null;
}

/** Status → indicator glyph. Colors stay client-side (CSS theme vars) so
 *  dark/light themes render correctly; the wire carries semantics only. */
const AGENT_STATUS_INDICATOR: Record<AgentSessionStatus, AgentIndicator | null> = {
  idle:    null,
  working: 'spinner',
  waiting: 'question',
  done:    'badge',
};

/** The pane sits at a shell prompt (no foreground program, or a shell). Only
 *  then does an agent-resume offer make sense — pasting a resume command into
 *  vim/htop would corrupt its input. */
function isPaneAtShellPrompt(session: TerminalSession): boolean {
  const command = session.activeProgram?.command;
  if (!command) return true;
  return shellNamesBackend.has(command.toLowerCase());
}

function buildAgentStatusPayload(sessionId: string, session: TerminalSession): AgentStatusWirePayload {
  const state = session.agentSession;
  const status = state ? state.status : null;
  const presentation = state?.presentation ?? null;
  const indicator = presentation?.indicator ?? (status ? AGENT_STATUS_INDICATOR[status] : null);
  let agent = session.agent;
  let nativeSessionId = state?.sessionId ?? null;
  // The agent just exited: keep offering its last conversation for resume
  // (brand + native id from the persisted last-known record) while the pane
  // sits at a shell prompt.
  if (!agent && !nativeSessionId && isPaneAtShellPrompt(session)) {
    const record = globalSessionState.sessions.find((s) => s.backendSessionId === sessionId);
    if (record?.agentResume?.sessionId) {
      const persistedAgent = agentBySlug(record.agentResume.slug);
      if (persistedAgent) {
        agent = persistedAgent;
        nativeSessionId = record.agentResume.sessionId;
      }
    }
  }
  return {
    type: 'agent-status',
    agentStatus: status,
    agentIndicator: indicator ?? null,
    agentStatusDetail: presentation
      ? { id: presentation.id, label: presentation.label, tone: presentation.tone ?? 'neutral' }
      : null,
    agent: agent
      ? { slug: agent.slug, displayName: agent.displayName, accentColor: agent.accentColor, icon: agent.icon, isPlugin: agent.isPlugin ?? false, iconMode: agent.iconMode, iconVersion: agent.iconVersion }
      : null,
    agentMessage: state?.message ?? null,
    reviewed: state?.reviewed ?? session.lastAgentReviewed ?? null,
    agentNativeSessionId: nativeSessionId,
    agentResumeRecovered: session.agentResumeRecovered,
    agentRich: state?.rich ?? false,
    agentActivity: state?.activity ?? 0,
    agentCwd: state?.agentCwd ?? null,
  };
}

let lastAgentStatusSnapshots = new Map<string, string>();

function broadcastAgentStatus(sessionId: string, session: TerminalSession, force = false): void {
  const payload = buildAgentStatusPayload(sessionId, session);
  const snapshot = JSON.stringify(payload);
  const previousSnapshot = lastAgentStatusSnapshots.get(sessionId);
  if (!force && previousSnapshot === snapshot) return;
  lastAgentStatusSnapshots.set(sessionId, snapshot);
  broadcastEvent(sessionId, payload);
  const previous = previousSnapshot
    ? JSON.parse(previousSnapshot) as AgentStatusWirePayload
    : null;
  notifyAgentTransition(sessionId, previous, payload);
}

/** Persist the info needed to resume this pane's agent conversation after the
 *  agent exits / the server restarts (last-known semantics, debounced). */
function persistAgentResumeBinding(backendSessionId: string, session: TerminalSession): void {
  const record = globalSessionState.sessions.find((s) => s.backendSessionId === backendSessionId);
  if (!record) return;
  const agent = session.agent;
  const sess = session.agentSession;
  if (!agent || !sess?.sessionId) return;
  const next = {
    slug: agent.slug,
    sessionId: sess.sessionId,
    launchArgv: sess.launchArgv,
    updatedAt: Date.now(),
  };
  if (JSON.stringify(record.agentResume ?? null) === JSON.stringify(next)) return;
  upsertGlobalSessionRecord({ ...record, agentResume: next });
  schedulePersistGlobalState();
}

/** Debounce window before treating an agent disappearance as a real exit.
 *  Subcommands that briefly occupy the foreground group cause momentary poll
 *  blips — waiting 2–3 poll cycles (1200 ms each) before clearing the session
 *  avoids false "agent exited" notifications while keeping real exits responsive. */
const AGENT_EXIT_DEBOUNCE_MS = 3000;

/**
 * React to activeProgram changes: detect agent identity, end the rich session
 * when the agent leaves the foreground, and stamp the launch argv (for resume
 * flag replay) while the agent is present. Called from every activeProgram
 * assignment site.
 */
function syncAgentIdentity(sessionId: string, session: TerminalSession): void {
  const detected = detectSessionAgent(session);

  if (detected !== session.agent) {
    // The agent leaving the foreground ends its session: clear the rich state
    // so a stale "waiting" dot can't outlive the process. The poll can blip
    // momentarily (an agent-spawned subcommand takes the foreground group),
    // so we debounce: only clear after AGENT_EXIT_DEBOUNCE_MS of continuous
    // absence. A real agent swap (agent A → agent B) clears immediately.
    if (session.agent && session.agentSession) {
      if (detected === null) {
        // Agent disappeared — could be a poll blip (subcommand) or real exit.
        const now = Date.now();
        if (session.agentLeftAt === null) {
          session.agentLeftAt = now;
          return;
        }
        if (now - session.agentLeftAt < AGENT_EXIT_DEBOUNCE_MS) {
          return;
        }
      }
      // Debounce expired (or agent swapped): clear the session for real.
      persistAgentResumeBinding(sessionId, session);
      session.lastAgentReviewed = session.agentSession.reviewed;
      session.agentSession = null;
      session.agentLeftAt = null;
    }
    session.agent = detected;
    broadcastAgentStatus(sessionId, session);
    if (detected) {
      const frontendSessionId = globalSessionState.sessions.find((record) => record.backendSessionId === sessionId)?.sessionId;
      if (frontendSessionId) setTimeout(() => tryDeliverCollaborationInbox(frontendSessionId), 300).unref?.();
    }
  } else if (detected && session.agentLeftAt !== null) {
    // Agent re-detected before debounce expired — false alarm, restore.
    session.agentLeftAt = null;
  }

  // Stamp the launch argv the identity poll captured — resume gets the flags.
  if (detected && session.activeProgram?.rawArgs) {
    const argv = splitCommandToArgv(session.activeProgram.rawArgs);
    if (argv.length > 0) {
      const sess = session.agentSession;
      if (sess && sess.launchArgv === null) {
        sess.launchArgv = argv;
        persistAgentResumeBinding(sessionId, session);
        broadcastAgentStatus(sessionId, session);
      } else if (!sess) {
        // No session state yet (no hook events seen): remember the argv on a
        // pending field via the resume record so an exited agent can still be
        // resumed with its flags even if hooks never fired.
        const record = globalSessionState.sessions.find((s) => s.backendSessionId === sessionId);
        if (record?.agentResume && record.agentResume.slug === detected.slug && !record.agentResume.launchArgv) {
          upsertGlobalSessionRecord({ ...record, agentResume: { ...record.agentResume, launchArgv: argv } });
          schedulePersistGlobalState();
        }
      }
    }
  }
}

/**
 * Fold the sniffer's agent signals into the pane's session state and push any
 * resulting change. Called from the PTY data path.
 */
function applyAgentSignals(
  sessionId: string,
  session: TerminalSession,
  events: AgentEvent[],
  notification: string | null,
): void {
  if (events.length === 0 && !notification) return;

  // Hook events prove the agent process is alive — cancel any pending-exit timer
  // that a poll blip may have started in syncAgentIdentity.
  session.agentLeftAt = null;

  let identityChanged = false;
  let completedTurnAgent: AgentInfo | null = null;
  for (const event of events) {
    if (!agentEventMatchesCurrentAgent(session.agent, event)) continue;
    // An event naming an agent brands the pane even when the process poll
    // can't see through a wrapper: identity via protocol.
    if (!session.agent && event.agent) {
      session.agent = event.agent;
      identityChanged = true;
    }
    const state = session.agentSession ?? defaultAgentSessionState();
    session.agentSession = state;
    const previousNativeSessionId = state.sessionId
      ?? globalSessionState.sessions.find((item) => item.backendSessionId === sessionId)?.agentResume?.sessionId
      ?? null;
    if (event.kind === 'session-start' && isNewAgentSessionId(previousNativeSessionId, event.sessionId)) {
      cancelLongRunningAutoTitle(session);
      session.autoTitleGeneratedMidTurn = false;
      clearAutoTitleForNewAgentSession(sessionId, session);
    }
    if (event.kind === 'session-start') {
      session.agentResumeRecovered = false;
      session.autoTitleObservedPrompt = false;
      session.autoTitleTurnActive = false;
      session.autoTitlePromptPayloads = [];
    }
    if (event.kind === 'prompt-submit') {
      // Before the first automatic title, keep accumulating short turns until
      // there is enough substance to name the session. Once titled, only the
      // latest turn is relevant to the conservative re-evaluation path.
      const persisted = globalSessionState.sessions.find((item) => item.backendSessionId === sessionId);
      if (!session.autoTitleObservedPrompt || persisted?.autoTitle) {
        session.autoTitleContext = '';
        session.autoTitleTerminal.reset();
      }
      cancelLongRunningAutoTitle(session);
      session.autoTitleGeneratedMidTurn = false;
      session.autoTitleObservedPrompt = true;
      session.autoTitleTurnActive = true;
      if (event.promptPayload) appendAutoTitlePromptPayload(session, event.promptPayload);
    }
    applyAgentEvent(state, event);
    if (event.kind === 'stop') {
      cancelLongRunningAutoTitle(session);
      session.autoTitleTurnActive = false;
      completedTurnAgent = event.agent ?? session.agent;
    }
    if (event.kind === 'session-end') {
      cancelLongRunningAutoTitle(session);
      session.autoTitleTurnActive = false;
    }
    if (event.kind === 'session-start' || event.kind === 'session-end' || event.kind === 'stop') {
      persistAgentResumeBinding(sessionId, session);
    }
    // The agent's cwd claim: allow file APIs to follow it (worktree hops).
    if (state.agentCwd) {
      void pathValidator.allowSessionCwd(state.agentCwd);
    }
  }

  // Opaque fallback: only meaningful when we know an agent runs here, and
  // never on top of rich state (the hooks channel owns it then).
  if (notification && session.agent && !session.agentSession?.rich) {
    const state = session.agentSession ?? defaultAgentSessionState();
    session.agentSession = state;
    if (state.status !== 'waiting' || state.message !== notification) {
      state.status = 'waiting';
      state.message = notification;
    }
  }

  // Seed the launch argv the identity poll captured, so resume gets the
  // flags no matter which side observed the pane first.
  if (session.agentSession && session.agentSession.launchArgv === null && session.activeProgram?.rawArgs) {
    const argv = splitCommandToArgv(session.activeProgram.rawArgs);
    if (argv.length > 0) {
      session.agentSession.launchArgv = argv;
      persistAgentResumeBinding(sessionId, session);
    }
  }

  // Agent activity (a tool completed → the working tree may have changed) is
  // one of the git probe's triggers.
  maybeRefreshGitStatusForAgent(sessionId, session);

  broadcastAgentStatus(sessionId, session, identityChanged);

  if (session.agentSession && ['idle', 'done'].includes(session.agentSession.status)) {
    const frontendSessionId = globalSessionState.sessions.find((record) => record.backendSessionId === sessionId)?.sessionId;
    if (frontendSessionId) {
      setTimeout(() => tryDeliverCollaborationInbox(frontendSessionId), 300).unref?.();
    }
  }

  if (completedTurnAgent) {
    const agent = completedTurnAgent;
    const forceReevaluation = session.autoTitleGeneratedMidTurn;
    session.autoTitleGeneratedMidTurn = false;
    // Let the current PTY chunk reach the rolling context before reading it.
    setTimeout(() => {
      void maybeAutoRenameSession(sessionId, agent, session, { forceReevaluation });
    }, 250).unref?.();
  }
}

// ── Git status (branch + diff size) ──
//
// Probes are cheap (two git shell-outs) and shared through the repo-root
// cache; triggers are event-driven rather than a timer: cwd change, command
// end (prompt-state running→idle), and agent tool activity mid-turn.

const lastGitStatusSnapshots = new Map<string, string>();

function refreshGitStatus(sessionId: string, session: TerminalSession, opts: { minIntervalMs?: number } = {}): void {
  // The agent's own cwd claim (worktree hops) wins over the pane's proc cwd.
  const key = session.agentSession?.agentCwd ?? session.cwd ?? null;
  if (!key) {
    if (session.gitStatus !== null) {
      session.gitStatus = null;
      session.gitStatusKey = null;
      broadcastEvent(sessionId, { type: 'git-status', gitStatus: null });
    }
    return;
  }
  session.gitStatusKey = key;
  const probe = gitStatusCache.beginProbe(key, opts.minIntervalMs);
  if (!probe) return;
  void probe.then((status) => {
    // The pane may have moved on while the probe ran; publish only if the
    // probe's key is still the pane's tree (or the session switched away —
    // then the new cwd's own trigger will publish its own).
    if (session.gitStatusKey !== key) return;
    const snapshot = JSON.stringify(status);
    if (lastGitStatusSnapshots.get(sessionId) === snapshot) return;
    lastGitStatusSnapshots.set(sessionId, snapshot);
    session.gitStatus = status;
    broadcastEvent(sessionId, { type: 'git-status', gitStatus: status });
  }).catch(() => { /* probe failure keeps the previous snapshot */ });
}

/**
 * Git probe trigger: agent tool activity means the working tree may have
 * changed mid-turn.
 */
function maybeRefreshGitStatusForAgent(sessionId: string, session: TerminalSession): void {
  const activity = session.agentSession?.activity ?? 0;
  if (activity === 0 || activity === session.gitAgentActivitySeen) return;
  session.gitAgentActivitySeen = activity;
  refreshGitStatus(sessionId, session);
}

/**
 * The command that resumes this pane's last agent conversation, or null.
 * Live state wins; falls back to the persisted last-known record.
 */
interface AgentResumeTarget {
  slug: string;
  nativeSessionId: string;
  command: string;
}

function resolveAgentResumeTarget(sessionId: string, session: TerminalSession): AgentResumeTarget | null {
  // Resume always starts a new Agent process. Never offer it while the pane is
  // still inside an Agent TUI, even when that Agent reports a completed turn.
  if (!isPaneAtShellPrompt(session)) return null;
  const record = globalSessionState.sessions.find((s) => s.backendSessionId === sessionId);
  const persisted = record?.agentResume;
  if (!persisted?.sessionId) return null;
  const agent = agentBySlug(persisted.slug);
  if (!agent) return null;
  const command = buildResumeCommand(agent, persisted.sessionId, persisted.launchArgv);
  return command ? { slug: agent.slug, nativeSessionId: persisted.sessionId, command } : null;
}

function findActiveAgentResumeOwner(excludedBackendSessionId: string, target: AgentResumeTarget): string | null {
  for (const [backendSessionId, candidate] of terminalSessions) {
    if (backendSessionId === excludedBackendSessionId || candidate.agent?.slug !== target.slug) continue;
    const record = globalSessionState.sessions.find((entry) => entry.backendSessionId === backendSessionId);
    const nativeSessionId = candidate.agentSession?.sessionId ?? record?.agentResume?.sessionId ?? null;
    if (nativeSessionId === target.nativeSessionId) return backendSessionId;
  }
  return null;
}

const codexSessionFileCache = new Map<string, string>();

async function findCodexSessionFile(nativeSessionId: string): Promise<string | null> {
  const cachedPath = codexSessionFileCache.get(nativeSessionId);
  if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;
  if (!/^[a-zA-Z0-9._-]{8,160}$/.test(nativeSessionId)) return null;
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const pending = [root];
  let visited = 0;
  while (pending.length > 0 && visited < 20_000) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(`-${nativeSessionId}.jsonl`)) {
        codexSessionFileCache.set(nativeSessionId, candidate);
        return candidate;
      }
    }
  }
  return null;
}

async function findExternalCodexWriter(target: AgentResumeTarget): Promise<number | null> {
  if (target.slug !== 'codex' || process.platform !== 'linux') return null;
  const sessionFile = await findCodexSessionFile(target.nativeSessionId);
  if (!sessionFile) return null;
  try {
    const { stdout } = await execFileAsync('lsof', ['-t', '--', sessionFile], { timeout: 2500, maxBuffer: 64 * 1024 });
    const pid = stdout.split(/\s+/).map(Number).find((value) => Number.isInteger(value) && value > 1);
    return pid ?? null;
  } catch {
    return null;
  }
}

/**
 * Deliver a prompt into an agent's PTY: bracketed paste (so multi-line
 * prompts insert as one block instead of submitting line by line — every
 * recognized agent's TUI enables bracketed paste), followed by CR to submit.
 * ESC bytes are stripped so embedded content can't fake the paste terminator.
 */
function buildBracketedSubmitBytes(prompt: string): string {
  return `\x1b[200~${prompt.replace(/\x1b/g, '')}\x1b[201~\r`;
}

// ── end Rich agent session tracking ──

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
  /** User-defined wrapper→agent rules: a personal launcher (`cc`) is branded
   *  like the agent it launches (`claude`). Applies to the launcher only. */
  agentCommands?: Record<string, string>;
}

const DEFAULT_PROGRAM_DETECTION: ProgramDetectionConfig = {
  genericProgramNames: ['node', 'python', 'python3', 'ruby', 'perl', 'java'],
  wrapperScriptNames: ['aiden', 'ttadk', 'npx', 'yarn', 'dlx'],
  shellNames: ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu'],
  agentCommands: {},
};

let genericProgramNames = new Set(DEFAULT_PROGRAM_DETECTION.genericProgramNames);
let wrapperScriptNames = new Set(DEFAULT_PROGRAM_DETECTION.wrapperScriptNames);
let shellNamesBackend = new Set(DEFAULT_PROGRAM_DETECTION.shellNames);
let agentCommandsMap: Record<string, string> = { ...DEFAULT_PROGRAM_DETECTION.agentCommands };

async function loadProgramDetectionFromDisk(): Promise<ProgramDetectionConfig> {
  try {
    const parsed = await readJsonFileIfExists<Partial<ProgramDetectionConfig>>(PROGRAM_DETECTION_FILE);
    if (!parsed) return { ...DEFAULT_PROGRAM_DETECTION };
    return {
      genericProgramNames: Array.isArray(parsed.genericProgramNames) ? parsed.genericProgramNames : DEFAULT_PROGRAM_DETECTION.genericProgramNames,
      wrapperScriptNames: Array.isArray(parsed.wrapperScriptNames) ? parsed.wrapperScriptNames : DEFAULT_PROGRAM_DETECTION.wrapperScriptNames,
      shellNames: Array.isArray(parsed.shellNames) ? parsed.shellNames : DEFAULT_PROGRAM_DETECTION.shellNames,
      agentCommands: parsed.agentCommands && typeof parsed.agentCommands === 'object' && !Array.isArray(parsed.agentCommands)
        ? Object.fromEntries(
            Object.entries(parsed.agentCommands as Record<string, unknown>)
              .filter(([k, v]) => typeof k === 'string' && typeof v === 'string') as Array<[string, string]>,
          )
        : {},
    };
  } catch { /* file doesn't exist or invalid, use defaults */ }
  return { ...DEFAULT_PROGRAM_DETECTION };
}

function applyProgramDetectionConfig(config: ProgramDetectionConfig): void {
  genericProgramNames = new Set(config.genericProgramNames);
  wrapperScriptNames = new Set(config.wrapperScriptNames);
  shellNamesBackend = new Set(config.shellNames);
  agentCommandsMap = { ...(config.agentCommands ?? {}) };
}

async function saveProgramDetectionToDisk(config: ProgramDetectionConfig): Promise<void> {
  await writeJsonFile(PROGRAM_DETECTION_FILE, config);
  applyProgramDetectionConfig(config);
}

// Initialize on startup
void loadProgramDetectionFromDisk().then(applyProgramDetectionConfig);

// Startup keeper: rewrite hook integrations that point at a stale termdock
// (package moved/updated) so they keep firing into the right emitter.
try {
  refreshStaleHooksAtLaunch();
} catch { /* hook refresh must never block startup */ }

// Load user-defined agent plugins into the identity registry
try {
  const { plugins, errors } = loadPlugins();
  const result = registerPluginAgents(plugins);
  if (result.registered > 0) {
    console.log(`[agent-plugins] loaded ${result.registered} plugin(s)`);
  }
  for (const skip of result.skipped) {
    console.warn(`[agent-plugins] skipped: ${skip}`);
  }
  for (const err of errors) {
    console.warn(`[agent-plugins] validation error in "${err.slug}": ${err.errors.join('; ')}`);
    if (err.migration?.aiPrompt) {
      console.warn(`[agent-plugins] AI migration prompt for "${err.slug}": ${err.migration.aiPrompt}`);
    }
  }
} catch { /* plugin loading must never block startup */ }

interface TmuxProcessSnapshotRow extends TmuxProcessRow {
  tty: string;
}

let processSnapshot: { rows: TmuxProcessSnapshotRow[]; fetchedAt: number } | null = null;
let processSnapshotPromise: Promise<TmuxProcessSnapshotRow[]> | null = null;

function parseProcessSnapshot(stdout: string): TmuxProcessSnapshotRow[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): TmuxProcessSnapshotRow | null => {
      // ps -o format: TTY PID PPID PGID TPGID STAT COMM ARGS
      const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      return {
        tty: match[1] || '',
        pid: Number.parseInt(match[2] || '0', 10),
        ppid: Number.parseInt(match[3] || '0', 10),
        pgid: Number.parseInt(match[4] || '0', 10),
        tpgid: Number.parseInt(match[5] || '0', 10),
        stat: match[6] || '',
        comm: match[7] || '',
        args: match[8]?.trim() || '',
      };
    })
    .filter((row): row is TmuxProcessSnapshotRow => row !== null);
}

async function getProcessSnapshot(): Promise<TmuxProcessSnapshotRow[]> {
  const now = Date.now();
  if (processSnapshot && now - processSnapshot.fetchedAt < PROCESS_SNAPSHOT_CACHE_TTL_MS) {
    return processSnapshot.rows;
  }
  if (processSnapshotPromise) return processSnapshotPromise;

  processSnapshotPromise = execFileAsync('ps', [
    '-e',
    '-o',
    'tty=,pid=,ppid=,pgid=,tpgid=,stat=,comm=,args=',
  ], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }).then(({ stdout }) => {
    const rows = parseProcessSnapshot(stdout);
    processSnapshot = { rows, fetchedAt: Date.now() };
    return rows;
  }).finally(() => {
    processSnapshotPromise = null;
  });
  return processSnapshotPromise;
}

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
    let rows: TmuxProcessRow[];
    if (process.platform === 'linux' && pane.tty) {
      const paneTty = pane.tty.replace(/^\/dev\//, '');
      rows = (await getProcessSnapshot()).filter((row) => row.tty === paneTty);
    } else {
      const psArgs = pane.tty
        ? ['-t', pane.tty.replace(/^\/dev\//, ''), '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,comm=,args=']
        : ['-o', 'pid=,ppid=,pgid=,tpgid=,stat=,comm=,args='];
      const { stdout } = await execFileAsync('ps', psArgs, { timeout: 3000, maxBuffer: 512 * 1024 });
      rows = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line): TmuxProcessRow | null => {
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
    }

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

// Let tmux forward modified Enter keys (Ctrl/Shift/Alt+Enter) to pane apps.
// The option only exists in tmux >= 3.2; on older versions the probe fails
// and we silently skip.
async function enableTmuxExtendedKeys(): Promise<void> {
  try {
    const current = (await runTmux(['show-options', '-gqv', 'extended-keys'])).trim();
    if (current === 'on') return;
    await runTmux(['set-option', '-g', 'extended-keys', 'on']);
    console.log('[tmux] enabled global extended-keys');
  } catch {
    // extended-keys unsupported on this tmux; nothing to do
  }
}

async function ensureSharedTmuxServerReady(): Promise<void> {
  await ensureTmuxColorEnvironment();
  await applyTmuxScrollbackProfile();
  await enableTmuxFocusEvents();
  await enableTmuxExtendedKeys();
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

  // Agent-hook plumbing for panes in this session: TERMDOCK marks panes
  // spawned here as ours (the emitter's gate), and allow-passthrough lets
  // hooks' DCS-wrapped sentinel OSC reach us through tmux. Set here (not in
  // the shell-integration path, which early-returns) so every managed
  // session gets them regardless of shell type.
  try {
    await runTmux(['set-environment', '-t', sessionName, 'TERMDOCK', '1']);
    await runTmux(['set-option', '-t', sessionName, 'allow-passthrough', 'on']);
  } catch (error) {
    console.warn(`Failed to enable agent-hook plumbing for ${sessionName}: ${getErrorMessage(error)}`);
  }
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

let tmuxLayoutsSnapshot: { layouts: Map<string, TmuxLayout>; fetchedAt: number } | null = null;
let tmuxLayoutsSnapshotPromise: Promise<Map<string, TmuxLayout>> | null = null;

async function buildTmuxLayoutsSnapshot(): Promise<Map<string, TmuxLayout>> {
  const [sessionsRaw, windowsRaw, panesRaw] = await Promise.all([
    runTmux([
      'list-sessions',
      '-F',
      `#{session_id}${TMUX_DELIMITER}#{session_name}${TMUX_DELIMITER}#{window_id}${TMUX_DELIMITER}#{pane_id}${TMUX_DELIMITER}#{pane_in_mode}`,
    ]),
    runTmux([
      'list-windows',
      '-a',
      '-F',
      `#{session_name}${TMUX_DELIMITER}#{window_id}${TMUX_DELIMITER}#{window_name}${TMUX_DELIMITER}#{window_index}${TMUX_DELIMITER}#{window_active}`,
    ]),
    runTmux([
      'list-panes',
      '-a',
      '-F',
      `#{session_name}${TMUX_DELIMITER}#{window_id}${TMUX_DELIMITER}#{pane_id}${TMUX_DELIMITER}#{pane_index}${TMUX_DELIMITER}#{pane_active}${TMUX_DELIMITER}#{pane_width}${TMUX_DELIMITER}#{pane_height}${TMUX_DELIMITER}#{pane_top}${TMUX_DELIMITER}#{pane_left}${TMUX_DELIMITER}#{pane_current_command}${TMUX_DELIMITER}#{pane_pid}${TMUX_DELIMITER}#{pane_tty}${TMUX_DELIMITER}#{pane_title}${TMUX_DELIMITER}#{pane_current_path}`,
    ]),
  ]);

  const layouts = new Map<string, TmuxLayout>();
  for (const line of sessionsRaw.trim().split('\n')) {
    if (!line) continue;
    const row = parseDelimitedRow(line, 5);
    if (!row) continue;
    const [sessionId, sessionName, activeWindowId, activePaneId, paneInMode] = row;
    layouts.set(sessionName, {
      sessionId,
      sessionName,
      windows: [],
      activeWindowId,
      activePaneId,
      inCopyMode: paneInMode === '1',
    });
  }

  const windowsById = new Map<string, TmuxWindow>();
  for (const line of windowsRaw.trim().split('\n')) {
    if (!line) continue;
    const row = parseDelimitedRow(line, 5);
    if (!row) continue;
    const [sessionName, windowId, windowName, windowIndexRaw, windowActiveRaw] = row;
    const layout = layouts.get(sessionName);
    if (!layout) continue;
    const window: TmuxWindow = {
      id: windowId,
      name: windowName || '',
      index: parseInt(windowIndexRaw || '0', 10),
      active: windowActiveRaw === '1',
      panes: [],
    };
    layout.windows.push(window);
    windowsById.set(`${sessionName}\0${windowId}`, window);
  }

  for (const line of panesRaw.trim().split('\n')) {
    if (!line) continue;
    const row = parseDelimitedRow(line, 14);
    if (!row) continue;
    const [sessionName, windowId, paneId, paneIndexRaw, paneActiveRaw, widthRaw, heightRaw, topRaw, leftRaw, command, pidRaw, tty, title, currentPath] = row;
    const window = windowsById.get(`${sessionName}\0${windowId}`);
    if (!window) continue;
    window.panes.push({
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
    });
  }

  return layouts;
}

async function getCachedTmuxLayout(sessionName: string): Promise<TmuxLayout> {
  if (tmuxLayoutsSnapshot && Date.now() - tmuxLayoutsSnapshot.fetchedAt < TMUX_LAYOUT_CACHE_TTL_MS) {
    const cached = tmuxLayoutsSnapshot.layouts.get(sessionName);
    if (cached) return cached;
  }

  if (!tmuxLayoutsSnapshotPromise) {
    tmuxLayoutsSnapshotPromise = buildTmuxLayoutsSnapshot().then((layouts) => {
      tmuxLayoutsSnapshot = { layouts, fetchedAt: Date.now() };
      return layouts;
    }).finally(() => {
      tmuxLayoutsSnapshotPromise = null;
    });
  }

  const layouts = await tmuxLayoutsSnapshotPromise;
  const layout = layouts.get(sessionName);
  if (layout) return layout;

  // A just-created session can race the global snapshot. Keep that rare path
  // correct without returning stale metadata for the new terminal.
  return getTmuxLayout(sessionName);
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
      return snapshot ? buildTmuxScreenSnapshot(snapshot) : [];
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

  session.dataDisposable?.dispose();
  session.exitDisposable?.dispose();
  cancelLongRunningAutoTitle(session);
  session.autoTitleTerminal.dispose();
  lastAgentStatusSnapshots.delete(sessionId);
  lastGitStatusSnapshots.delete(sessionId);
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
    const closedRecord = globalSessionState.sessions.find((s) => s.backendSessionId === sessionId) ?? null;
    archiveAgentResumeRecord(closedRecord, 'exited');
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
  session.autoTitleTerminal.resize(cleanCols, cleanRows);
  session.lastActivity = Date.now();
  if (changed) {
    markTmuxClientsForScreenSync(sessionId, session);
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

/**
 * The PTY output pipeline: history append + OSC sniffing + push. Live output
 * runs with broadcast on; pty-host *replay* (adoption after a server restart)
 * runs with broadcast off — it rebuilds history and sniffed state (cwd,
 * prompt-state, agent sessions) without re-sending stale output to clients.
 */
function processSessionOutput(sessionId: string, session: TerminalSession, data: string, opts: { broadcast: boolean }): void {
  const home = (process.env.HOME || '/root').replace(/\/+$/, '') || '/';
  if (opts.broadcast) {
    session.lastActivity = Date.now();
    session.lastOutputAt = Date.now();
    session.hasWrittenData = true;
  }
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
        // 用户在终端里 cd 到白名单外目录（如 Windows 其它盘符）时，动态放行，
        // 否则侧边栏目录树/文件 API 会报 "Access denied: path not allowed"。
        void pathValidator.allowSessionCwd(result.cwd);
        if (updateGlobalBindingForBackendSession(sessionId, { cwd: result.cwd, lastActivity: session.lastActivity })) {
          schedulePersistGlobalState();
        }
        broadcastEvent(sessionId, { type: 'cwd', cwd: result.cwd });
        refreshGitStatus(sessionId, session, { minIntervalMs: 0 });
      }

      // Title change — broadcast so the frontend can update tab/sidebar
      if (result.title !== null && result.title !== session.lastOscTitle) {
        session.lastOscTitle = result.title;
        broadcastJsonWs(sessionId, { type: 'shell-title', title: result.title });
      }

      // Prompt state change (OSC 133)
      if (result.promptState !== null && result.promptState !== session.lastPromptState) {
        const wasRunning = session.lastPromptState === 'running';
        session.lastPromptState = result.promptState;
        broadcastJsonWs(sessionId, {
          type: 'prompt-state',
          state: result.promptState,
          exitCode: result.exitCode,
        });
        // A command just finished — the working tree may have changed.
        if (wasRunning && result.promptState === 'idle') {
          refreshGitStatus(sessionId, session);
        }
      }

      if (result.tuiProgress !== null) {
        session.tuiProgress = result.tuiProgress.state === 'remove' ? null : result.tuiProgress;
        broadcastJsonWs(sessionId, {
          type: 'tui-progress',
          tuiProgress: session.tuiProgress,
        });
      }

      // Rich agent events (OSC 777 sentinel from installed hooks) + the
      // opaque notification fallback drive the per-pane agent session state.
      if (result.agentEvents.length > 0 || result.notification) {
        applyAgentSignals(sessionId, session, result.agentEvents, result.notification);
      }
  } catch { /* sniff failure should never block data */ }

  appendAutoTitleContext(sessionId, session, data, opts.broadcast);
  if (opts.broadcast) {
    const searchMetadata = searchMetadataForBackend(sessionId, session);
    if (searchMetadata) sessionSearchStore.append(searchMetadata, cleanTerminalContext(data));
  }
  if (opts.broadcast) {
    broadcastEvent(sessionId, seq !== undefined ? { type: 'data', data, seq } : { type: 'data', data });
  }
}

function setupPtyHandlers(sessionId: string, session: TerminalSession): void {
  session.dataDisposable = session.ptyProcess.onData((data: string) => {
    processSessionOutput(sessionId, session, data, { broadcast: true });
  });

  session.exitDisposable = session.ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
    broadcastEvent(sessionId, { type: 'exit', exitCode, signal });
    // User-initiated closes dispose this listener before killing the pty, so
    // reaching here means the process exited on its own. Sessions with a live
    // agent already get their exit covered by notifyAgentTransition — skip
    // those to avoid two notifications for one event.
    const snapshot = lastAgentStatusSnapshots.get(sessionId);
    const hasLiveAgent = snapshot
      ? (JSON.parse(snapshot) as AgentStatusWirePayload).agentStatus !== null
      : false;
    if (!hasLiveAgent) {
      notifyTerminalExit(sessionId, typeof exitCode === 'number' ? exitCode : null);
    }
    cleanupSession(sessionId, { killProcess: false });
  });
}


/**
 * Wrap node-pty spawn errors with actionable messages for common failure modes.
 */
function wrapPtySpawnError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  const msg = error.message || '';
  if (/EACCES|spawn.*helper|Permission denied/i.test(msg)) {
    return new Error(
      `终端启动失败：node-pty spawn-helper 可能没有执行权限。\n` +
      `请运行: chmod +x node_modules/node-pty/prebuilds/*/spawn-helper\n` +
      `原始错误: ${msg}`,
    );
  }
  return error;
}

/**
 * Shell-mode persistence via the pty-host daemon: shells live in a detached
 * host process and survive server restarts. Set TERMDOCK_PTY_HOST=off to
 * fall back to in-process PTYs (Windows always uses the in-process path).
 */
function ptyHostShellModeEnabled(): boolean {
  // The host daemon always uses node-pty; under a Bun runtime that's the
  // backend with known issues, so keep the in-process path there.
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  return process.platform !== 'win32' && !isBun && process.env.TERMDOCK_PTY_HOST !== 'off';
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
  let mode = normalizeMode(input.mode);
  // tmux 不可用时自动降级为 shell 模式，避免 "spawn tmux ENOENT" 错误
  if (mode === 'tmux') {
    const tmuxStatus = await getTmuxStatus();
    if (!tmuxStatus.available) {
      console.warn('[termdock] tmux not available, falling back to shell mode:', tmuxStatus.reason);
      mode = 'shell';
    }
  }
  const tmuxSessionName = mode === 'tmux' ? normalizeTmuxSessionName(input.tmuxSessionName) : null;

  if (mode === 'tmux' && tmuxSessionName) {
    await prepareManagedTmuxSession(tmuxSessionName, cwd);
  }

  const command = mode === 'tmux'
    ? getTmuxBinary()
    : (process.platform === 'win32' ? 'powershell.exe' : resolveShellCandidates()[0]);
  const args = mode === 'tmux' && tmuxSessionName
    ? ['attach-session', '-t', tmuxSessionName]
    : (process.platform === 'win32' ? buildPowerShellCwdHookArgs() : []);

  const envPath = buildAugmentedPath();
  const resolvedEnv: Record<string, string | undefined> = { ...process.env, PATH: envPath };
  // The server itself may run under tmux; spawned shells are NOT tmux panes.
  // Inheriting TMUX/TMUX_PANE makes tmux-aware programs (incl. our own
  // agent-hook emitter's passthrough decision) misdetect their context.
  delete resolvedEnv.TMUX;
  delete resolvedEnv.TMUX_PANE;

  const pty = await getPtyProvider();
  const termValue = resolveTerminalTermType(input.termType);
  const baseEnv: Record<string, string> = {
    ...resolvedEnv,
    TERM: termValue,
    COLORTERM: 'truecolor',
    // Gates the agent-hook emitter: hooks installed globally stay silent
    // unless the agent runs inside a termdock-spawned shell.
    TERMDOCK: '1',
    // Lets `td collab` address this exact Termdock conversation without the
    // user or Agent having to copy a session id.
    TERMDOCK_BACKEND_SESSION_ID: sessionId,
  };

  let ptyProcess: PtyProcess | null = null;

  if (mode === 'shell' && process.platform !== 'win32') {
    const shellCandidates = resolveShellCandidates();
    let lastError: unknown = null;

    for (const shellCandidate of shellCandidates) {
      try {
        const env = await injectShellIntegration(shellCandidate, baseEnv);
        if (ptyHostShellModeEnabled()) {
          // The PTY lives in the detached pty-host daemon: this session
          // survives server restarts and is re-adopted on launch.
          ptyProcess = await getPtyHostManager().spawnChannel(sessionId, {
            shell: shellCandidate,
            args: [],
            cwd,
            cols,
            rows,
            env,
            termName: termValue,
          });
        } else {
          ptyProcess = pty.spawn(shellCandidate, [], {
            name: termValue,
            cols,
            rows,
            cwd,
            env,
          });
        }
        break;
      } catch (error) {
        lastError = error;
        if (!shouldRetryShellSpawn(error)) {
          throw error;
        }
      }
    }

    if (!ptyProcess) {
      throw wrapPtySpawnError(lastError ?? new Error("Failed to start shell"));
    }
  } else {
    try {
      ptyProcess = pty.spawn(command, args, {
        name: termValue,
        cols,
        rows,
        cwd,
        env: baseEnv,
        // Windows: 用 node-pty 自带的新版 conpty.dll（Windows Terminal 同源），
        // 系统内置 conhost 的 ConPTY 差分在「输出中 resize/宽字符」场景下会与
        // 终端真实状态分叉，表现为滚动 TUI（如 claude code）时行首 CJK 残影。
        ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
      });
    } catch (error) {
      throw wrapPtySpawnError(error);
    }
  }

  if (!ptyProcess) {
    throw new Error("终端启动失败：PTY 进程创建返回空值，请检查 node-pty 安装");
  }

  const session: TerminalSession = {
    ptyProcess,
    ptyBackend: mode === 'shell' && ptyHostShellModeEnabled() ? 'pty-host' : pty.backend,
    cwd,
    mode,
    tmuxSessionName,
    cols,
    rows,
    lastActivity: Date.now(),
    lastOutputAt: Date.now(),
    clients: new Map(),
    createdAt: Date.now(),
    hasWrittenData: false,
    activeProgram: null,
    agent: null,
    agentSession: null,
    agentResumeRecovered: false,
    autoTitleContext: '',
    autoTitleTerminal: new RenderedTerminalContext(cols, rows),
    autoTitlePromptPayloads: [],
    autoTitleLongRunningTimer: null,
    autoTitleGeneratedMidTurn: false,
    autoTitleObservedPrompt: false,
    autoTitleTurnActive: false,
    lastAgentReviewed: null,
    agentLeftAt: null,
    gitStatus: null,
    gitStatusKey: null,
    gitAgentActivitySeen: 0,
    oscSniffBuf: '',
    lastOscCwd: null,
    lastOscTitle: null,
    lastPromptState: null,
    tuiProgress: null,
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
  // First git snapshot for the pane's spawn cwd (throttle-free).
  refreshGitStatus(sessionId, session, { minIntervalMs: 0 });
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

// ── pty-host adoption (shell-mode persistence across server restarts) ──

/**
 * Adopt every shell session that survived in the pty-host daemon. Rebuilds
 * the TerminalSession around a PtyHostClient, feeds the host's replay ring
 * through the output pipeline (history + OSC/agent state, no broadcast), and
 * re-links — or creates — the persisted client record so the session shows
 * up as a tab again.
 */
async function adoptPtyHostSessions(): Promise<void> {
  if (!ptyHostShellModeEnabled()) return;
  const adopted = await getPtyHostManager().adoptChannels();
  if (adopted.length === 0) return;

  let createdRecords = 0;
  for (const { meta, client } of adopted) {
    if (terminalSessions.has(meta.id)) continue;

    const session: TerminalSession = {
      ptyProcess: client,
      ptyBackend: 'pty-host',
      cwd: meta.cwd,
      mode: 'shell',
      tmuxSessionName: null,
      cols: meta.cols,
      rows: meta.rows,
      lastActivity: Date.now(),
      lastOutputAt: Date.now(),
      clients: new Map(),
      createdAt: meta.startedAt,
      hasWrittenData: true,
      activeProgram: null,
      agent: null,
      agentSession: null,
      agentResumeRecovered: false,
      autoTitleContext: '',
      autoTitleTerminal: new RenderedTerminalContext(meta.cols, meta.rows),
      autoTitlePromptPayloads: [],
      autoTitleLongRunningTimer: null,
      autoTitleGeneratedMidTurn: false,
      autoTitleObservedPrompt: false,
      autoTitleTurnActive: false,
      lastAgentReviewed: null,
      agentLeftAt: null,
      gitStatus: null,
      gitStatusKey: null,
      gitAgentActivitySeen: 0,
      oscSniffBuf: '',
      lastOscCwd: null,
      lastOscTitle: null,
      lastPromptState: null,
      tuiProgress: null,
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
    terminalSessions.set(meta.id, session);

    // The host's replay ring rebuilds this server's history + sniffed state
    // (cwd / prompt-state / agent sessions) without re-broadcasting.
    (client as PtyHostClient).onReplay((data: string) => {
      processSessionOutput(meta.id, session, data, { broadcast: false });
    });
    setupPtyHandlers(meta.id, session);
    refreshGitStatus(meta.id, session, { minIntervalMs: 0 });

    // Re-link or create the persisted record so the session appears as a tab.
    const existing = globalSessionState.sessions.find((s) => s.backendSessionId === meta.id);
    if (!existing) {
      const now = Date.now();
      upsertGlobalSessionRecord({
        sessionId: randomUUID(),
        name: `terminal-${now.toString(36)}`,
        backendSessionId: meta.id,
        mode: 'shell',
        tmuxSessionName: null,
        createdAt: meta.startedAt,
        lastActivity: now,
        cwd: meta.cwd,
      });
      createdRecords++;
    }
  }

  console.log(`[pty-host] adopted ${adopted.length} surviving shell session(s)${createdRecords > 0 ? `, created ${createdRecords} record(s)` : ''}`);
  if (createdRecords > 0) {
    persistAndBroadcastGlobalState();
  }
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

function buildPowerShellCwdHookArgs(): string[] {
  const script = `
$script:__TermdockOriginalPrompt = if (Test-Path Function:\\prompt) {
  (Get-Command prompt -CommandType Function).ScriptBlock
} else {
  { "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }
}
function global:prompt {
  try {
    $location = Get-Location
    $path = if ($location.Provider.Name -eq 'FileSystem') { $location.ProviderPath } else { $location.Path }
    [Console]::Write("$([char]27)]0;$path$([char]7)")
  } catch {}
  & $script:__TermdockOriginalPrompt
}
`.trim();

  return ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', script];
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

router.get('/operations/automations', (_req, res) => {
  res.json({ automations: automationStore.list(), runs: automationStore.listRuns() });
});

router.post('/operations/automations', async (req, res) => {
  try {
    const schedule = normalizeAutomationSchedule(req.body?.schedule);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const command = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const targetSessionId = typeof req.body?.targetSessionId === 'string' ? req.body.targetSessionId.trim() : '';
    if (!name || !schedule || (!command && !prompt)) {
      return res.status(400).json({ error: '名称、有效计划以及命令或提示词不能为空' });
    }
    const targetRecord = targetSessionId
      ? globalSessionState.sessions.find((candidate) => candidate.sessionId === targetSessionId)
      : null;
    if (targetSessionId && !targetRecord) return res.status(400).json({ error: '目标会话不存在' });
    if (!targetSessionId && !command) return res.status(400).json({ error: '创建新会话时必须填写 Agent 启动命令' });
    const requestedCwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
      ? req.body.cwd.trim()
      : (targetRecord?.cwd || os.homedir());
    const cwd = await resolveWorkingDirectory(req, requestedCwd);
    const automation = automationStore.save({
      id: typeof req.body?.id === 'string' ? req.body.id : undefined,
      name,
      enabled: req.body?.enabled !== false,
      cwd,
      command,
      prompt,
      targetSessionId: targetSessionId || null,
      schedule,
    });
    res.json({ automation });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

router.post('/operations/automations/:automationId/run', async (req, res) => {
  const automation = automationStore.get(req.params.automationId);
  if (!automation) return res.status(404).json({ error: '自动任务不存在' });
  try {
    await runAgentAutomation(automation, req);
    res.json({ ok: true, automation: automationStore.get(automation.id), runs: automationStore.listRuns(automation.id) });
  } catch (error) {
    res.status(409).json({ error: getErrorMessage(error), automation: automationStore.get(automation.id) });
  }
});

router.delete('/operations/automations/:automationId', (req, res) => {
  if (!automationStore.remove(req.params.automationId)) return res.status(404).json({ error: '自动任务不存在' });
  res.status(204).send();
});

router.get('/operations/collaboration-groups', (_req, res) => {
  res.json({
    groups: collaborationStore.list(),
    sessions: globalSessionState.sessions.map(orchestrationSessionSnapshot),
  });
});

router.post('/operations/collaboration-groups', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const sessionIds: string[] = Array.isArray(req.body?.sessionIds)
    ? (req.body.sessionIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];
  const knownIds = new Set(globalSessionState.sessions.map((session) => session.sessionId));
  const normalizedIds = Array.from(new Set(sessionIds.filter((id) => knownIds.has(id))));
  if (!name || normalizedIds.length < 2) return res.status(400).json({ error: '协作组至少需要两个有效会话' });
  const group = collaborationStore.save({
    id: typeof req.body?.id === 'string' ? req.body.id : undefined,
    name,
    sessionIds: normalizedIds,
  });
  res.json({ group });
});

router.delete('/operations/collaboration-groups/:groupId', (req, res) => {
  if (!collaborationStore.remove(req.params.groupId)) return res.status(404).json({ error: '协作组不存在' });
  res.status(204).send();
});

router.get('/operations/collaboration-groups/:groupId/messages', (req, res) => {
  const group = collaborationStore.getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: '协作组不存在' });
  res.json({ messages: collaborationStore.listMessages(group.id, Number(req.query.limit) || 200) });
});

router.post('/operations/collaboration-groups/:groupId/messages', (req, res) => {
  try {
    const group = collaborationStore.getGroup(req.params.groupId);
    if (!group) return res.status(404).json({ error: '协作组不存在' });
    const fromSessionId = resolveFrontendSessionId(req.body ?? {});
    const kind = typeof req.body?.kind === 'string' ? req.body.kind as CollaborationMessageKind : 'message';
    const content = typeof req.body?.content === 'string' ? req.body.content.slice(0, 20_000) : '';
    const requestedTargets: string[] = Array.isArray(req.body?.toSessionIds)
      ? (req.body.toSessionIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];
    const toSessionIds = requestedTargets.length > 0
      ? requestedTargets
      : group.sessionIds.filter((id) => id !== fromSessionId);
    const messages = collaborationStore.send({
      groupId: group.id,
      fromSessionId,
      toSessionIds,
      kind,
      content,
      threadId: typeof req.body?.threadId === 'string' ? req.body.threadId : null,
      replyTo: typeof req.body?.replyTo === 'string' ? req.body.replyTo : null,
    });
    const deliveries = Array.from(new Set(messages.map((message) => message.toSessionId))).map((sessionId) => ({
      sessionId,
      ...tryDeliverCollaborationInbox(sessionId),
    }));
    res.json({ messages, deliveries });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

router.get('/operations/orchestration/peers', (req, res) => {
  const sourceSessionId = resolveFrontendSessionId(req.query);
  const source = globalSessionState.sessions.find((candidate) => candidate.sessionId === sourceSessionId);
  if (!source) return res.status(404).json({ error: '会话不存在' });
  const groups = collaborationStore.groupsForSession(source.sessionId);
  const peerIds = new Set(groups.flatMap((group) => group.sessionIds).filter((id) => id !== source.sessionId));
  res.json({ source: orchestrationSessionSnapshot(source), groups, peers: globalSessionState.sessions.filter((record) => peerIds.has(record.sessionId)).map(orchestrationSessionSnapshot) });
});

router.post('/operations/orchestration/send', (req, res) => {
  const sourceSessionId = resolveFrontendSessionId(req.body ?? {});
  const targetSessionId = typeof req.body?.targetSessionId === 'string' ? req.body.targetSessionId.trim() : '';
  const content = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 20_000) : '';
  if (!sourceSessionId) return res.status(400).json({ error: '无法识别发送会话；请从 Termdock 会话内运行 td collab' });
  const group = collaborationStore.groupsForSession(sourceSessionId).find((candidate) => candidate.sessionIds.includes(targetSessionId));
  if (!group) return res.status(400).json({ error: '发送方和接收方不在同一协作组' });
  try {
    const messages = collaborationStore.send({
      groupId: group.id, fromSessionId: sourceSessionId, toSessionIds: [targetSessionId],
      kind: typeof req.body?.kind === 'string' ? req.body.kind as CollaborationMessageKind : 'message',
      content,
    });
    res.json({ ok: true, messages, delivery: tryDeliverCollaborationInbox(targetSessionId) });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

router.get('/operations/orchestration/inbox', (req, res) => {
  const sessionId = resolveFrontendSessionId(req.query);
  if (!sessionId) return res.status(404).json({ error: '会话不存在' });
  const messages = collaborationStore.inbox(sessionId, { limit: Number(req.query.limit) || 50 });
  if (req.query.markRead === 'true') collaborationStore.markRead(messages.map((message) => message.id));
  const groups = collaborationStore.groupsForSession(sessionId);
  const peerIds = new Set(groups.flatMap((group) => group.sessionIds).filter((id) => id !== sessionId));
  res.json({
    session: orchestrationSessionSnapshot(globalSessionState.sessions.find((record) => record.sessionId === sessionId)!),
    groups,
    peers: globalSessionState.sessions.filter((record) => peerIds.has(record.sessionId)).map(orchestrationSessionSnapshot),
    messages,
  });
});

router.post('/operations/orchestration/reply', (req, res) => {
  const sourceSessionId = resolveFrontendSessionId(req.body ?? {});
  const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : '';
  const content = typeof req.body?.content === 'string' ? req.body.content.trim().slice(0, 20_000) : '';
  const original = collaborationStore.getMessage(messageId);
  if (!sourceSessionId || !original || original.toSessionId !== sourceSessionId) {
    return res.status(404).json({ error: '协作消息不存在或不属于当前会话' });
  }
  if (!original.fromSessionId) return res.status(400).json({ error: '这条用户消息无需回复到其他会话' });
  try {
    collaborationStore.markRead([original.id]);
    const messages = collaborationStore.send({
      groupId: original.groupId,
      fromSessionId: sourceSessionId,
      toSessionIds: [original.fromSessionId],
      kind: 'reply',
      content,
      threadId: original.threadId,
      replyTo: original.id,
    });
    res.json({ ok: true, messages, delivery: tryDeliverCollaborationInbox(original.fromSessionId) });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

router.get('/operations/session-search', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  const results = sessionSearchStore.search(query, Number(req.query.limit) || 30).map((result) => {
    const live = globalSessionState.sessions.some((candidate) => candidate.sessionId === result.sessionId);
    const resumeEntry = result.agentNativeSessionId
      ? agentResumeHistory.list().find((entry) => entry.agent.sessionId === result.agentNativeSessionId)
      : null;
    return { ...result, live, resumeHistoryId: resumeEntry?.id ?? null };
  });
  res.json({ query, results });
});

router.get('/agent-resume-history', (_req, res) => {
  const entries = agentResumeHistory.list().flatMap((entry) => {
    const agent = agentBySlug(entry.agent.slug);
    const command = agent ? buildResumeCommand(agent, entry.agent.sessionId!, entry.agent.launchArgv) : null;
    if (!agent || !command) return [];
    return [{
      id: entry.id,
      title: entry.title,
      titleSource: entry.titleSource,
      agent,
      cwd: entry.cwd,
      closedAt: entry.closedAt,
      reason: entry.reason,
    }];
  });
  res.json({ entries });
});

router.post('/agent-resume-history/:historyId/prepare', async (req, res) => {
  const historyId = typeof req.params.historyId === 'string' ? req.params.historyId.trim() : '';
  const entry = historyId ? agentResumeHistory.get(historyId) : null;
  if (!entry) return res.status(404).json({ error: 'Agent resume history entry not found' });
  const agent = agentBySlug(entry.agent.slug);
  const command = agent ? buildResumeCommand(agent, entry.agent.sessionId!, entry.agent.launchArgv) : null;
  if (!agent || !command) {
    return res.status(410).json({
      error: 'This Agent no longer has a valid resume command',
      code: 'AGENT_RESUME_UNAVAILABLE',
    });
  }
  const target: AgentResumeTarget = {
    slug: agent.slug,
    nativeSessionId: entry.agent.sessionId!,
    command,
  };
  const activeOwner = findActiveAgentResumeOwner('', target);
  if (activeOwner || await findExternalCodexWriter(target)) {
    return res.status(409).json({
      error: 'this agent session is already open in another terminal',
      code: 'AGENT_SESSION_ACTIVE_ELSEWHERE',
    });
  }
  res.json({ command, cwd: entry.cwd, title: entry.title, agent });
});

router.delete('/agent-resume-history/:historyId', (req, res) => {
  const historyId = typeof req.params.historyId === 'string' ? req.params.historyId.trim() : '';
  if (!historyId || !agentResumeHistory.remove(historyId)) {
    return res.status(404).json({ error: 'Agent resume history entry not found' });
  }
  res.status(204).send();
});

router.delete('/agent-resume-history', (_req, res) => {
  agentResumeHistory.clear();
  res.status(204).send();
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
    next.autoTitle = null;
  }
  if (typeof body.customName === 'boolean') {
    next.customName = body.customName ? true : undefined;
    next.autoTitle = null;
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
  archiveAgentResumeRecord(removedSession, 'closed');
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
  for (const session of globalSessionState.sessions) archiveAgentResumeRecord(session, 'closed');
  globalSessionState = { sessions: [], updatedAt: Date.now() };
  collaborationStore.clear();
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
  collaborationStore.clear();
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
    locale: getLocaleSetting(),
    contextDraftHeight: getContextDraftHeightSetting(),
    autoRenameAgents: getAutoRenameAgentsSetting(),
    autoRenameNamer: getAutoRenameNamerSetting(),
    autoRenameModels: getAutoRenameModelsSetting(),
    autoRenameIntervalMinutes: getAutoRenameIntervalMinutesSetting(),
    autoRenamePromptPreference: getAutoRenamePromptPreferenceSetting(),
    autoRenamePromptPayloadChars: getAutoRenamePromptPayloadCharsSetting(),
    newSessionAgentSlug: getNewSessionAgentSlugSetting(),
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

router.get('/auto-title/catalog', async (req, res) => {
  const force = req.query.refresh === '1';
  res.json({ namers: await getTitleNamerCatalog(force) });
});

router.get('/update', (_req, res) => {
  res.json(npmAutoUpdateManager.getState());
});

router.post('/update/check', async (_req, res) => {
  res.json(await npmAutoUpdateManager.checkNow());
});

router.post('/update/restart', (_req, res) => {
  try {
    const state = npmAutoUpdateManager.confirmRestart();
    res.status(202).json(state);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.put('/settings', async (req, res) => {
  const body = req.body ?? {};
  if (typeof body.preventSleep === 'boolean') {
    caffeinateManager.setPreventSleep(body.preventSleep);
  }

  if (typeof body.locale === 'string' && (body.locale === 'zh' || body.locale === 'en')) {
    setLocaleSetting(body.locale);
  }

  if (body.contextDraftHeight && typeof body.contextDraftHeight === 'object') {
    const heightBody = body.contextDraftHeight as { mobile?: unknown; desktop?: unknown };
    for (const device of ['mobile', 'desktop'] as const) {
      const value = heightBody[device];
      if (value === null) {
        setContextDraftHeightSetting(device, null);
      } else if (typeof value === 'number' && Number.isFinite(value) && value >= 56 && value <= 4000) {
        setContextDraftHeightSetting(device, Math.round(value));
      }
    }
  }

  if (Array.isArray(body.autoRenameAgents)) {
    const knownSlugs = new Set(listAgents().map((agent) => agent.slug));
    const requested = (body.autoRenameAgents as unknown[])
      .filter((slug): slug is string => typeof slug === 'string' && knownSlugs.has(slug));
    setAutoRenameAgentsSetting(requested);
    invalidateTitleNamerCatalog();
  }

  if (typeof body.autoRenameNamer === 'string') {
    const available = new Set((await getTitleNamerCatalog()).filter((entry) => entry.available).map((entry) => entry.slug));
    if (body.autoRenameNamer !== 'auto' && !available.has(body.autoRenameNamer)) {
      res.status(400).json({ error: 'Unsupported automatic title agent', code: 'AUTO_RENAME_NAMER_INVALID' });
      return;
    }
    setAutoRenameNamerSetting(body.autoRenameNamer);
    invalidateTitleNamerCatalog();
  }

  if (body.autoRenameModels && typeof body.autoRenameModels === 'object') {
    const requested = body.autoRenameModels as Record<string, unknown>;
    const catalog = await getTitleNamerCatalog();
    const allowed = new Map(catalog.map((namer) => [namer.slug, new Set(namer.models.map((model) => model.id))]));
    const models: Record<string, string> = {};
    for (const [slug, model] of Object.entries(requested)) {
      if (model === undefined || model === '') continue;
      if (typeof model !== 'string' || !allowed.get(slug)?.has(model)) {
        res.status(400).json({ error: `Unsupported ${slug} title model`, code: 'AUTO_RENAME_MODEL_INVALID' });
        return;
      }
      models[slug] = model;
    }
    setAutoRenameModelsSetting(models);
  }

  if (typeof body.autoRenameIntervalMinutes === 'number'
    && Number.isInteger(body.autoRenameIntervalMinutes)
    && body.autoRenameIntervalMinutes >= 5
    && body.autoRenameIntervalMinutes <= 1440) {
    setAutoRenameIntervalMinutesSetting(body.autoRenameIntervalMinutes);
  }

  if (typeof body.autoRenamePromptPreference === 'string' && body.autoRenamePromptPreference.length <= 2000) {
    setAutoRenamePromptPreferenceSetting(body.autoRenamePromptPreference);
  }

  if (typeof body.autoRenamePromptPayloadChars === 'number'
    && Number.isInteger(body.autoRenamePromptPayloadChars)
    && body.autoRenamePromptPayloadChars >= 1000
    && body.autoRenamePromptPayloadChars <= 64_000) {
    setAutoRenamePromptPayloadCharsSetting(body.autoRenamePromptPayloadChars);
  }

  if (body.newSessionAgentSlug === null) {
    setNewSessionAgentSlugSetting(null);
  } else if (typeof body.newSessionAgentSlug === 'string') {
    const slug = body.newSessionAgentSlug.trim().toLowerCase();
    if (!listAgents().some((agent) => agent.slug === slug)) {
      res.status(400).json({ error: 'Unsupported new-session agent', code: 'NEW_SESSION_AGENT_INVALID' });
      return;
    }
    setNewSessionAgentSlugSetting(slug);
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

// ── Context draft (cross-device realtime sync) ────────────────────────
// 草稿内容存服务端（~/.termdock/context-draft.json），PUT 后通过 control
// WebSocket 广播给其它客户端；携带 origin 让发送方忽略自己的回声。

router.get('/context-draft', (_req, res) => {
  res.json(loadContextDraft());
});

router.put('/context-draft', (req, res) => {
  const body = req.body ?? {};
  if (typeof body.text !== 'string') {
    res.status(400).json({ error: 'Invalid draft text', code: 'INVALID_CONTEXT_DRAFT' });
    return;
  }
  const doc = saveContextDraft(body.text);
  broadcastControlEvent({
    type: 'context-draft',
    text: doc.text,
    updatedAt: doc.updatedAt,
    origin: typeof body.origin === 'string' ? body.origin : null,
  });
  res.json(doc);
});

// ── Agent hooks API (rich status channel installers, built-in + plugin) ──

router.get('/agent-hooks', async (_req, res) => {
  res.json({ agents: await listAllHookAgents() });
});

router.get('/agent-launchers', async (_req, res) => {
  const pathEntries = buildAugmentedPath().split(path.delimiter).filter(Boolean);
  const executableExtensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const detected = [] as Array<{
    slug: string;
    displayName: string;
    command: string;
    capabilities?: string[];
    accentColor: string;
    icon: string | null;
    isPlugin: boolean;
    iconMode?: 'mask' | 'native';
    iconVersion?: number;
  }>;

  for (const agent of listAgents()) {
    let command: string | null = null;
    for (const alias of agent.aliases) {
      for (const directory of pathEntries) {
        for (const extension of executableExtensions) {
          const candidate = path.join(directory, `${alias}${extension}`);
          try {
            await fs.promises.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
            command = alias;
            break;
          } catch { /* keep looking */ }
        }
        if (command) break;
      }
      if (command) break;
    }
    if (command) {
      detected.push({
        slug: agent.slug,
        displayName: agent.displayName,
        command,
        capabilities: agent.capabilities,
        accentColor: agent.accentColor,
        icon: agent.icon,
        isPlugin: agent.isPlugin ?? false,
        iconMode: agent.iconMode,
        iconVersion: agent.iconVersion,
      });
    }
  }

  res.json({ agents: detected });
});

router.get('/directory-suggestions', async (req, res) => {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const expandedQuery = rawQuery === '~'
    ? os.homedir()
    : rawQuery.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), rawQuery.slice(2))
      : rawQuery;
  const absoluteQuery = expandedQuery || os.homedir();
  const hasTrailingSeparator = absoluteQuery.endsWith(path.sep);
  const parentCandidate = hasTrailingSeparator ? absoluteQuery : path.dirname(absoluteQuery);
  const namePrefix = hasTrailingSeparator ? '' : path.basename(absoluteQuery).toLowerCase();

  try {
    const parent = req.pathValidator
      ? await req.pathValidator.validateAsync(parentCandidate)
      : await fs.promises.realpath(parentCandidate);
    const entries = await fs.promises.readdir(parent, { withFileTypes: true });
    const matching = entries
      .filter((entry) => !entry.name.startsWith('.') && entry.name.toLowerCase().startsWith(namePrefix))
      .slice(0, 30);
    const directories: string[] = [];
    for (const entry of matching) {
      const candidate = path.join(parent, entry.name);
      if (entry.isDirectory()) {
        directories.push(candidate);
      } else if (entry.isSymbolicLink()) {
        try {
          if ((await fs.promises.stat(candidate)).isDirectory()) directories.push(candidate);
        } catch { /* omit broken/inaccessible symlinks */ }
      }
      if (directories.length >= 10) break;
    }
    res.json({ directories });
  } catch {
    res.json({ directories: [] });
  }
});

router.post('/agent-hooks/:agent/install', async (req, res) => {
  const agent = req.params.agent;
  try {
    const result = await installHooksForSlug(agent);
    res.json({ agent, ...result, state: 'installed' });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.post('/agent-hooks/:agent/uninstall', async (req, res) => {
  const agent = req.params.agent;
  try {
    const summary = await uninstallHooksForSlug(agent);
    res.json({ agent, summary, state: 'not-installed' });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// ── end Agent hooks API ──

// ── Agent plugins API (user-defined agent plugins) ──

router.get('/agent-plugins', (_req, res) => {
  const { plugins, errors } = loadPlugins();
  res.json({
    plugins: plugins.map((p) => ({
      slug: p.manifest.slug,
      displayName: p.manifest.displayName,
      aliases: p.manifest.aliases,
      capabilities: p.manifest.capabilities ?? [],
      accentColor: p.manifest.accentColor,
      iconMode: p.manifest.iconMode ?? 'mask',
      hasHooks: p.manifest.hooks !== undefined,
      hasResume: p.manifest.resume !== undefined,
      hasTitleNamer: p.manifest.titleNamer !== undefined,
      hasIcon: p.iconPath !== null,
      sourceType: p.source?.type ?? 'manifest',
      source: p.source?.source ?? null,
      revision: p.source?.revision ?? null,
      latestRevision: p.source?.latestRevision ?? null,
      checkedAt: p.source?.checkedAt ?? null,
      updatedAt: p.source?.updatedAt ?? null,
      updateSupported: Boolean(p.source?.source && p.source.type !== 'manifest'),
      updateAvailable: Boolean(p.source?.revision && p.source.latestRevision && p.source.revision !== p.source.latestRevision),
    })),
    errors: errors.map((e) => ({ slug: e.slug, errors: e.errors, code: e.code, migration: e.migration })),
  });
});

function reloadAgentPlugins(): void {
  invalidateTitleNamerCatalog();
  clearPluginAgents();
  registerPluginAgents(loadPlugins().plugins);
}

router.post('/agent-plugins/install', async (req, res) => {
  const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
  if (!source) {
    res.status(400).json({ error: 'Plugin source is required', code: 'AGENT_PLUGIN_SOURCE_REQUIRED' });
    return;
  }
  try {
    const prepared = await preparePluginPackage(source);
    const dir = await commitPreparedPlugin(prepared, false);
    reloadAgentPlugins();
    res.json({ slug: prepared.manifest.slug, dir, state: 'installed', source: prepared.metadata });
  } catch (error) {
    const detail = error as Error & { code?: string; migration?: unknown };
    res.status(400).json({
      error: detail.message,
      code: detail.code ?? 'AGENT_PLUGIN_INSTALL_FAILED',
      migration: detail.migration,
    });
  }
});

router.post('/agent-plugins/:slug/check-update', async (req, res) => {
  const plugin = loadPlugins().plugins.find((entry) => entry.manifest.slug === req.params.slug);
  if (!plugin) {
    res.status(404).json({ error: `Plugin "${req.params.slug}" not found` });
    return;
  }
  try {
    res.json(await checkPluginPackageUpdate(plugin));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message, code: 'AGENT_PLUGIN_UPDATE_CHECK_FAILED' });
  }
});

router.post('/agent-plugins/:slug/doctor', async (req, res) => {
  const result = await probePluginTitleNamer(req.params.slug);
  if (!result) {
    res.status(404).json({ error: `Plugin "${req.params.slug}" not found`, code: 'AGENT_PLUGIN_NOT_FOUND' });
    return;
  }
  res.json(result);
});

router.post('/agent-plugins/:slug/update', async (req, res) => {
  const slug = req.params.slug;
  const plugin = loadPlugins().plugins.find((entry) => entry.manifest.slug === slug);
  if (!plugin) {
    res.status(404).json({ error: `Plugin "${slug}" not found` });
    return;
  }
  if (!plugin.source?.source || plugin.source.type === 'manifest') {
    res.status(400).json({ error: 'This plugin has no update source', code: 'AGENT_PLUGIN_UPDATE_UNSUPPORTED' });
    return;
  }

  let prepared: Awaited<ReturnType<typeof preparePluginPackage>> | null = null;
  let oldHooksRemoved = false;
  let committed = false;
  try {
    // Download and validate the complete replacement before touching the live
    // package or its currently installed hooks.
    prepared = await preparePluginPackage(plugin.source.source, slug);
    const hooksChanged = JSON.stringify(plugin.manifest.hooks ?? null) !== JSON.stringify(prepared.manifest.hooks ?? null);
    const titleCapabilityChanged = JSON.stringify(plugin.manifest.titleNamer ?? null) !== JSON.stringify(prepared.manifest.titleNamer ?? null);
    const hookState = (await listAllHookAgents()).find((entry) => entry.slug === slug)?.state;
    const restoreHooks = hookState === 'installed' || hookState === 'outdated';
    if (restoreHooks && plugin.manifest.hooks) {
      await uninstallHooksForSlug(slug);
      oldHooksRemoved = true;
    }
    const dir = await commitPreparedPlugin(prepared, true);
    prepared = null;
    committed = true;
    reloadAgentPlugins();
    let hookWarning: string | null = null;
    if (restoreHooks && hooksChanged) {
      hookWarning = 'Hook declarations changed during update. Review them, then install hooks again.';
    } else if (restoreHooks) {
      try {
        await installHooksForSlug(slug);
      } catch (error) {
        hookWarning = (error as Error).message;
      }
    }
    let titleWarning: string | null = null;
    if (titleCapabilityChanged) {
      setAutoRenameAgentsSetting(getAutoRenameAgentsSetting().filter((entry) => entry !== slug));
      if (getAutoRenameNamerSetting() === slug) setAutoRenameNamerSetting('auto');
      const models = getAutoRenameModelsSetting();
      delete models[slug];
      setAutoRenameModelsSetting(models);
      invalidateTitleNamerCatalog();
      titleWarning = 'Title command declarations changed during update. Automatic titles for this plugin were disabled; review and enable them again.';
    }
    res.json({
      slug,
      dir,
      state: 'updated',
      source: loadPlugins().plugins.find((entry) => entry.manifest.slug === slug)?.source,
      hookWarning,
      titleWarning,
    });
  } catch (error) {
    if (prepared) await prepared.cleanup().catch(() => undefined);
    if (oldHooksRemoved && !committed) await installHooksForSlug(slug).catch(() => undefined);
    const detail = error as Error & { code?: string; migration?: unknown };
    res.status(400).json({
      error: detail.message,
      code: detail.code ?? 'AGENT_PLUGIN_UPDATE_FAILED',
      migration: detail.migration,
    });
  }
});

router.post('/agent-plugins', async (req, res) => {
  const manifest = req.body;
  if (!manifest || typeof manifest !== 'object') {
    res.status(400).json({ error: 'Request body must be a plugin manifest JSON object' });
    return;
  }
  try {
    // validate through the loader
    const { plugins } = loadPlugins();
    // Check for duplicate slug
    const existing = plugins.find((p) => p.manifest.slug === (manifest as Record<string, unknown>).slug);
    if (existing) {
      res.status(409).json({ error: `Plugin "${existing.manifest.slug}" already exists` });
      return;
    }
    const validation = validateManifest(manifest, path.join(os.homedir(), '.termdock', 'agent-plugins', 'pending'));
    if ('error' in validation) {
      res.status(400).json({
        error: validation.error.errors.join('\n'),
        code: validation.error.code ?? 'AGENT_PLUGIN_MANIFEST_INVALID',
        migration: validation.error.migration,
      });
      return;
    }
    const dir = savePlugin(validation.manifest);
    reloadAgentPlugins();
    res.json({ slug: validation.manifest.slug, dir, state: 'created' });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.delete('/agent-plugins/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const plugin = loadPlugins().plugins.find((entry) => entry.manifest.slug === slug);
    if (!plugin) {
      res.status(404).json({ error: `Plugin "${slug}" not found` });
      return;
    }
    // Uninstall while the manifest is still present: after deletion we no
    // longer know the target file or event shape and would orphan commands in
    // the Agent's config.
    if (plugin.manifest.hooks) await uninstallHooksForSlug(slug);
    removePlugin(slug);
    invalidateTitleNamerCatalog();
    setAutoRenameAgentsSetting(getAutoRenameAgentsSetting().filter((entry) => entry !== slug));
    if (getAutoRenameNamerSetting() === slug) setAutoRenameNamerSetting('auto');
    const models = getAutoRenameModelsSetting();
    if (models[slug]) {
      delete models[slug];
      setAutoRenameModelsSetting(models);
    }
    clearPluginAgents();
    registerPluginAgents(loadPlugins().plugins);
    res.json({ slug, state: 'removed' });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.get('/agent-plugin-icon/:slug', (req, res) => {
  const { slug } = req.params;
  const svg = readPluginIcon(slug);
  if (svg === null) {
    res.status(404).json({ error: 'No icon found' });
    return;
  }
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(svg);
});

// ── end Agent plugins API ──

// ── Subscription quota API ──

function broadcastQuotaToAll(): void {
  const status = getQuotaStatus();
  const payload: QuotaStatusWirePayload = {
    type: 'quota-status',
    providers: status.providers,
    updatedAt: status.updatedAt,
  };
  const data = JSON.stringify(payload);

  // Send to control WS clients
  for (const [clientId, ws] of controlClients) {
    if (ws.readyState !== ws.OPEN) { controlClients.delete(clientId); continue; }
    try { ws.send(data); } catch { controlClients.delete(clientId); }
  }

  // Send to per-session WS clients
  for (const [sessionId] of terminalSessions) {
    try {
      broadcastJsonWs(sessionId, payload);
    } catch { /* best-effort */ }
  }
}

// Start quota polling — broadcast fn hooks into both WS channels
startQuotaManager({ broadcast: broadcastQuotaToAll });

router.get('/quota', (_req, res) => {
  res.json(getQuotaStatus());
});

router.post('/quota/refresh', async (_req, res) => {
  try {
    const status = await refreshQuota();
    broadcastQuotaToAll();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Refresh failed' });
  }
});

// ── Subscription quota API end ──

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
      const layout = await getCachedTmuxLayout(session.tmuxSessionName);
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
    activeProgram: session.activeProgram?.command ?? getPersistedActiveProgramForBackend(sessionId),
    activeProgramRaw: session.activeProgram?.rawArgs ?? null,
    activeProgramSource: session.activeProgram?.source ?? null,
    tuiProgress: session.tuiProgress,
    // 标题/prompt 状态只在「变化」时广播，且去重基准在 server 端——刷新后的
    // 新客户端不会收到重发。连接即推当前值，否则 tab 名塌回默认直到下次变化。
    shellTitle: session.lastOscTitle,
    promptState: session.lastPromptState,
  });
  // Rich agent state rides its own message so the connected payload stays
  // backward compatible; force past the dedupe snapshot.
  if (session.agent || session.agentSession || session.agentResumeRecovered) {
    writeSse(res, buildAgentStatusPayload(sessionId, session));
  }
  if (session.gitStatus) {
    writeSse(res, { type: 'git-status', gitStatus: session.gitStatus });
  }

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
    persistActiveProgramBinding(sessionId, activeProgram?.command);

    // Agent status: react to AI tool start/exit
    syncAgentIdentity(sessionId, session);

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
      const layout = await getCachedTmuxLayout(session.tmuxSessionName);

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
        refreshGitStatus(sessionId, session, { minIntervalMs: 0 });
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
          const wasRunning = session.lastPromptState === 'running';
          session.lastPromptState = inferredState;
          writeSse(res, { type: 'prompt-state', state: inferredState });
          if (wasRunning && inferredState === 'idle') {
            refreshGitStatus(sessionId, session);
          }
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
    // TD 重启后 terminalSessions 清空，但从 globalSessionState（持久化到磁盘）
    // 可恢复 mode / tmuxSessionName，避免前端把 tmux 会话误重建为 shell。
    const persistedRecord = globalSessionState.sessions.find(
      (s) => s.backendSessionId === sessionId,
    ) ?? null;
    const recovered = persistedRecord
      ? { mode: persistedRecord.mode, tmuxSessionName: persistedRecord.tmuxSessionName }
      : {};
    console.log(`Health check: session ${sessionId} not found${persistedRecord ? `, recovered mode=${persistedRecord.mode} from persisted state` : ''}`);
    return res.status(404).json({ healthy: false, error: 'Session not found', ...recovered });
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

/**
 * Resume the pane's last agent conversation: rebuild the agent's native
 * resume command (carrying the original launch flags) and deliver it via
 * bracketed paste. Refused while an agent turn is in flight — pasting a
 * resume into a busy TUI would corrupt its input.
 */
router.post('/:sessionId/agent-resume', async (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  const live = session.agentSession;
  if (session.agent && live && (live.status === 'working' || live.status === 'waiting')) {
    return res.status(409).json({ error: 'agent is busy; wait for the turn to finish' });
  }

  const target = resolveAgentResumeTarget(sessionId, session);
  if (!target) {
    return res.status(404).json({ error: 'no resumable agent session for this pane' });
  }
  const activeOwner = findActiveAgentResumeOwner(sessionId, target);
  if (activeOwner) {
    return res.status(409).json({
      error: 'this agent session is already open in another terminal',
      code: 'AGENT_SESSION_ACTIVE_ELSEWHERE',
      activeBackendSessionId: activeOwner,
    });
  }
  const activeWriterPid = await findExternalCodexWriter(target);
  if (activeWriterPid) {
    return res.status(409).json({
      error: 'this Codex thread already has an active writer',
      code: 'AGENT_SESSION_ACTIVE_ELSEWHERE',
      activeWriterPid,
    });
  }

  try {
    session.ptyProcess.write(buildBracketedSubmitBytes(target.command));
    session.lastActivity = Date.now();
    res.json({ success: true, command: target.command });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: errorMessage || 'Failed to write to terminal' });
  }
});

/** Whether this pane has a resumable agent conversation (for the UI affordance). */
router.get('/:sessionId/agent-resume', async (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }
  const target = resolveAgentResumeTarget(sessionId, session);
  const busy = !!(session.agent && session.agentSession
    && (session.agentSession.status === 'working' || session.agentSession.status === 'waiting'));
  const activeBackendSessionId = target ? findActiveAgentResumeOwner(sessionId, target) : null;
  const activeWriterPid = target && !activeBackendSessionId ? await findExternalCodexWriter(target) : null;
  res.json({
    available: target !== null && activeBackendSessionId === null && activeWriterPid === null,
    command: target?.command ?? null,
    busy,
    conflict: activeBackendSessionId || activeWriterPid ? 'active-elsewhere' : null,
    activeBackendSessionId,
    activeWriterPid,
  });
});

router.post('/:sessionId/resize', async (req, res) => {
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
    const applyResize = () => applyPtyResize(
      sessionId,
      session,
      Number(cols),
      Number(rows),
      'http-resize',
    );
    const ok = session.mode === 'tmux'
      ? await enqueueTmuxIo(session, applyResize)
      : applyResize();
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
  options: { sinceSeq?: number; pushClientId?: string } = {},
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
        const layout = await getCachedTmuxLayout(session.tmuxSessionName);
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
      activeProgram: session.activeProgram?.command ?? getPersistedActiveProgramForBackend(sessionId),
      activeProgramRaw: session.activeProgram?.rawArgs ?? null,
      activeProgramSource: session.activeProgram?.source ?? null,
      tuiProgress: session.tuiProgress,
      shellTitle: session.lastOscTitle,
      promptState: session.lastPromptState,
      focusTrackingRequested: session.focusTrackingRequested,
      // 短线重连补帧：
      // replayChunks 为补发数据；replayLastSeq 是客户端应记录的新基线；
      // replayOutOfWindow 表示客户端基线已被服务端淘汰，前端可以选择清屏后再回放。
      replayChunks,
      replayLastSeq,
      replayOutOfWindow,
    }));
    // Rich agent state rides its own message (see the SSE path above).
    if (session.agent || session.agentSession || session.agentResumeRecovered) {
      ws.send(JSON.stringify(buildAgentStatusPayload(sessionId, session)));
    }
    if (session.gitStatus) {
      ws.send(JSON.stringify({ type: 'git-status', gitStatus: session.gitStatus }));
    }
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
        const layout = await getCachedTmuxLayout(session.tmuxSessionName!);
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
          persistActiveProgramBinding(sessionId, ap?.command);

          // Agent status: react to AI tool start/exit
          syncAgentIdentity(sessionId, session);

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
          refreshGitStatus(sessionId, session, { minIntervalMs: 0 });
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
          const wasRunning = session.lastPromptState === 'running';
          session.lastPromptState = inferredState;
          ws.send(JSON.stringify({ type: 'prompt-state', state: inferredState }));
          if (wasRunning && inferredState === 'idle') {
            refreshGitStatus(sessionId, session);
          }
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
          persistActiveProgramBinding(sessionId, ap?.command);

          // Agent status: react to AI tool start/exit
          syncAgentIdentity(sessionId, session);

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
            const data = msg.data;
            if (session.mode === 'tmux') {
              await enqueueTmuxIo(session, async () => {
                if (isTmuxWheelInput(data)) {
                  await syncTmuxScreenBeforeScroll(sessionId, clientId, session, ws);
                }
                session.lastActivity = Date.now();
                session.ptyProcess.write(data);
              });
            } else {
              session.lastActivity = Date.now();
              session.ptyProcess.write(data);
            }
          }
          break;
        }
        case 'resize': {
          const cols = Number(msg.cols);
          const rows = Number(msg.rows);
          if (cols > 0 && rows > 0) {
            const ok = session.mode === 'tmux'
              ? await enqueueTmuxIo(session, () => applyPtyResize(
                  sessionId,
                  session,
                  cols,
                  rows,
                  `ws-resize:${clientId}`,
                  clientId,
                ))
              : applyPtyResize(sessionId, session, cols, rows, `ws-resize:${clientId}`, clientId);
            ws.send(JSON.stringify({
              type: 'resize-ack',
              seq: typeof msg.seq === 'number' ? msg.seq : undefined,
              ok,
              cols: session.cols,
              rows: session.rows,
            }));
          }
          break;
        }
        case 'tmux': {
          const reqId = msg.reqId as string | undefined;
          if (session.mode !== 'tmux' || !session.tmuxSessionName) {
            ws.send(JSON.stringify({ type: 'tmux-result', reqId, success: false, error: 'Not in tmux mode' }));
            break;
          }
          const result = await enqueueTmuxIo(session, async () => {
            if (msg.action === 'scroll') {
              await syncTmuxScreenBeforeScroll(sessionId, clientId, session, ws);
            }
            return executeTmuxAction(
              session.tmuxSessionName!,
              msg.action as string,
              msg as unknown as Record<string, unknown>,
              session.tmuxControl,
            );
          });
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
        case 'viewing': {
          // Push suppression: while this client is actively viewing the
          // session, its agent-transition push is redundant — skip it.
          // Kept separate from 'focus' (which requires textarea focus for
          // tmux focus tracking): on mobile the keyboard is routinely
          // dismissed while the user is still watching the session.
          if (options.pushClientId) {
            const viewing = msg.viewing === true;
            setClientViewingSession(options.pushClientId, sessionId, viewing);
          }
          break;
        }
        case 'flow-control': {
          if (typeof msg.paused === 'boolean') {
            const reason = typeof msg.reason === 'string' ? msg.reason : 'client-flow-control';
            setClientFlowPaused(sessionId, session, clientId, msg.paused, reason);
          }
          break;
        }
        case 'agent-review-ack': {
          if (session.agentSession && session.agentSession.reviewed === false) {
            session.agentSession.reviewed = true;
            session.lastAgentReviewed = null;
            broadcastAgentStatus(sessionId, session, true);
          } else if (session.lastAgentReviewed === false) {
            session.lastAgentReviewed = null;
            broadcastAgentStatus(sessionId, session, true);
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
    if (options.pushClientId) {
      setClientViewingSession(options.pushClientId, sessionId, false);
    }
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
      ws.send(JSON.stringify({ type: 'update-state', state: npmAutoUpdateManager.getState() }));
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

const automationTimer: ReturnType<typeof setInterval> = setInterval(() => {
  for (const automation of automationStore.due()) {
    void runAgentAutomation(automation).catch((error) => {
      console.warn(`[automation] ${automation.id} failed:`, getErrorMessage(error));
    });
  }
}, 30_000);
automationTimer.unref?.();

async function reconcileClientState(): Promise<void> {
  if (globalSessionState.sessions.length === 0) return;

  const toRemove: string[] = [];
  const toDetach: string[] = [];
  for (const entry of globalSessionState.sessions) {
    if (entry.mode === 'shell') {
      // Shell wrapper: backendSessionId must map to a live terminal session.
      // A resumable Agent record survives with a detached backend so the tab
      // can rebuild its shell; ordinary dead shells still disappear.
      if (!entry.backendSessionId || !terminalSessions.has(entry.backendSessionId)) {
        if (canRestoreDeadAgentShell(entry)) {
          if (entry.backendSessionId) toDetach.push(entry.sessionId);
        } else {
          toRemove.push(entry.sessionId);
        }
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

  if (toRemove.length === 0 && toDetach.length === 0) return;
  const detached = new Set(toDetach);
  globalSessionState = {
    sessions: globalSessionState.sessions
      .filter((s) => !toRemove.includes(s.sessionId))
      .map((s) => detached.has(s.sessionId) ? { ...s, backendSessionId: null } : s),
    updatedAt: Date.now(),
  };
  schedulePersistGlobalState();
  broadcastClientState();
  if (toRemove.length > 0) {
    console.log(`[reconcile] removed ${toRemove.length} orphan client-state entries: ${toRemove.join(', ')}`);
  }
  if (toDetach.length > 0) {
    console.log(`[reconcile] detached ${toDetach.length} resumable Agent shell entries: ${toDetach.join(', ')}`);
  }
}

export default router;
