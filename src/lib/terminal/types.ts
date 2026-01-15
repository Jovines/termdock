// Terminal Session Types
export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
}

// Stream Event Types
export interface TerminalStreamEvent {
  type: 'connected' | 'data' | 'exit' | 'reconnecting';
  data?: string;
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;
  runtime?: 'node' | 'bun';
  ptyBackend?: string;
}

// Create Session Options
export interface CreateTerminalOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
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
  checkHealth?(sessionId: string): Promise<{
    healthy: boolean;
    sessionId: string;
    cwd?: string;
    clients?: number;
    lastActivity?: number;
    backend?: string;
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
  isConnecting: boolean;
  buffer: string;
  bufferChunks: TerminalChunk[];
  bufferLength: number;
  updatedAt: number;
  history?: string[];  // 从后端恢复的历史输出
}

// 断联清理时长配置类型
export type DisconnectCleanupDuration = number;  // 清理时长（毫秒），Infinity 表示永不清理

// 预设的清理时长选项（毫秒）
export const CLEANUP_DURATION_PRESETS = {
  'never': Infinity,  // 永远不清理
  'default': 5 * 60 * 1000,  // 默认5分钟（开发环境）
  '5min': 5 * 60 * 1000,      // 5分钟
  '10min': 10 * 60 * 1000,    // 10分钟
  '30min': 30 * 60 * 1000,    // 30分钟
  '1hour': 60 * 60 * 1000,    // 1小时
  '2hours': 2 * 60 * 60 * 1000, // 2小时
  '1day': 24 * 60 * 60 * 1000,  // 1天
} as const;

export type CleanupDurationPreset = keyof typeof CLEANUP_DURATION_PRESETS;

// 前端设置配置
export interface TerminalSettings {
  cleanupDuration: DisconnectCleanupDuration;
  cleanupDurationPreset: CleanupDurationPreset | 'custom';
  fontSize: number;  // 终端字体大小（像素）
}
