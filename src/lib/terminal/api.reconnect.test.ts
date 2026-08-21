import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_HEALTH_REQUEST_TIMEOUT_MS,
  TERMINAL_SESSION_OPEN_REQUEST_TIMEOUT_MS,
  checkTerminalHealth,
  openSessionInventoryEntry,
  resetCsrfTokenCache,
} from './api';

function pendingUntilAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

afterEach(() => {
  resetCsrfTokenCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('terminal recovery request timeouts', () => {
  it('bounds a health request that never returns', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      pendingUntilAbort(init?.signal)
    )));

    const request = checkTerminalHealth('stuck-session');
    const rejection = expect(request).rejects.toThrow('Terminal health check timed out');
    await vi.advanceTimersByTimeAsync(TERMINAL_HEALTH_REQUEST_TIMEOUT_MS);
    await rejection;
  });

  it('releases a timed-out pending open so a later recovery can proceed', async () => {
    vi.useFakeTimers();
    let openAttempts = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/csrf-token') {
        return Promise.resolve(new Response(JSON.stringify({ csrfToken: 'test-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url === '/api/terminal/session-inventory/open') {
        openAttempts += 1;
        if (openAttempts === 1) {
          return pendingUntilAbort(init?.signal);
        }
        return Promise.resolve(new Response(JSON.stringify({
          terminalSession: {
            sessionId: 'recovered-session',
            cols: 80,
            rows: 24,
            mode: 'shell',
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const first = openSessionInventoryEntry({
      preferredFrontendSessionId: 'frontend-session',
      mode: 'shell',
      requireExisting: true,
    });
    const firstRejection = expect(first).rejects.toThrow('Terminal session open request timed out');
    await vi.advanceTimersByTimeAsync(TERMINAL_SESSION_OPEN_REQUEST_TIMEOUT_MS);
    await firstRejection;

    const recovered = await openSessionInventoryEntry({
      preferredFrontendSessionId: 'frontend-session',
      mode: 'shell',
      requireExisting: true,
    });
    expect(recovered.terminalSession.sessionId).toBe('recovered-session');
    expect(openAttempts).toBe(2);
  });
});
