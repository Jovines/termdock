import { createContext, useContext, useState, type ReactNode } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import { directoryCacheActions, type DirectoryCacheState } from '../../filesystem/directoryCache';
import { useSidebarStore } from '../../stores/useSidebarStore';

const CacheContext = createContext<StoreApi<DirectoryCacheState> | null>(null);

export function FileTreeCacheScope({ children }: { children: ReactNode }) {
  const [store] = useState(() => createStore<DirectoryCacheState>(set => ({
    directoryCache: new Map(),
    expandedPaths: new Set(),
    ...directoryCacheActions(set),
  })));
  return <CacheContext.Provider value={store}>{children}</CacheContext.Provider>;
}

export function useFileTreeCacheStore(): StoreApi<DirectoryCacheState> {
  return useContext(CacheContext) ?? useSidebarStore;
}

export function useFileTreeCache<T>(selector: (state: DirectoryCacheState) => T): T {
  return useStore(useFileTreeCacheStore(), selector);
}
