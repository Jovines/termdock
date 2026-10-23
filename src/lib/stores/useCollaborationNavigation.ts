import { create } from 'zustand';

/** Workspace navigation is independent of terminal selection and dock layout. */
export const useCollaborationNavigation = create<{
  groupId: string | null;
  todoOpen: boolean;
  todoId: string | null;
  openTodos: () => void;
  selectTodo: (id: string | null) => void;
  view: 'tasks' | 'messages';
  drafts: Record<string, { content: string; targets: string[] | null }>;
  setDraft: (groupId: string, draft: { content: string; targets: string[] | null }) => void;
  open: (groupId: string, view?: 'tasks' | 'messages') => void;
  terminal: () => void;
}>(set => ({ todoOpen: false, todoId: null, openTodos: () => set({ todoOpen: true, groupId: null }), selectTodo: todoId => set({ todoId }), drafts: {}, setDraft: (id, draft) => set(state => ({ drafts: { ...state.drafts, [id]: draft } })), groupId: null, view: 'tasks', open: (groupId, view = 'tasks') => set({ groupId, view, todoOpen: false }), terminal: () => set({ groupId: null, todoOpen: false }) }));
