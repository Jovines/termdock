import { useTerminalStore } from '../stores/useTerminalStore';

/** Server-authoritative output activity. No browser clocks or inferred agent state. */
export function useTerminalOutputActivity(sessionId: string, enabled = true): boolean {
  return useTerminalStore(state => enabled && !!state.sessions.get(sessionId)?.terminalSessionId
    && state.sessions.get(sessionId)?.terminalOutputActive === true);
}
