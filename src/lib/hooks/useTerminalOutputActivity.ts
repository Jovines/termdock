import { useCallback, useSyncExternalStore } from 'react';
import { useTerminalStore } from '../stores/useTerminalStore';

export const TERMINAL_OUTPUT_IDLE_MS = 5_000;

// This observes bytes arriving from the terminal, not the agent's internal state.
export function useTerminalOutputActivity(sessionId: string, enabled = true): boolean {
  const getSnapshot = useCallback(() => {
    if (!enabled || document.visibilityState === 'hidden') return false;
    const session = useTerminalStore.getState().sessions.get(sessionId);
    if (!session?.terminalSessionId || session.lastOutputAt === null || !Number.isFinite(session.lastOutputAt)) return false;
    const age = Date.now() - session.lastOutputAt;
    return age >= 0 && age < TERMINAL_OUTPUT_IDLE_MS;
  }, [enabled, sessionId]);

  const subscribe = useCallback((notify: () => void) => {
    if (!enabled) return () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = getSnapshot();
    const check = () => {
      const current = getSnapshot();
      if (current !== previous) { previous = current; notify(); }
      // Do not reschedule on every packet: at expiry, read the latest receipt time.
      if (current && timer === undefined) {
        const lastOutputAt = useTerminalStore.getState().sessions.get(sessionId)!.lastOutputAt!;
        timer = setTimeout(() => { timer = undefined; check(); }, Math.max(1, lastOutputAt + TERMINAL_OUTPUT_IDLE_MS - Date.now()));
      } else if (!current && timer !== undefined) {
        clearTimeout(timer); timer = undefined;
      }
    };
    const unsubscribe = useTerminalStore.subscribe((state, previousState) => {
      const next = state.sessions.get(sessionId), old = previousState.sessions.get(sessionId);
      if (next?.lastOutputAt !== old?.lastOutputAt || next?.terminalSessionId !== old?.terminalSessionId) check();
    });
    document.addEventListener('visibilitychange', check);
    check();
    return () => { unsubscribe(); document.removeEventListener('visibilitychange', check); if (timer !== undefined) clearTimeout(timer); };
  }, [enabled, getSnapshot, sessionId]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
