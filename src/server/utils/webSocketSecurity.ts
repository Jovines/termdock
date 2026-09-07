import type WebSocket from 'ws';
import { authEvents, isAuthEnabled, isUpgradeRequestAuthenticated } from './authProtection.js';

/** Attach after application handlers. Recheck before input and during idle output. */
export function guardWebSocketSession(ws: WebSocket, cookie: string | undefined): void {
  const authenticatedAtConnect = isAuthEnabled();
  const check = (touch = false) => {
    if ((authenticatedAtConnect && !isAuthEnabled()) || !isUpgradeRequestAuthenticated(cookie, touch)) {
      // terminate immediately: a close handshake alone can leave input flowing.
      ws.terminate();
      return false;
    }
    return true;
  };
  const handlers = ws.listeners('message');
  ws.removeAllListeners('message');
  ws.on('message', (...args) => {
    if (!check(true)) return;
    for (const handler of handlers) handler.apply(ws, args);
  });
  const timer = setInterval(check, 1000);
  timer.unref();
  authEvents.on('revoked', check);
  ws.once('close', () => {
    clearInterval(timer);
    authEvents.off('revoked', check);
  });
}
