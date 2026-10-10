import { ARCHITECTURE_FIELDS, type ArchitectureDocument } from './document.js';
export interface ArchitectureChange { perspective: string; node?: string; title: string; kind: 'added' | 'removed' | 'changed'; fields: string[] }
/** Compare semantic document content, excluding timestamps and update counters. */
export function diffArchitecture(before: ArchitectureDocument | null, after: ArchitectureDocument): ArchitectureChange[] {
  const changes: ArchitectureChange[] = [];
  if (before) {
    const changed = ['summary', 'analysis', 'details', 'origin'].filter(key => JSON.stringify(before[key as keyof ArchitectureDocument]) !== JSON.stringify(after[key as keyof ArchitectureDocument]));
    if (changed.length) changes.push({ perspective: '', title: 'Project overview', kind: 'changed', fields: changed });
  }
  const oldViews = new Map(before?.perspectives.map(view => [view.id, view]) ?? []);
  for (const view of after.perspectives) {
    const previous = oldViews.get(view.id);
    oldViews.delete(view.id);
    if (!previous) changes.push({ perspective: view.id, title: view.title, kind: 'added', fields: [] });
    else {
      const changed = ['title', 'summary', 'edges', ...ARCHITECTURE_FIELDS].filter(key => JSON.stringify(previous[key as keyof typeof previous]) !== JSON.stringify(view[key as keyof typeof view]));
      if (changed.length) changes.push({ perspective: view.id, title: view.title, kind: 'changed', fields: changed });
    }
    const oldNodes = new Map(previous?.nodes.map(node => [node.id, node]) ?? []);
    for (const node of view.nodes) {
      const old = oldNodes.get(node.id); oldNodes.delete(node.id);
      if (!old) changes.push({ perspective: view.id, node: node.id, title: node.title, kind: 'added', fields: [] });
      else {
        const changed = ['title', 'summary', 'parentId', 'files', 'references', 'role', ...ARCHITECTURE_FIELDS].filter(key => JSON.stringify(old[key as keyof typeof old]) !== JSON.stringify(node[key as keyof typeof node]));
        if (changed.length) changes.push({ perspective: view.id, node: node.id, title: node.title, kind: 'changed', fields: changed });
      }
    }
    for (const old of oldNodes.values()) changes.push({ perspective: view.id, node: old.id, title: old.title, kind: 'removed', fields: [] });
  }
  for (const old of oldViews.values()) changes.push({ perspective: old.id, title: old.title, kind: 'removed', fields: [] });
  return changes;
}
