import type { FileTreeNode } from '../stores/useSidebarStore';
import { trimCache } from '../utils/cacheBudget';
import { isWithinDirectory } from './browserPaths';

export interface DirectoryCacheState {
  directoryCache: Map<string, FileTreeNode[]>;
  expandedPaths: Set<string>;
  rootPath?: string | null;
  explorerRoot?: string | null;
  setDirectoryCache: (path: string, entries: FileTreeNode[]) => void;
  invalidateDirectoryCache: (path: string, recursive?: boolean) => void;
  toggleExpanded: (path: string) => void;
}

/** The explorer and isolated pickers share cache behavior, with separate data. */
export function directoryCacheActions(set: (update: (state: DirectoryCacheState) => Partial<DirectoryCacheState>) => void) {
  return {
    setDirectoryCache: (path: string, entries: FileTreeNode[]) => set(state => {
      const directoryCache = new Map(state.directoryCache);
      directoryCache.delete(path);
      directoryCache.set(path, entries);
      trimCache(directoryCache, 128, new Set([...state.expandedPaths, path, state.explorerRoot ?? state.rootPath ?? '']));
      return { directoryCache };
    }),
    invalidateDirectoryCache: (path: string, recursive = false) => set(state => {
      const directoryCache = new Map(state.directoryCache);
      for (const key of directoryCache.keys()) {
        if (key === path || (recursive && isWithinDirectory(key, path))) directoryCache.delete(key);
      }
      return { directoryCache };
    }),
    toggleExpanded: (path: string) => set(state => {
      const expandedPaths = new Set(state.expandedPaths);
      if (expandedPaths.has(path)) expandedPaths.delete(path);
      else expandedPaths.add(path);
      return { expandedPaths };
    }),
  };
}
