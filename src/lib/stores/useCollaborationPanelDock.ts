import { create } from 'zustand';
export interface CollaborationDock { sessionId: string; side: 'left' | 'right' | 'top' | 'bottom' }
export const collaborationPaneId = (groupId: string) => `@collaboration:${groupId}`;
export const useCollaborationPanelDock = create<{
  docks: Record<string, CollaborationDock>;
  hosts: Record<string, HTMLElement>;
  setDock: (groupId: string, dock: CollaborationDock | null) => void;
  setHost: (groupId: string, host: HTMLElement | null) => void;
}>(set => ({
  docks: {}, hosts: {},
  setDock: (id, dock) => set(state => { const docks = { ...state.docks }; if (dock) docks[id] = dock; else delete docks[id]; return { docks }; }),
  setHost: (id, host) => set(state => { const hosts = { ...state.hosts }; if (host) hosts[id] = host; else delete hosts[id]; return { hosts }; }),
}));
