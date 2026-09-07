import type { Object3D } from 'three';
import { assemblyRoots } from './modelExplosion';

export interface ModelPartInfo { id: string; name: string; initiallyVisible: boolean }

export interface PartVisibilityState { hidden: string[]; history: string[][] }
export type PartVisibilityAction =
  | { type: 'set'; hidden: string[] }
  | { type: 'toggle'; id: string }
  | { type: 'undo' }
  | { type: 'reset' };

/** Keep successive hides reversible without resetting the viewing pose. */
export function partVisibilityReducer(state: PartVisibilityState, action: PartVisibilityAction): PartVisibilityState {
  if (action.type === 'reset') return { hidden: [], history: [] };
  if (action.type === 'undo') {
    return state.history.length ? { hidden: state.history[state.history.length - 1], history: state.history.slice(0, -1) } : state;
  }
  const hidden = action.type === 'toggle'
    ? state.hidden.includes(action.id) ? state.hidden.filter((id) => id !== action.id) : [...state.hidden, action.id]
    : [...new Set(action.hidden)];
  if (hidden.length === state.hidden.length && hidden.every((id) => state.hidden.includes(id))) return state;
  return { hidden, history: [...state.history.slice(-19), state.hidden] };
}

/** Three's raycaster also intersects invisible objects and their descendants. */
export function isObjectVisible(node: Object3D): boolean {
  for (let current: Object3D | null = node; current; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

export function createModelVisibility(root: Object3D) {
  const parts = assemblyRoots(root).map((node, index) => ({
    node,
    // Stable across fullscreen remounts of the same file, unlike Three UUIDs.
    id: `part-${index}`,
    visible: node.visible,
  }));
  const byNode = new Map(parts.map((part) => [part.node, part]));
  return {
    parts: parts.map(({ id, node, visible }): ModelPartInfo => ({
      id, name: node.userData.termdockPartName || node.name, initiallyVisible: visible,
    })),
    node: (id: string) => parts.find((part) => part.id === id)?.node,
    id(node: Object3D): string | undefined {
      for (let current: Object3D | null = node; current; current = current.parent) {
        const part = byNode.get(current);
        if (part) return part.id;
      }
      return undefined;
    },
    setHidden(ids: readonly string[]) {
      const hidden = new Set(ids);
      for (const part of parts) part.node.visible = part.visible && !hidden.has(part.id);
    },
    isPartVisible(key?: string): boolean {
      if (!key) return true;
      const matches = parts.filter(({ node }) => node.uuid === key || node.name === key
        || node.userData.termdockPartName === key);
      return matches.length === 0 || matches.some(({ node }) => isObjectVisible(node));
    },
  };
}
