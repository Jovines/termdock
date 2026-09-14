import { create } from 'zustand';
import type { CollaborationGroup } from '../terminal/api';

// The sidebar owns fetching and optimistic mutations; all navigation surfaces
// consume the same snapshot, including while a member move is being saved.
export const useSessionOrderStore = create<{
  collaborationGroups: CollaborationGroup[];
  setCollaborationGroups: (next: CollaborationGroup[] | ((current: CollaborationGroup[]) => CollaborationGroup[])) => void;
}>((set) => ({
  collaborationGroups: [],
  setCollaborationGroups: (next) => set((state) => ({
    collaborationGroups: typeof next === 'function' ? next(state.collaborationGroups) : next,
  })),
}));
