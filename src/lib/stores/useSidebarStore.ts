import { create } from 'zustand';
import type { GitChangedFile } from '../terminal/api';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  expanded?: boolean;
  loaded?: boolean;
  children?: FileTreeNode[];
}

interface SidebarState {
  // Sidebar visibility
  leftOpen: boolean;
  rightOpen: boolean;

  // Right sidebar tab
  rightTab: 'files' | 'diff' | 'file';

  // File tree state
  rootPath: string | null;
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  directoryCache: Map<string, FileTreeNode[]>;

  // Changed files (from git status/diff)
  changedFiles: Map<string, GitChangedFile>;

  // Git bundle loading state (for right sidebar UX)
  gitBundleLoading: boolean;
  gitBundleSlow: boolean;
  gitBundleError: string | null;
  gitBundleLastLoadedAt: number | null;

  // Actions
  openLeft: () => void;
  closeLeft: () => void;
  toggleLeft: () => void;
  openRight: () => void;
  closeRight: () => void;
  toggleRight: () => void;
  closeAll: () => void;
  setRightTab: (tab: 'files' | 'diff' | 'file') => void;
  setRootPath: (path: string | null) => void;
  toggleExpanded: (path: string) => void;
  selectFile: (path: string | null) => void;
  setDirectoryCache: (path: string, entries: FileTreeNode[]) => void;
  setChangedFiles: (files: Map<string, GitChangedFile>) => void;
  setGitBundleLoading: (loading: boolean) => void;
  setGitBundleSlow: (slow: boolean) => void;
  setGitBundleError: (error: string | null) => void;
  markGitBundleLoaded: () => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  leftOpen: false,
  rightOpen: false,
  rightTab: 'files',
  rootPath: null,
  expandedPaths: new Set(),
  selectedFilePath: null,
  directoryCache: new Map(),
  changedFiles: new Map(),
  gitBundleLoading: false,
  gitBundleSlow: false,
  gitBundleError: null,
  gitBundleLastLoadedAt: null,

  openLeft: () => set({ leftOpen: true }),
  closeLeft: () => set({ leftOpen: false }),
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen, rightOpen: s.leftOpen ? s.rightOpen : false })),
  openRight: () => set({ rightOpen: true }),
  closeRight: () => set({ rightOpen: false }),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen, leftOpen: s.rightOpen ? s.leftOpen : false })),
  closeAll: () => set({ leftOpen: false, rightOpen: false }),

  setRightTab: (tab) => set({ rightTab: tab }),
  setRootPath: (path) => set((s) => {
    if (s.rootPath === path) return s;
    return {
      rootPath: path,
      expandedPaths: new Set(),
      selectedFilePath: null,
      directoryCache: new Map(),
      changedFiles: new Map(),
      gitBundleLoading: false,
      gitBundleSlow: false,
      gitBundleError: null,
      gitBundleLastLoadedAt: null,
    };
  }),

  toggleExpanded: (path) =>
    set((s) => {
      const next = new Set(s.expandedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedPaths: next };
    }),

  selectFile: (path) => set({ selectedFilePath: path }),

  setDirectoryCache: (path, entries) =>
    set((s) => {
      const next = new Map(s.directoryCache);
      next.set(path, entries);
      return { directoryCache: next };
    }),

  setChangedFiles: (files) => set({ changedFiles: files }),
  setGitBundleLoading: (loading) => set({ gitBundleLoading: loading }),
  setGitBundleSlow: (slow) => set({ gitBundleSlow: slow }),
  setGitBundleError: (error) => set({ gitBundleError: error }),
  markGitBundleLoaded: () => set({ gitBundleLastLoadedAt: Date.now(), gitBundleLoading: false, gitBundleSlow: false, gitBundleError: null }),
}));
