import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { DEFAULT_SESSION_DISPLAY_SHELL_NAMES, getSessionPresentation, getSessionSnapshotPresentation, type SessionDisplaySource, type SessionPresentation, type SessionPresentationSnapshot } from '../terminal/display';
import type { AgentIdentity, TerminalSessionState, TerminalMode } from '../terminal/types';
import { getCachedAgentIdentity, getCachedShellTitle, useTerminalStore } from './useTerminalStore';

export interface SessionDirectoryRecord extends SessionDisplaySource {
  collectionRunId?: string | null;
  sessionId: string; backendSessionId?: string | null; lastActivity: number; agent?: AgentIdentity | null;
}
/** UI consumers receive a label, never the persistence/transport `name` field. */
export interface SessionOption {
  mode: TerminalMode | null;
  collectionRunId?: string | null;
  sessionId: string; displayName: string; displaySubtitle: string | null; cwd: string | null;
  agent: AgentIdentity | null; lastActivity: number;
}
// The existing persistence reconciler is the only writer. No second request,
// cache, websocket or mutation path is introduced for feature-specific pickers.
export const useSessionDirectoryStore = create<{
  records: SessionDirectoryRecord[];
  shellNames: ReadonlySet<string>;
  setShellNames: (names: readonly string[]) => void;
  replace: (records: SessionDirectoryRecord[]) => void;
}>((set) => ({ records: [], shellNames: DEFAULT_SESSION_DISPLAY_SHELL_NAMES,
  setShellNames: names => set({ shellNames: new Set(names) }), replace: records => set({ records }) }));
export const setSessionShellNames = (names: readonly string[]) => useSessionDirectoryStore.getState().setShellNames(names);

export function sessionOption(record: SessionDirectoryRecord, live?: Partial<TerminalSessionState>, shellNames: ReadonlySet<string> = DEFAULT_SESSION_DISPLAY_SHELL_NAMES): SessionOption {
  // A stale stream belonging to a previous backend cannot rename a restored session.
  const matches = live && (!record.backendSessionId || !live.terminalSessionId || record.backendSessionId === live.terminalSessionId);
  const source = { ...record,
    shellTitle: record.shellTitle ?? (!live || matches ? getCachedShellTitle(record.sessionId) : null),
    agent: record.agent ?? (!live || matches ? getCachedAgentIdentity(record.sessionId) : null),
    ...(matches ? { activeProgram: live.activeProgram ?? record.activeProgram, cwd: live.cwd ?? record.cwd,
      shellTitle: live.shellTitle ?? record.shellTitle ?? getCachedShellTitle(record.sessionId), promptState: live.promptState ?? record.promptState,
      agent: live.agent ?? record.agent ?? getCachedAgentIdentity(record.sessionId) } : {}) };
  return { sessionId: record.sessionId, mode: record.mode ?? null, collectionRunId: record.collectionRunId ?? null, ...getSessionPresentation(source, shellNames), cwd: source.cwd ?? null,
    agent: source.agent ?? null, lastActivity: record.lastActivity };
}
export function getSessionDirectorySnapshot(): SessionOption[] {
  const live = useTerminalStore.getState().sessions;
  const { records, shellNames } = useSessionDirectoryStore.getState();
  return records.map(record => sessionOption(record, live.get(record.sessionId), shellNames));
}
/** The same reconciled sessions and live title hints used by the main session list. */
export function useSessionDirectory(): SessionOption[] {
  const records = useSessionDirectoryStore(state => state.records);
  const shellNames = useSessionDirectoryStore(state => state.shellNames);
  const metadata = useTerminalStore(useShallow(state => records.flatMap(record => {
    const live = state.sessions.get(record.sessionId);
    return [live?.terminalSessionId, live?.activeProgram, live?.cwd, live?.shellTitle, live?.promptState, live?.agent];
  })));
  return useMemo(() => getSessionDirectorySnapshot(), [records, metadata, shellNames]);
}

/** Join feature-specific facts to the main directory's titles without owning another inventory.
 * Remote/offline snapshots retain the title projected by their owning service.
 */
export function useSessionPresentations<T extends SessionPresentationSnapshot>(snapshots: T[]): (T & SessionPresentation)[] {
  const directory = useSessionDirectory();
  return useMemo(() => {
    const byId = new Map(directory.map(session => [session.sessionId, session]));
    return snapshots.map(snapshot => {
      const local = snapshot.sessionId ? byId.get(snapshot.sessionId) : undefined;
      const { displayName, displaySubtitle } = local ?? getSessionSnapshotPresentation(snapshot);
      return { ...snapshot, displayName, displaySubtitle };
    });
  }, [snapshots, directory]);
}
