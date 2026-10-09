import { create } from 'zustand';

/** Workspace navigation is independent of terminal selection and dock layout. */
export const useCollaborationNavigation = create<{
  groupId: string | null;
  drafts: Record<string, { content: string; targets: string[] | null }>;
  setDraft: (groupId: string, draft: { content: string; targets: string[] | null }) => void;
  open: (groupId: string) => void;
  terminal: () => void;
}>(set => ({ drafts: {}, setDraft: (id, draft) => set(state => ({ drafts: { ...state.drafts, [id]: draft } })), groupId: null, open: groupId => set({ groupId }), terminal: () => set({ groupId: null }) }));
