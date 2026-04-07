import type {
  TerminalSession,
  TerminalStreamEvent,
  CreateTerminalOptions,
  ConnectStreamOptions,
  TmuxActionPayload,
  TmuxLayout,
  TmuxSessionSummary,
  TmuxStatus,
} from './types';

let csrfToken: string | null = null;

/**
 * 获取CSRF令牌
 */
async function getCsrfToken(): Promise<string> {
  if (csrfToken) {
    return csrfToken as string;
  }

  const response = await fetch('/api/csrf-token');
  if (!response.ok) {
    throw new Error('Failed to get CSRF token');
  }

  const data = await response.json();
  csrfToken = data.csrfToken;
  return csrfToken as string;
}

export async function createTerminalSession(
  options: CreateTerminalOptions
): Promise<TerminalSession> {
  const keepAliveMs = Object.prototype.hasOwnProperty.call(options, 'keepAliveMs')
    ? (options.keepAliveMs ?? null)
    : 3 * 60 * 60 * 1000;
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
    body: JSON.stringify({
      cols: options.cols || 80,
      rows: options.rows || 24,
      mode: options.mode || 'shell',
      tmuxSessionName: options.tmuxSessionName,
      shouldPersist: options.shouldPersist ?? true,
      keepAliveMs,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to create terminal' }));
    throw new Error(error.error || 'Failed to create terminal session');
  }

  return response.json();
}

export function connectTerminalStream(
  sessionId: string,
  onEvent: (event: TerminalStreamEvent) => void,
  onError?: (error: Error, fatal?: boolean) => void,
  options: ConnectStreamOptions = {}
): () => void {
  const {
    maxRetries = 3,
    initialRetryDelay = 1000,
    maxRetryDelay = 8000,
    connectionTimeout = 10000,
  } = options;

  let eventSource: EventSource | null = null;
  let retryCount = 0;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let isClosed = false;
  let hasDispatchedOpen = false;
  let terminalExited = false;

  const clearTimeouts = () => {
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
    if (connectionTimeoutId) {
      clearTimeout(connectionTimeoutId);
      connectionTimeoutId = null;
    }
  };

  const cleanup = () => {
    isClosed = true;
    clearTimeouts();
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };

  const connect = () => {
    if (isClosed || terminalExited) {
      return;
    }

    if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
      console.warn('Attempted to create duplicate EventSource, skipping');
      return;
    }

    hasDispatchedOpen = false;
    eventSource = new EventSource(`/api/terminal/${sessionId}/stream`);

    connectionTimeoutId = setTimeout(() => {
      if (!hasDispatchedOpen && eventSource?.readyState !== EventSource.OPEN) {
        console.error('Terminal connection timeout');
        eventSource?.close();
        handleError(new Error('Connection timeout'), false);
      }
    }, connectionTimeout);

    eventSource.onopen = () => {
      if (hasDispatchedOpen) {
        return;
      }
      hasDispatchedOpen = true;
      retryCount = 0;
      clearTimeouts();

      onEvent({ type: 'connected' });
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as TerminalStreamEvent;

        if (data.type === 'exit') {
          terminalExited = true;
          cleanup();
        }

        onEvent(data);
      } catch (error) {
        console.error('Failed to parse terminal event:', error);
        onError?.(error as Error, false);
      }
    };

    eventSource.onerror = (error) => {
      console.error('Terminal stream error:', error, 'readyState:', eventSource?.readyState);
      clearTimeouts();

      eventSource?.close();
      eventSource = null;

      if (!terminalExited) {
        handleError(new Error('Terminal stream connection error'), false);
      }
    };
  };

  const handleError = (error: Error, isFatal: boolean) => {
    if (isClosed || terminalExited) {
      return;
    }

    if (retryCount < maxRetries && !isFatal) {
      retryCount++;
      const delay = Math.min(initialRetryDelay * Math.pow(2, retryCount - 1), maxRetryDelay);

      console.log(`Reconnecting to terminal stream (attempt ${retryCount}/${maxRetries}) in ${delay}ms`);

      onEvent({
        type: 'reconnecting',
        attempt: retryCount,
        maxAttempts: maxRetries,
      });

      retryTimeout = setTimeout(() => {
        if (!isClosed && !terminalExited) {
          connect();
        }
      }, delay);
    } else {
      console.error(`Terminal connection failed after ${retryCount} attempts`);
      onError?.(error, isFatal);
      cleanup();
    }
  };

  connect();

  return cleanup;
}

export async function sendTerminalInput(
  sessionId: string,
  data: string
): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/input`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
    body: data,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to send input' }));
    throw new Error(error.error || 'Failed to send terminal input');
  }
}

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/resize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
    body: JSON.stringify({ cols, rows }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to resize terminal' }));
    throw new Error(error.error || 'Failed to resize terminal');
  }
}

export async function closeTerminal(sessionId: string): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}`, {
    method: 'DELETE',
    headers: {
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to close terminal' }));
    throw new Error(error.error || 'Failed to close terminal');
  }
}

export async function restartTerminalSession(
  currentSessionId: string,
  options: { cwd?: string; cols?: number; rows?: number; keepAliveMs?: number | null; mode?: 'shell' | 'tmux'; tmuxSessionName?: string }
): Promise<TerminalSession> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${currentSessionId}/restart`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
    body: JSON.stringify({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      mode: options.mode,
      tmuxSessionName: options.tmuxSessionName,
      keepAliveMs: options.keepAliveMs,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to restart terminal' }));
    throw new Error(error.error || 'Failed to restart terminal session');
  }

  return response.json();
}

export async function checkTerminalHealth(sessionId: string): Promise<{
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
  const response = await fetch(`/api/terminal/${sessionId}/health`, {
    method: 'GET',
  });

  if (!response.ok) {
    if (response.status === 404) {
      return { healthy: false, sessionId };
    }
    const error = await response.json().catch(() => ({ error: 'Failed to check terminal health' }));
    throw new Error(error.error || 'Failed to check terminal health');
  }

  return response.json();
}

export interface PersistentTerminalProcess {
  sessionId: string;
  cwd: string;
  createdAt: number;
  lastActivity: number;
  backend: string;
  clients: number;
  mode: 'shell' | 'tmux';
  tmuxSessionName: string | null;
  shouldPersist: boolean;
  keepAliveMs: number | null;
  isOrphan: boolean;
  hasWrittenData: boolean;
  activeProgram: string | null;
  activeProgramSource: 'tmux-pane' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
}

export async function listTerminalProcesses(): Promise<{
  reconnect: {
    graceTime: number;
    scrollback: number;
    idleTimeout: number;
  };
  processes: PersistentTerminalProcess[];
}> {
  const response = await fetch('/api/terminal/processes', {
    method: 'GET',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to list terminal processes' }));
    throw new Error(error.error || 'Failed to list terminal processes');
  }

  return response.json();
}

export async function attachTerminalSession(sessionId: string): Promise<{
  sessionId: string;
  cwd: string;
  backend: string;
  clients: number;
  mode: 'shell' | 'tmux';
  tmuxSessionName: string | null;
  history: string[];
  shouldPersist: boolean;
  keepAliveMs: number | null;
  activeProgram: string | null;
  activeProgramSource: 'tmux-pane' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
}> {
  const response = await fetch(`/api/terminal/${sessionId}/attach`, {
    method: 'GET',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to attach terminal session' }));
    if (response.status === 404) {
      throw new Error('SESSION_NOT_FOUND');
    }
    throw new Error(error.error || 'Failed to attach terminal session');
  }

  return response.json();
}

export async function updateTerminalSessionPolicy(sessionId: string, policy: {
  keepAliveMs?: number | null;
  shouldPersist?: boolean;
}): Promise<{ sessionId: string; keepAliveMs: number | null; shouldPersist: boolean; clients: number }> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/policy`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
    body: JSON.stringify(policy),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to update terminal session policy' }));
    throw new Error(error.error || 'Failed to update terminal session policy');
  }

  return response.json();
}

export async function detachTerminalSession(sessionId: string): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/detach`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to detach terminal session' }));
    throw new Error(error.error || 'Failed to detach terminal session');
  }
}

export async function forceKillTerminal(options: {
  sessionId?: string;
  cwd?: string;
}): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/force-kill', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to force kill terminal' }));
    throw new Error(error.error || 'Failed to force kill terminal');
  }
}

export async function sendTmuxAction(
  sessionId: string,
  payload: TmuxActionPayload
): Promise<{ success: boolean; layout?: TmuxLayout }> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/tmux`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to execute tmux action' }));
    throw new Error(error.error || 'Failed to execute tmux action');
  }

  return response.json();
}

export async function listTmuxSessions(): Promise<TmuxSessionSummary[]> {
  const response = await fetch('/api/terminal/tmux/sessions', {
    method: 'GET',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to list tmux sessions' }));
    throw new Error(error.error || 'Failed to list tmux sessions');
  }

  const payload = await response.json() as { sessions?: TmuxSessionSummary[] };
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

export async function getTmuxStatus(): Promise<TmuxStatus> {
  const response = await fetch('/api/terminal/tmux/status', {
    method: 'GET',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get tmux status' }));
    throw new Error(error.error || 'Failed to get tmux status');
  }

  return response.json() as Promise<TmuxStatus>;
}

export interface PersistedTerminalClientSession {
  sessionId: string;
  name: string;
  backendSessionId: string | null;
  mode: 'shell' | 'tmux';
  tmuxSessionName: string | null;
  keepAliveMs: number | null;
  createdAt: number;
  lastActivity: number;
}

export interface TerminalClientState {
  sessions: PersistedTerminalClientSession[];
  activeSessionId?: string | null;
  updatedAt?: number;
}

export async function getTerminalClientState(): Promise<TerminalClientState> {
  const response = await fetch('/api/terminal/client-state', {
    method: 'GET',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to load terminal client state' }));
    throw new Error(error.error || 'Failed to load terminal client state');
  }

  return response.json();
}

export async function replaceTerminalClientState(state: TerminalClientState): Promise<TerminalClientState> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/client-state', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
    body: JSON.stringify(state),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to save terminal client state' }));
    throw new Error(error.error || 'Failed to save terminal client state');
  }

  return response.json();
}

export async function clearTerminalClientState(): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/client-state', {
    method: 'DELETE',
    headers: {
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to clear terminal client state' }));
    throw new Error(error.error || 'Failed to clear terminal client state');
  }
}
