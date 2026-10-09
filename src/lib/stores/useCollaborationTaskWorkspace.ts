import { create } from 'zustand';
import type { Dispatch, SetStateAction } from 'react';

export type CollaborationGoalDraft = { mode: 'goal' | 'task'; isolated: boolean; title: string; spec: string; constraints: string; acceptance: string; assignee: string; coordinator: string; parent: string; dependencies: string[] };
export interface CollaborationTaskDetailDraft {
  feedback: string;
  answers: Record<string, string>;
  view: 'overview' | 'results' | 'activity';
}
export interface CollaborationTaskWorkspace {
  draft: CollaborationGoalDraft;
  selectedId: string | null;
  creating: boolean;
  mobileDetail: boolean;
}

/** Resident and expanded views edit one workspace, so closing the expanded view preserves intent. */
export const useCollaborationTaskWorkspace = create<{
  views: Record<string, CollaborationTaskWorkspace>;
  details: Record<string, CollaborationTaskDetailDraft>;
  ensureDetail: (key: string, initial: CollaborationTaskDetailDraft) => CollaborationTaskDetailDraft;
  updateDetail: <K extends keyof CollaborationTaskDetailDraft>(key: string, field: K, value: SetStateAction<CollaborationTaskDetailDraft[K]>) => void;
  ensure: (key: string, initial: CollaborationTaskWorkspace) => CollaborationTaskWorkspace;
  update: <K extends keyof CollaborationTaskWorkspace>(key: string, field: K, value: SetStateAction<CollaborationTaskWorkspace[K]>) => void;
}>((set, get) => ({
  views: {}, details: {},
  ensureDetail: (key, initial) => {
    const existing = get().details[key];
    if (existing) return existing;
    set(state => ({ details: { ...state.details, [key]: initial } }));
    return initial;
  },
  updateDetail: (key, field, value) => set(state => {
    const current = state.details[key];
    if (!current) return state;
    const next = typeof value === 'function'
      ? (value as (previous: typeof current[typeof field]) => typeof current[typeof field])(current[field])
      : value;
    if (Object.is(current[field], next)) return state;
    return { details: { ...state.details, [key]: { ...current, [field]: next } } };
  }),
  ensure: (key, initial) => {
    const existing = get().views[key];
    if (existing) return existing;
    set(state => ({ views: { ...state.views, [key]: initial } }));
    return initial;
  },
  update: (key, field, value) => set(state => {
    const current = state.views[key];
    if (!current) return state;
    const next = typeof value === 'function'
      ? (value as (previous: typeof current[typeof field]) => typeof current[typeof field])(current[field])
      : value;
    if (Object.is(current[field], next)) return state;
    return { views: { ...state.views, [key]: { ...current, [field]: next } } };
  }),
}));

export function taskWorkspaceDispatch<K extends keyof CollaborationTaskWorkspace>(key: string, field: K): Dispatch<SetStateAction<CollaborationTaskWorkspace[K]>> {
  return value => useCollaborationTaskWorkspace.getState().update(key, field, value);
}

export function taskDetailDispatch<K extends keyof CollaborationTaskDetailDraft>(key: string, field: K): Dispatch<SetStateAction<CollaborationTaskDetailDraft[K]>> {
  return value => useCollaborationTaskWorkspace.getState().updateDetail(key, field, value);
}
