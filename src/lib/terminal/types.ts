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
  cwd: string;
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
  directory: string;
  terminalSessionId: string | null;
  isConnecting: boolean;
  buffer: string;
  bufferChunks: TerminalChunk[];
  bufferLength: number;
  updatedAt: number;
}
