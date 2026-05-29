import { create } from 'zustand';

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
  rightTab: 'files' | 'diff';

  // File tree state
  rootPath: string | null;
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  directoryCache: Map<string, FileTreeNode[]>;

  // Diff state
  diffFilePath: string | null;
  diffContent: string | null;
  diffLoading: boolean;
  diffError: string | null;

  // Changed files (from git diff --name-status)
  changedFiles: Map<string, string>;

  // Actions
  openLeft: () => void;
  closeLeft: () => void;
  toggleLeft: () => void;
  openRight: () => void;
  closeRight: () => void;
  toggleRight: () => void;
  closeAll: () => void;
  setRightTab: (tab: 'files' | 'diff') => void;
  setRootPath: (path: string | null) => void;
  toggleExpanded: (path: string) => void;
  selectFile: (path: string | null) => void;
  setDirectoryCache: (path: string, entries: FileTreeNode[]) => void;
  setDiff: (filePath: string | null, content: string | null, loading: boolean, error: string | null) => void;
  setChangedFiles: (files: Map<string, string>) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  leftOpen: false,
  rightOpen: false,
  rightTab: 'files',
  rootPath: null,
  expandedPaths: new Set(),
  selectedFilePath: null,
  directoryCache: new Map(),
  diffFilePath: null,
  diffContent: null,
  diffLoading: false,
  diffError: null,
  changedFiles: new Map(),

  openLeft: () => set({ leftOpen: true }),
  closeLeft: () => set({ leftOpen: false }),
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen, rightOpen: s.leftOpen ? s.rightOpen : false })),
  openRight: () => set({ rightOpen: true }),
  closeRight: () => set({ rightOpen: false }),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen, leftOpen: s.rightOpen ? s.leftOpen : false })),
  closeAll: () => set({ leftOpen: false, rightOpen: false }),

  setRightTab: (tab) => set({ rightTab: tab }),
  setRootPath: (path) => set({ rootPath: path }),

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

  setDiff: (filePath, content, loading, error) =>
    set({ diffFilePath: filePath, diffContent: content, diffLoading: loading, diffError: error }),

  setChangedFiles: (files) => set({ changedFiles: files }),
}));
