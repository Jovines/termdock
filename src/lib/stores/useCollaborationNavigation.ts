import { create } from 'zustand';

/** Workspace navigation is independent of terminal selection and dock layout. */
export const useCollaborationNavigation = create<{
  groupId: string | null;
  view: 'tasks' | 'messages';
  drafts: Record<string, { content: string; targets: string[] | null }>;
  setDraft: (groupId: string, draft: { content: string; targets: string[] | null }) => void;
  open: (groupId: string, view?: 'tasks' | 'messages') => void;
  terminal: () => void;
}>(set => ({ drafts: {}, setDraft: (id, draft) => set(state => ({ drafts: { ...state.drafts, [id]: draft } })), groupId: null, view: 'tasks', open: (groupId, view = 'tasks') => set({ groupId, view }), terminal: () => set({ groupId: null }) }));
