import { create } from 'zustand';
import type { FileWatchEvent, GitChangedFile } from '../terminal/api';
import { readCache, writeCache } from '../utils/localStorageCache';

export type RightSidebarTab = 'git' | 'files' | 'diff' | 'file';

const RIGHT_SIDEBAR_TAB_CACHE_KEY = 'termdock:right-sidebar:tab:v1';
const EXPLORER_ROOTS_CACHE_KEY = 'termdock:right-sidebar:explorer-roots:v1';
const PINNED_EXPLORER_ROOTS_CACHE_KEY = 'termdock:right-sidebar:pinned-explorer-roots:v1';
const SHOW_HIDDEN_FILES_CACHE_KEY = 'termdock:right-sidebar:show-hidden-files:v1';
// 分组开关 / 折叠状态：复用 LeftSidebar 旧 localStorage key 以保留用户已有偏好。
// 旧编码是裸 localStorage（'1' 与 JSON 数组），与 readCache 包装格式不兼容，
// 因此这里用专用 reader/writer 沿用旧格式。
const GROUP_BY_FOLDER_KEY = 'termdock-sidebar-group-by-folder';
const COLLAPSED_GROUPS_KEY = 'termdock-sidebar-collapsed-folder-groups';

function readGroupByFolder(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(GROUP_BY_FOLDER_KEY) === '1';
  } catch {
    return false;
  }
}

function writeGroupByFolder(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) window.localStorage.setItem(GROUP_BY_FOLDER_KEY, '1');
    else window.localStorage.removeItem(GROUP_BY_FOLDER_KEY);
  } catch {
    // best-effort
  }
}

function readCollapsedGroups(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((k) => typeof k === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedGroups(keys: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...keys]));
  } catch {
    // best-effort
  }
}

interface ProjectSidebarState {
  explorerRoot: string | null;
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  directoryCache: Map<string, FileTreeNode[]>;
  changedFiles: Map<string, GitChangedFile>;
  gitBundleError: string | null;
  gitBundleLastLoadedAt: number | null;
}

function isRightSidebarTab(value: unknown): value is RightSidebarTab {
  return value === 'git' || value === 'files' || value === 'diff' || value === 'file';
}

function getInitialRightTab(): RightSidebarTab {
  return readCache(RIGHT_SIDEBAR_TAB_CACHE_KEY, isRightSidebarTab) ?? 'files';
}

function isExplorerRootCache(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
}

function readExplorerRootCache(): Record<string, string> {
  return readCache(EXPLORER_ROOTS_CACHE_KEY, isExplorerRootCache) ?? {};
}

function writeExplorerRootCache(cache: Record<string, string>): void {
  writeCache(EXPLORER_ROOTS_CACHE_KEY, cache);
}

// A pinned explorer entry can be a folder (used as a browse root) or a file
// (opened directly in the preview pane). Older builds persisted a plain
// `string[]` of folder paths; `normalizePinnedEntries` migrates those in place.
export type PinnedEntryKind = 'file' | 'directory';

export interface PinnedExplorerEntry {
  path: string;
  kind: PinnedEntryKind;
}

function isPinnedExplorerEntry(value: unknown): value is PinnedExplorerEntry {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PinnedExplorerEntry).path === 'string' &&
    ((value as PinnedExplorerEntry).kind === 'file' || (value as PinnedExplorerEntry).kind === 'directory')
  );
}

function isPinnedExplorerRootsCache(value: unknown): value is Record<string, Array<string | PinnedExplorerEntry>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => (
    Array.isArray(entry) && entry.every((item) => typeof item === 'string' || isPinnedExplorerEntry(item))
  ));
}

function normalizePinnedEntries(entries: Array<string | PinnedExplorerEntry>): PinnedExplorerEntry[] {
  const seen = new Set<string>();
  const normalized: PinnedExplorerEntry[] = [];
  for (const entry of entries) {
    const next: PinnedExplorerEntry = typeof entry === 'string' ? { path: entry, kind: 'directory' } : entry;
    if (!next.path || seen.has(next.path)) continue;
    seen.add(next.path);
    normalized.push(next);
  }
  return normalized;
}

function readPinnedExplorerRootsCache(): Record<string, PinnedExplorerEntry[]> {
  const raw = readCache(PINNED_EXPLORER_ROOTS_CACHE_KEY, isPinnedExplorerRootsCache) ?? {};
  const normalized: Record<string, PinnedExplorerEntry[]> = {};
  for (const [key, entries] of Object.entries(raw)) {
    normalized[key] = normalizePinnedEntries(entries);
  }
  return normalized;
}

function writePinnedExplorerRootsCache(cache: Record<string, PinnedExplorerEntry[]>): void {
  writeCache(PINNED_EXPLORER_ROOTS_CACHE_KEY, cache);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function getInitialShowHiddenFiles(): boolean {
  return readCache(SHOW_HIDDEN_FILES_CACHE_KEY, isBoolean) ?? false;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  expanded?: boolean;
  loaded?: boolean;
  children?: FileTreeNode[];
}

function getParentPath(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, '') || '/';
  if (normalized === '/') return '/';
  return normalized.slice(0, normalized.lastIndexOf('/')) || '/';
}

function isSameOrChildPath(parent: string, child: string): boolean {
  const normalizedParent = parent.replace(/\/+$/, '') || '/';
  return child === normalizedParent || child.startsWith(`${normalizedParent}/`);
}

function sortFileTreeNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
}

function toFileTreeNode(event: FileWatchEvent): FileTreeNode | null {
  if (!event.entry) return null;
  return {
    name: event.entry.name,
    path: event.entry.path,
    type: event.entry.type,
    expanded: false,
    loaded: false,
    children: event.entry.type === 'directory' ? [] : undefined,
  };
}

interface SidebarState {
  // Sidebar visibility
  leftOpen: boolean;
  rightOpen: boolean;

  // Right sidebar tab
  rightTab: RightSidebarTab;

  // Whether the right sidebar search box is open. Lifted out of the component
  // so global keyboard shortcuts can open + focus it.
  rightSearchOpen: boolean;

  // File tree state
  rootPath: string | null;
  explorerRoot: string | null;
  explorerRootCache: Record<string, string>;
  pinnedExplorerRootsCache: Record<string, PinnedExplorerEntry[]>;
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  directoryCache: Map<string, FileTreeNode[]>;

  // Whether dotfiles / hidden entries are shown in the file explorer.
  showHiddenFiles: boolean;

  // 会话分组（按 cwd）：顶栏 tab 与左侧边栏共享同一份状态。
  groupByFolder: boolean;
  collapsedGroups: Set<string>;

  // Changed files (from git status/diff)
  changedFiles: Map<string, GitChangedFile>;

  // Git bundle loading state (for right sidebar UX)
  gitBundleLoading: boolean;
  gitBundleSlow: boolean;
  gitBundleError: string | null;
  gitBundleLastLoadedAt: number | null;
  projectStateCache: Map<string, ProjectSidebarState>;

  // Actions
  openLeft: () => void;
  closeLeft: () => void;
  toggleLeft: () => void;
  openRight: () => void;
  closeRight: () => void;
  toggleRight: () => void;
  closeAll: () => void;
  setRightTab: (tab: RightSidebarTab) => void;
  openRightSearch: () => void;
  closeRightSearch: () => void;
  setRightSearchOpen: (open: boolean) => void;
  setRootPath: (path: string | null) => void;
  setExplorerRoot: (path: string | null) => void;
  resetExplorerToProject: () => void;
  pinExplorerRoot: (path: string, kind?: PinnedEntryKind) => void;
  unpinExplorerRoot: (path: string) => void;
  toggleExpanded: (path: string) => void;
  selectFile: (path: string | null) => void;
  toggleShowHiddenFiles: () => void;
  toggleGroupByFolder: () => void;
  setGroupByFolder: (enabled: boolean) => void;
  toggleGroupCollapsed: (key: string) => void;
  setDirectoryCache: (path: string, entries: FileTreeNode[]) => void;
  invalidateDirectoryCache: (path: string, recursive?: boolean) => void;
  applyFileWatchEvents: (events: FileWatchEvent[]) => void;
  setChangedFiles: (files: Map<string, GitChangedFile>) => void;
  setGitBundleLoading: (loading: boolean) => void;
  setGitBundleSlow: (slow: boolean) => void;
  setGitBundleError: (error: string | null) => void;
  markGitBundleLoaded: () => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  leftOpen: false,
  rightOpen: false,
  rightTab: getInitialRightTab(),
  rightSearchOpen: false,
  rootPath: null,
  explorerRoot: null,
  explorerRootCache: readExplorerRootCache(),
  pinnedExplorerRootsCache: readPinnedExplorerRootsCache(),
  expandedPaths: new Set(),
  selectedFilePath: null,
  directoryCache: new Map(),
  showHiddenFiles: getInitialShowHiddenFiles(),
  groupByFolder: readGroupByFolder(),
  collapsedGroups: readCollapsedGroups(),
  changedFiles: new Map(),
  gitBundleLoading: false,
  gitBundleSlow: false,
  gitBundleError: null,
  gitBundleLastLoadedAt: null,
  projectStateCache: new Map(),

  openLeft: () => set({ leftOpen: true }),
  closeLeft: () => set({ leftOpen: false }),
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen, rightOpen: s.leftOpen ? s.rightOpen : false })),
  openRight: () => set({ rightOpen: true }),
  closeRight: () => set({ rightOpen: false, rightSearchOpen: false }),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen, rightSearchOpen: s.rightOpen ? false : s.rightSearchOpen, leftOpen: s.rightOpen ? s.leftOpen : false })),
  closeAll: () => set({ leftOpen: false, rightOpen: false, rightSearchOpen: false }),

  setRightTab: (tab) => {
    writeCache(RIGHT_SIDEBAR_TAB_CACHE_KEY, tab);
    set({ rightTab: tab });
  },
  openRightSearch: () => set({ rightSearchOpen: true }),
  closeRightSearch: () => set({ rightSearchOpen: false }),
  setRightSearchOpen: (open) => set({ rightSearchOpen: open }),
  setRootPath: (path) => set((s) => {
    if (s.rootPath === path) return s;
    const projectStateCache = new Map(s.projectStateCache);
    if (s.rootPath) {
      projectStateCache.set(s.rootPath, {
        explorerRoot: s.explorerRoot,
        expandedPaths: new Set(s.expandedPaths),
        selectedFilePath: s.selectedFilePath,
        directoryCache: new Map(s.directoryCache),
        changedFiles: new Map(s.changedFiles),
        gitBundleError: s.gitBundleError,
        gitBundleLastLoadedAt: s.gitBundleLastLoadedAt,
      });
    }

    const cached = path ? projectStateCache.get(path) : undefined;
    const persistedExplorerRoot = path ? s.explorerRootCache[path] : undefined;
    return {
      rootPath: path,
      explorerRoot: cached?.explorerRoot ?? persistedExplorerRoot ?? path,
      expandedPaths: cached ? new Set(cached.expandedPaths) : new Set(),
      selectedFilePath: cached?.selectedFilePath ?? null,
      directoryCache: cached ? new Map(cached.directoryCache) : new Map(),
      changedFiles: cached ? new Map(cached.changedFiles) : new Map(),
      gitBundleLoading: false,
      gitBundleSlow: false,
      gitBundleError: cached?.gitBundleError ?? null,
      gitBundleLastLoadedAt: cached?.gitBundleLastLoadedAt ?? null,
      projectStateCache,
    };
  }),

  setExplorerRoot: (path) => set((s) => {
    if (s.explorerRoot === path) return s;
    const explorerRootCache = { ...s.explorerRootCache };
    if (s.rootPath && path) {
      explorerRootCache[s.rootPath] = path;
      writeExplorerRootCache(explorerRootCache);
    }
    return { explorerRoot: path, explorerRootCache };
  }),

  resetExplorerToProject: () => set((s) => {
    if (s.explorerRoot === s.rootPath) return s;
    const explorerRootCache = { ...s.explorerRootCache };
    if (s.rootPath) {
      explorerRootCache[s.rootPath] = s.rootPath;
      writeExplorerRootCache(explorerRootCache);
    }
    return { explorerRoot: s.rootPath, explorerRootCache };
  }),

  pinExplorerRoot: (path, kind = 'directory') => set((s) => {
    if (!s.rootPath || !path) return s;
    const pinned = s.pinnedExplorerRootsCache[s.rootPath] ?? [];
    if (pinned.some((entry) => entry.path === path)) return s;
    const pinnedExplorerRootsCache = {
      ...s.pinnedExplorerRootsCache,
      [s.rootPath]: [{ path, kind }, ...pinned].slice(0, 12),
    };
    writePinnedExplorerRootsCache(pinnedExplorerRootsCache);
    return { pinnedExplorerRootsCache };
  }),

  unpinExplorerRoot: (path) => set((s) => {
    if (!s.rootPath || !path) return s;
    const pinned = s.pinnedExplorerRootsCache[s.rootPath] ?? [];
    if (!pinned.some((entry) => entry.path === path)) return s;
    const nextPinned = pinned.filter((entry) => entry.path !== path);
    const pinnedExplorerRootsCache = { ...s.pinnedExplorerRootsCache };
    if (nextPinned.length > 0) pinnedExplorerRootsCache[s.rootPath] = nextPinned;
    else delete pinnedExplorerRootsCache[s.rootPath];
    writePinnedExplorerRootsCache(pinnedExplorerRootsCache);
    return { pinnedExplorerRootsCache };
  }),

  toggleExpanded: (path) =>
    set((s) => {
      const next = new Set(s.expandedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedPaths: next };
    }),

  selectFile: (path) => set({ selectedFilePath: path }),

  toggleShowHiddenFiles: () =>
    set((s) => {
      const show = !s.showHiddenFiles;
      writeCache(SHOW_HIDDEN_FILES_CACHE_KEY, show);
      // Hidden-file visibility is a global preference, so every project's
      // cached directory listings are now stale. Clear the active cache and
      // wipe the per-project snapshots so switching projects re-fetches with
      // the new setting instead of restoring an out-of-date tree.
      const projectStateCache = new Map(s.projectStateCache);
      for (const [key, project] of projectStateCache) {
        projectStateCache.set(key, { ...project, directoryCache: new Map() });
      }
      return { showHiddenFiles: show, directoryCache: new Map(), projectStateCache };
    }),

  toggleGroupByFolder: () =>
    set((s) => {
      const next = !s.groupByFolder;
      writeGroupByFolder(next);
      return { groupByFolder: next };
    }),

  setGroupByFolder: (enabled) =>
    set((s) => {
      if (s.groupByFolder === enabled) return s;
      writeGroupByFolder(enabled);
      return { groupByFolder: enabled };
    }),

  toggleGroupCollapsed: (key) =>
    set((s) => {
      const next = new Set(s.collapsedGroups);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsedGroups(next);
      return { collapsedGroups: next };
    }),

  setDirectoryCache: (path, entries) =>
    set((s) => {
      const next = new Map(s.directoryCache);
      next.set(path, entries);
      return { directoryCache: next };
    }),

  invalidateDirectoryCache: (path, recursive = false) =>
    set((s) => {
      const next = new Map(s.directoryCache);
      for (const key of next.keys()) {
        if (key === path || (recursive && isSameOrChildPath(path, key))) next.delete(key);
      }
      return { directoryCache: next };
    }),

  applyFileWatchEvents: (events) =>
    set((s) => {
      if (events.length === 0) return s;
      const directoryCache = new Map(s.directoryCache);
      let selectedFilePath = s.selectedFilePath;
      let changed = false;

      for (const event of events) {
        if (event.type === 'rescan-required') {
          for (const key of directoryCache.keys()) {
            if (isSameOrChildPath(event.path, key)) {
              directoryCache.delete(key);
              changed = true;
            }
          }
          continue;
        }

        const parent = getParentPath(event.path);
        const siblings = directoryCache.get(parent);

        if (event.type === 'deleted') {
          if (selectedFilePath && isSameOrChildPath(event.path, selectedFilePath)) selectedFilePath = null;
          if (siblings) {
            const filtered = siblings.filter((node) => node.path !== event.path);
            if (filtered.length !== siblings.length) {
              directoryCache.set(parent, filtered);
              changed = true;
            }
          }
          for (const key of directoryCache.keys()) {
            if (isSameOrChildPath(event.path, key)) {
              directoryCache.delete(key);
              changed = true;
            }
          }
          continue;
        }

        const node = toFileTreeNode(event);
        if (!node || !siblings) continue;
        const existing = siblings.find((entry) => entry.path === node.path);
        const nextSiblings = sortFileTreeNodes(existing
          ? siblings.map((entry) => entry.path === node.path ? { ...entry, ...node, children: entry.children } : entry)
          : [...siblings, node]);
        directoryCache.set(parent, nextSiblings);
        changed = true;
      }

      return changed ? { directoryCache, selectedFilePath } : s;
    }),

  setChangedFiles: (files) => set({ changedFiles: files }),
  setGitBundleLoading: (loading) => set({ gitBundleLoading: loading }),
  setGitBundleSlow: (slow) => set({ gitBundleSlow: slow }),
  setGitBundleError: (error) => set({ gitBundleError: error }),
  markGitBundleLoaded: () => set({ gitBundleLastLoadedAt: Date.now(), gitBundleLoading: false, gitBundleSlow: false }),
}));
