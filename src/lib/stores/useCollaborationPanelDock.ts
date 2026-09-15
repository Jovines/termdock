import { create } from 'zustand';

export interface CollaborationDock {
  sessionId: string;
  side: 'left' | 'right' | 'top' | 'bottom';
}

export const useCollaborationPanelDock = create<{
  dock: CollaborationDock | null;
  host: HTMLElement | null;
  setDock: (dock: CollaborationDock | null) => void;
  setHost: (host: HTMLElement | null) => void;
}>(set => ({ dock: null, host: null, setDock: dock => set({ dock }), setHost: host => set({ host }) }));
