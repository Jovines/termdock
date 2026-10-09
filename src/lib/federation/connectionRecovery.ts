import { useSyncExternalStore } from 'react';

export const SECURE_READY_EVENT = 'termdock:secure-ready';
export type ConnectionRecovery = 'ready' | 'reconnecting' | 'offline';
let state: ConnectionRecovery = 'ready';
const listeners = new Set<() => void>();
export function setConnectionRecovery(next: ConnectionRecovery): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
  if (next === 'ready') window.dispatchEvent(new Event(SECURE_READY_EVENT));
}
export function useConnectionRecovery(): ConnectionRecovery {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}
export function isConnectionInterruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^(Secure connection closed|Secure connection timed out|Secure request closed|Secure response ended unexpectedly|Encrypted connection unavailable|Encrypted transport disconnected|Secure transport unavailable|Secure handshake timed out|WebSocket closed|WebSocket connection failed)$/.test(message);
}
