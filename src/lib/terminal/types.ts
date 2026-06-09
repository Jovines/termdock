export type TerminalMode = 'shell' | 'tmux';

export type AgentStatus = string;
export type AgentIndicator = 'spinner' | 'pulse' | 'dot' | 'ring' | 'badge' | 'terminal' | 'question';

export interface TmuxPane {
  id: string;
  index: number;
  active: boolean;
  width: number;
  height: number;
  top: number;
  left: number;
  pid?: number | null;
  tty?: string | null;
  command: string;
  title: string;
}

export interface TmuxWindow {
  id: string;
  name: string;
  index: number;
  active: boolean;
  panes: TmuxPane[];
}

export interface TmuxLayout {
  sessionId: string;
  sessionName: string;
  windows: TmuxWindow[];
  activeWindowId: string;
  activePaneId: string;
  inCopyMode: boolean;
}

export interface TmuxSessionSummary {
  name: string;
  windows: number;
  attached: number;
  createdAt?: number | null;
  boundFrontendSessionId?: string | null;
  connected?: boolean;
  live?: boolean;
  restorable?: boolean;
  friendlyName?: string | null;
  label?: string | null;
  program?: string | null;
  cwd?: string | null;
  clientCount?: number | null;
  lastActiveAt?: number | null;
}

export interface SessionInventoryClientSession {
  frontendSessionId: string;
  sessionId: string;
  name: string;
  customName: boolean;
  backendSessionId: string | null;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  createdAt: number;
  lastActivity: number;
  connected: boolean;
  live: boolean;
  restorable: boolean;
}

export interface SessionInventoryTmuxSession extends TmuxSessionSummary {
  attachedCount: number;
  boundFrontendSessionId: string | null;
  connected: boolean;
  live: boolean;
  restorable: boolean;
  friendlyName: string | null;
  label: string | null;
  program: string | null;
  cwd: string | null;
  clientCount: number | null;
  createdAt: number | null;
  lastActiveAt: number | null;
}

export interface SessionInventory {
  clientSessions: SessionInventoryClientSession[];
  tmuxSessions: SessionInventoryTmuxSession[];
  tmuxStatus: TmuxStatus;
  updatedAt: number;
}

export interface OpenSessionInventoryOptions {
  preferredFrontendSessionId?: string;
  name?: string;
  customName?: boolean;
  mode?: TerminalMode;
  tmuxSessionName?: string | null;
  cwd?: string;
  cols?: number;
  rows?: number;
  termType?: string;
}

export interface OpenSessionInventoryResult {
  session: SessionInventoryClientSession;
  terminalSession: TerminalSession;
  inventory: SessionInventory;
  reused: boolean;
}

export interface TmuxStatus {
  available: boolean;
  version: string | null;
  reason: string | null;
}

// Terminal Session Types
export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  mode?: TerminalMode;
  tmuxSessionName?: string | null;
  activeProgram?: string | null;
  activeProgramRaw?: string | null;
  activeProgramSource?: 'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
  cwd?: string | null;
}

// Stream Event Types
export interface TerminalStreamEvent {
  type: 'connected' | 'data' | 'exit' | 'reconnecting' | 'tmux-layout' | 'active-program' | 'cwd' | 'agent-status' | 'resize-ack' | 'focus-mode';
  data?: string;
  layout?: TmuxLayout;
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;
  runtime?: 'node' | 'bun';
  ptyBackend?: string;
  cwd?: string | null;
  mode?: TerminalMode;
  tmuxSessionName?: string | null;
  activeProgram?: string | null;
  activeProgramRaw?: string | null;
  activeProgramSource?: 'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
  agentStatus?: AgentStatus | null;
  agentColor?: string | null;
  agentIndicator?: AgentIndicator | null;
  focusTrackingRequested?: boolean;
  // 短线重连补帧（仅 connected 事件携带）：
  // replayChunks 是断线期间产生的输出，前端要追加到 buffer。
  // replayLastSeq 是新的客户端基线（保存为下一次重连的 since）。
  // replayOutOfWindow 表示客户端基线已被服务端淘汰，回放前最好清屏。
  replayChunks?: string[];
  replayLastSeq?: number;
  replayOutOfWindow?: boolean;
  seq?: number;
  cols?: number;
  rows?: number;
  ok?: boolean;
  error?: string;
}

// Create Session Options
export interface CreateTerminalOptions {
  cols?: number;
  rows?: number;
  mode?: TerminalMode;
  tmuxSessionName?: string;
  cwd?: string;
  termType?: string;
}

export interface TmuxActionPayload {
  action: 'select-pane' | 'select-window' | 'split-pane' | 'close-pane' | 'copy-mode' | 'scroll' | 'new-window' | 'switch-session';
  paneId?: string;
  windowId?: string;
  direction?: 'h' | 'v' | 'up' | 'down';
  enabled?: boolean;
  lines?: number;
  tmuxSessionName?: string;
}

// Stream Connection Options
export interface TerminalStreamOptions {
  retry?: RetryPolicy;
  connectionTimeoutMs?: number;
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

// Resize Payload
export interface ResizeTerminalPayload {
  sessionId: string;
  cols: number;
  rows: number;
  seq?: number;
}

// Event Handlers
export interface TerminalHandlers {
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: Error, fatal?: boolean) => void;
}

// Force Kill Options
export interface ForceKillOptions {
  sessionId?: string;
  cwd?: string;
}

// Main Terminal API Interface
export interface TerminalAPI {
  createSession(options: CreateTerminalOptions): Promise<TerminalSession>;
  connect(sessionId: string, handlers: TerminalHandlers, options?: TerminalStreamOptions): Subscription;
  sendInput(sessionId: string, input: string): Promise<void>;
  resize(payload: ResizeTerminalPayload): Promise<void>;
  close(sessionId: string): Promise<void>;
  restartSession?(currentSessionId: string, options: CreateTerminalOptions): Promise<TerminalSession>;
  forceKill?(options: ForceKillOptions): Promise<void>;
  tmuxAction?(sessionId: string, payload: TmuxActionPayload): Promise<{ success: boolean; layout?: TmuxLayout }>;
  listTmuxSessions?(): Promise<TmuxSessionSummary[]>;
  getTmuxStatus?(): Promise<TmuxStatus>;
  checkHealth?(sessionId: string): Promise<{
    healthy: boolean;
    sessionId: string;
    cwd?: string;
    clients?: number;
    lastActivity?: number;
    backend?: string;
    mode?: TerminalMode;
    tmuxSessionName?: string | null;
    activeProgram?: string | null;
    activeProgramRaw?: string | null;
    activeProgramSource?: 'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
  }>;
}

export interface Subscription {
  close: () => void;
}

// Terminal Chunk for buffer management
export interface TerminalChunk {
  id: number;
  data: string;
}

// Connect Stream Options
export interface ConnectStreamOptions {
  maxRetries?: number;
  initialRetryDelay?: number;
  maxRetryDelay?: number;
  connectionTimeout?: number;
}

// Terminal Session State
export interface TerminalSessionState {
  sessionId: string;       // 前端 session ID
  directory: string;
  terminalSessionId: string | null;  // 后端 session ID
  mode: TerminalMode;
  tmuxSessionName: string | null;
  activeProgram: string | null;
  activeProgramRaw: string | null;
  activeProgramSource: 'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
  cwd: string | null;
  inCopyMode: boolean;
  isConnecting: boolean;
  agentStatus: AgentStatus | null;
  agentColor: string | null;
  agentIndicator: AgentIndicator | null;
  agentNeedsReview: boolean;  // 前端状态：AI 从运行变为停止时，用户未查看 → 黄点提醒
  // 已删: 之前维护 `buffer: string` 派生字段,每次 setState 都 map+join 整个
  // chunks 数组(1MB 字符串 copy)。view 端自己用 useMemo 从 bufferChunks
  // 派生,节省 store setState 时的字符串复制。
  bufferChunks: TerminalChunk[];
  bufferLength: number;
  updatedAt: number;
  history?: string[];  // 从后端恢复的历史输出，仅 shell 模式使用
}

// 前端设置配置
export interface TerminalSettings {
  fontSize: number;  // 终端字体大小（像素）
}
