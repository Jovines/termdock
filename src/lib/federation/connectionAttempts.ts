import { DeviceAuthorizationRequired } from './deviceAuthorization';
import { ConnectionAccessError } from './accessFailure';
import { invitationDenial } from './invitationFailure';
import { CONNECTION_ROUND_TIMEOUT_MS } from '../../server/federation/streamLimits';

export interface ConnectionAttempt<T> {
  key: string;
  run(signal: AbortSignal): Promise<T>;
}
const HISTORY_PREFIX = 'termdock-secure-last-path:';
const PATH_LIFETIME_MS = 10 * 60_000;

export function preferredConnectionPath(serviceId: string): string | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(HISTORY_PREFIX + serviceId) || 'null');
    return saved && typeof saved.key === 'string' && Date.now() - saved.at < PATH_LIFETIME_MS ? saved.key : undefined;
  } catch { return undefined; }
}
export function rememberConnectionPath(serviceId: string, key: string): void {
  try { sessionStorage.setItem(HISTORY_PREFIX + serviceId, JSON.stringify({ key, at: Date.now() })); } catch { /* Optional latency hint. */ }
}

/** Hedge slow network paths, never one-use invitations. A verified denial ends
 * the whole attempt; a reachable alternate must not bypass revoked access. */
export function raceConnectionAttempts<T>(attempts: ConnectionAttempt<T>[], dispose: (value: T) => void, sequential = false, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ value: T; key: string }> {
  return new Promise((resolve, reject) => {
    let cursor = 0, pending = 0, settled = false, lastError: unknown, identityError: unknown, relayAccessError: unknown;
    let hedge: ReturnType<typeof setTimeout> | undefined;
    const controllers = new Set<AbortController>();
    const finish = () => {
      clearTimeout(hedge);
      clearTimeout(deadline); options.signal?.removeEventListener('abort', aborted);
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
    const stop = (error: unknown) => { if (settled) return; settled = true; finish(); reject(error); };
    const aborted = () => stop(options.signal?.reason);
    const deadline = setTimeout(() => stop(identityError || relayAccessError || new Error('连接路线尝试超时')), options.timeoutMs ?? CONNECTION_ROUND_TIMEOUT_MS);
    options.signal?.addEventListener('abort', aborted, { once: true });
    if (options.signal?.aborted) { aborted(); return; }
    const start = () => {
      if (settled) return;
      if (cursor >= attempts.length) {
        if (!pending) { settled = true; finish(); reject(identityError || relayAccessError || lastError || new Error('没有可用的连接路线。')); }
        return;
      }
      if (pending >= (sequential ? 1 : 2)) return;
      const attempt = attempts[cursor++];
      const started = performance.now();
      const measure = (ok: boolean) => {
        try {
          if (performance.getEntriesByName('termdock:connection-path').length > 64) performance.clearMeasures('termdock:connection-path');
          performance.measure('termdock:connection-path', { start: started, end: performance.now(), detail: { path: attempt.key.startsWith('relay:') ? 'relay' : 'direct', ok } });
        } catch { /* Optional timing APIs must never change connection results. */ }
      };
      const controller = new AbortController(); controllers.add(controller); pending++;
      let result: Promise<T>;
      try { result = attempt.run(controller.signal); } catch (error) { result = Promise.reject(error); }
      void result.then(value => {
        measure(true);
        controllers.delete(controller);
        if (settled) { dispose(value); return; }
        settled = true; finish(); resolve({ value, key: attempt.key });
      }, error => {
        measure(false);
        controllers.delete(controller); pending--;
        if (settled) return;
        lastError = error;
        // A later unreachable address must not hide an observed pin failure.
        // Still allow another route to succeed with that same pinned identity.
        if (error instanceof Error && error.name === 'UnexpectedPeerError') identityError = error;
        if (error instanceof ConnectionAccessError && ['TARGET_IDENTITY_MISMATCH', 'RELAY_SELF_TARGET'].includes(error.code)) identityError = error;
        if (error instanceof ConnectionAccessError && error.code === 'RELAY_AUTHORIZATION_REQUIRED') relayAccessError = error;
        if (invitationDenial(error) || error instanceof DeviceAuthorizationRequired || error instanceof ConnectionAccessError && error.code === 'TARGET_AUTHORIZATION_REQUIRED') { settled = true; finish(); reject(error); return; }
        start();
      });
      clearTimeout(hedge);
      if (!sequential && cursor < attempts.length) hedge = setTimeout(start, 400);
    };
    start();
  });
}
