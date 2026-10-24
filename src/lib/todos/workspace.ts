import { create } from 'zustand';
import type { AgentLauncherInfo } from '../terminal/api';
import type { TodoItem, TodoSnapshot } from './api';

export type TodoFilter = 'all' | 'open' | 'review' | 'completed' | 'ignored';
export type TodoModal = { kind: 'edit'; todo?: TodoItem } | { kind: 'recipient'; ids: string[] } | { kind: 'handoff'; ids: string[]; sessionId: string } | { kind: 'collector'; id?: string } | { kind: 'integration' } | null;
export interface TodoView {
  tab: 'todos' | 'collectors'; filter: TodoFilter; source: string; query: string;
  selectedId: string | null; mobileDetail: boolean; selecting: boolean; checked: string[];
  toolsOpen: boolean;
  column: 'open' | 'completed';
  modal: TodoModal; drafts: Record<string, unknown>; requests: Record<string, string>;
}
export const emptyTodoView: TodoView = { tab: 'todos', filter: 'all', column: 'open', source: '', query: '', selectedId: null, mobileDetail: false, selecting: false, checked: [], toolsOpen: false, modal: null, drafts: {}, requests: {} };
export const launchDraftId = (ids: string[]) => `launch:${JSON.stringify(ids.slice().sort())}`;
/** A workspace outlives responsive remounts and trips to its Agent terminal. */
export const useTodoWorkspace = create<{
  views: Record<string, TodoView>;
  snapshots: Record<string, TodoSnapshot>;
  options: Record<string, { agents: AgentLauncherInfo[]; preferred: string | null; cwd: string; directories?: string[] }>;
  cache: (key: string, data: TodoSnapshot) => void;
  cacheOptions: (key: string, value: { agents: AgentLauncherInfo[]; preferred: string | null; cwd: string; directories?: string[] }) => void;
  patch: (key: string, update: Partial<TodoView>) => void;
  draft: (key: string, id: string, value: unknown) => void;
  clearDraft: (key: string, id: string) => void;
  requestKey: (key: string, payload: unknown) => string;
  finishRequest: (key: string, payload: unknown) => void;
}>((set, get) => ({
  views: {}, snapshots: {}, options: {},
  cache: (key, data) => set(state => ({ snapshots: { ...state.snapshots, [key]: data } })),
  cacheOptions: (key, value) => set(state => ({ options: { ...state.options, [key]: value } })),
  patch: (key, update) => set(state => ({ views: { ...state.views, [key]: { ...(state.views[key] ?? emptyTodoView), ...update } } })),
  draft: (key, id, value) => { const view = get().views[key] ?? emptyTodoView; get().patch(key, { drafts: { ...view.drafts, [id]: value } }); },
  clearDraft: (key, id) => { const drafts = { ...(get().views[key] ?? emptyTodoView).drafts }; delete drafts[id]; get().patch(key, { drafts }); },
  requestKey: (key, payload) => {
    const fingerprint = JSON.stringify(payload), view = get().views[key] ?? emptyTodoView;
    if (view.requests[fingerprint]) return view.requests[fingerprint];
    const id = crypto.randomUUID(); get().patch(key, { requests: { ...view.requests, [fingerprint]: id } }); return id;
  },
  finishRequest: (key, payload) => { const requests = { ...(get().views[key] ?? emptyTodoView).requests }; delete requests[JSON.stringify(payload)]; get().patch(key, { requests }); },
}));
export function useTodoDraft<T>(key: string, id: string, initial: T): [T, (value: T) => void] {
  const saved = useTodoWorkspace(state => state.views[key]?.drafts[id]) as T | undefined;
  return [saved ?? initial, value => useTodoWorkspace.getState().draft(key, id, value)];
}
export function latestTodoRun(data: TodoSnapshot, id: string) { return data.runs.filter(run => run.todoId === id || run.handoff?.todoIds.includes(id)).at(-1); }
export function matchesTodo(data: TodoSnapshot, todo: TodoItem, filter: TodoFilter): boolean {
  if (filter === 'all') return todo.status === 'open' || todo.status === 'completed';
  if (filter === 'review') return todo.status === 'open' && latestTodoRun(data, todo.id)?.status === 'complete';
  return todo.status === (filter === 'completed' ? 'completed' : filter === 'ignored' ? 'ignored' : 'open');
}
