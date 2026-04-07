import type { TerminalAPI, TerminalHandlers, TerminalStreamOptions, CreateTerminalOptions, ResizeTerminalPayload, TerminalSession, ForceKillOptions, TmuxActionPayload } from './types';
import { createTerminalSession, connectTerminalStream, sendTerminalInput, resizeTerminal, closeTerminal, restartTerminalSession, forceKillTerminal, checkTerminalHealth, sendTmuxAction, listTmuxSessions, getTmuxStatus } from './api';

const getRetryPolicy = (options?: TerminalStreamOptions) => {
  const retry = options?.retry;
  return {
    maxRetries: retry?.maxRetries ?? 3,
    initialRetryDelay: retry?.initialDelayMs ?? 1000,
    maxRetryDelay: retry?.maxDelayMs ?? 8000,
    connectionTimeout: options?.connectionTimeoutMs ?? 10000,
  };
};

export const createTermdockAPI = (): TerminalAPI => ({
  async createSession(options: CreateTerminalOptions): Promise<TerminalSession> {
    return createTerminalSession(options);
  },

  connect(sessionId: string, handlers: TerminalHandlers, options?: TerminalStreamOptions) {
    const unsubscribe = connectTerminalStream(
      sessionId,
      handlers.onEvent,
      handlers.onError,
      getRetryPolicy(options)
    );

    return {
      close: () => unsubscribe(),
    };
  },

  async sendInput(sessionId: string, input: string): Promise<void> {
    await sendTerminalInput(sessionId, input);
  },

  async resize(payload: ResizeTerminalPayload): Promise<void> {
    await resizeTerminal(payload.sessionId, payload.cols, payload.rows);
  },

  async close(sessionId: string): Promise<void> {
    await closeTerminal(sessionId);
  },

  async restartSession(
    currentSessionId: string,
    options: CreateTerminalOptions
  ): Promise<TerminalSession> {
    return restartTerminalSession(currentSessionId, {
      cols: options.cols,
      rows: options.rows,
      mode: options.mode,
      tmuxSessionName: options.tmuxSessionName,
    });
  },

  async forceKill(options: ForceKillOptions): Promise<void> {
    await forceKillTerminal(options);
  },

  async tmuxAction(sessionId: string, payload: TmuxActionPayload): Promise<{ success: boolean }> {
    return sendTmuxAction(sessionId, payload);
  },

  async listTmuxSessions() {
    return listTmuxSessions();
  },
  async getTmuxStatus() {
    return getTmuxStatus();
  },

  async checkHealth(sessionId: string): Promise<{
    healthy: boolean;
    sessionId: string;
    cwd?: string;
    clients?: number;
    lastActivity?: number;
    backend?: string;
    mode?: 'shell' | 'tmux';
    tmuxSessionName?: string | null;
    activeProgram?: string | null;
    activeProgramSource?: 'tmux-pane' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
  }> {
    return checkTerminalHealth(sessionId);
  },
});
