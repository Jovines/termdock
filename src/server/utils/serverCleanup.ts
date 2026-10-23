import type { EventEmitter } from 'node:events';

/** Share one close listener across server resources, including async startup. */
export function serverCleanup(server: Pick<EventEmitter, 'once'>, onError: (error: unknown) => void = error => console.error('[server-cleanup]', error)) {
  const callbacks: Array<() => void> = [];
  let closed = false;
  const run = (callback: () => void) => {
    try { callback(); } catch (error) { onError(error); }
  };
  server.once('close', () => {
    closed = true;
    for (const callback of callbacks.splice(0)) run(callback);
  });
  return (callback: () => void): void => {
    if (closed) run(callback);
    else callbacks.push(callback);
  };
}
