import { create } from 'zustand';
import { getSettings, updateSettings, type FileSortMode, type FileWatchEvent, type GitChangedFile } from '../terminal/api';
import { clearCache, readCache, writeCache } from '../utils/localStorageCache';

export type RightSidebarTab = 'git' | 'files' | 'diff';
export type RightSidebarLayoutPreference = 'auto' | 'narrow' | 'wide';

export const RIGHT_SIDEBAR_NARROW_THRESHOLD_PX = 600;
export const RIGHT_SIDEBAR_MIN_WIDTH_PX = 320;
export const TERMINAL_WORKSPACE_MIN_WIDTH_PX = 280;
export const PINNED_SIDEBAR_SEPARATOR_WIDTH_PX = 5;

export function clampPinnedRightSidebarWidth(
  requestedWidth: number,
  viewportWidth: number,
  pinnedLeftSidebarWidth = 0,
): number {
  const maxWidth = Math.max(
    RIGHT_SIDEBAR_MIN_WIDTH_PX,
    viewportWidth
      - Math.max(0, pinnedLeftSidebarWidth)
      - (PINNED_SIDEBAR_SEPARATOR_WIDTH_PX * (pinnedLeftSidebarWidth > 0 ? 2 : 1))
      - TERMINAL_WORKSPACE_MIN_WIDTH_PX,
  );
  return Math.min(maxWidth, Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, requestedWidth));
}

const RIGHT_SIDEBAR_TABS_BY_CONTEXT_CACHE_KEY = 'termdock:right-sidebar:tabs-by-session:v2';
const EXPLORER_ROOTS_CACHE_KEY = 'termdock:right-sidebar:explorer-roots-by-session:v2';
const PINNED_EXPLORER_ROOTS_CACHE_KEY = 'termdock:right-sidebar:pinned-explorer-roots:v1';
const SELECTED_FILE_PATHS_CACHE_KEY = 'termdock:right-sidebar:selected-files-by-session:v2';
const SHOW_HIDDEN_FILES_CACHE_KEY = 'termdock:right-sidebar:show-hidden-files:v1';
const FILE_SORT_MODES_CACHE_KEY = 'termdock:right-sidebar:file-sort-modes:v1';
// 分组开关 / 折叠状态：复用 LeftSidebar 旧 localStorage key 以保留用户已有偏好。
// 旧编码是裸 localStorage（'1' 与 JSON 数组），与 readCache 包装格式不兼容，
// 因此这里用专用 reader/writer 沿用旧格式。
const GROUP_BY_FOLDER_KEY = 'termdock-sidebar-group-by-folder';
const COLLAPSED_GROUPS_KEY = 'termdock-sidebar-collapsed-folder-groups';
const LEFT_PINNED_KEY = 'termdock-left-sidebar-pinned';
const LEFT_SIDEBAR_WIDTH_KEY = 'termdock-left-sidebar-width';
const RIGHT_PINNED_KEY = 'termdock-right-sidebar-pinned';
const RIGHT_SIDEBAR_WIDTH_KEY = 'termdock-right-sidebar-width';
const RIGHT_SIDEBAR_WIDTHS_BY_CONTEXT_CACHE_KEY = 'termdock:right-sidebar:widths-by-session:v1';
const SPLIT_SIDEBAR_STATE_INITIALIZED_CACHE_KEY = 'termdock:right-sidebar:split-state-initialized:v1';
const RIGHT_SIDEBAR_LAYOUT_PREFERENCE_KEY = 'termdock-right-sidebar-layout-preference';

export function readLeftPinnedPreference(): boolean {
  // Desktop is the multi-task surface: keep the session navigator visible on
  // first use. Mobile never renders the pinned layout, so this default does not
  // consume phone screen space. Once a user unpins, the explicit "0" wins.
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(LEFT_PINNED_KEY);
    return stored === null ? true : stored === '1';
  } catch {
    return true;
  }
}

function writeLeftPinned(pinned: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LEFT_PINNED_KEY, pinned ? '1' : '0');
  } catch { /* best-effort */ }
}

function readLeftSidebarWidth(): number {
  if (typeof window === 'undefined') return 300;
  try {
    const stored = window.localStorage.getItem(LEFT_SIDEBAR_WIDTH_KEY);
    if (!stored) return 300;
    const parsed = parseInt(stored, 10);
    return Number.isFinite(parsed) && parsed >= 200 && parsed <= 500 ? parsed : 300;
  } catch {
    return 300;
  }
}

function writeLeftSidebarWidth(width: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LEFT_SIDEBAR_WIDTH_KEY, String(width));
  } catch { /* best-effort */ }
}

function readRightPinnedPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(RIGHT_PINNED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeRightPinned(pinned: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RIGHT_PINNED_KEY, pinned ? '1' : '0');
  } catch { /* best-effort */ }
}

export function readRightSidebarWidth(): number {
  if (typeof window === 'undefined') return 760;
  try {
    const stored = window.localStorage.getItem(RIGHT_SIDEBAR_WIDTH_KEY);
    if (!stored) return 760;
    const parsed = parseInt(stored, 10);
    return Number.isFinite(parsed) && parsed >= RIGHT_SIDEBAR_MIN_WIDTH_PX ? parsed : 760;
  } catch {
    return 760;
  }
}

function writeRightSidebarWidth(width: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, String(width));
  } catch { /* best-effort */ }
}

function isRightSidebarWidthCache(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((width) => (
    typeof width === 'number'
    && Number.isFinite(width)
    && width >= RIGHT_SIDEBAR_MIN_WIDTH_PX
  ));
}

function readRightSidebarWidthCache(): Record<string, number> {
  return readCache(RIGHT_SIDEBAR_WIDTHS_BY_CONTEXT_CACHE_KEY, isRightSidebarWidthCache) ?? {};
}

function writeRightSidebarWidthForContext(contextKey: string | null, width: number): void {
  if (!contextKey) {
    writeRightSidebarWidth(width);
    return;
  }
  writeCache(RIGHT_SIDEBAR_WIDTHS_BY_CONTEXT_CACHE_KEY, {
    ...readRightSidebarWidthCache(),
    [contextKey]: width,
  });
}

export function readRightSidebarLayoutPreference(): RightSidebarLayoutPreference {
  if (typeof window === 'undefined') return 'auto';
  try {
    const stored = window.localStorage.getItem(RIGHT_SIDEBAR_LAYOUT_PREFERENCE_KEY);
    return stored === 'narrow' || stored === 'wide' ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

function writeRightSidebarLayoutPreference(preference: RightSidebarLayoutPreference): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RIGHT_SIDEBAR_LAYOUT_PREFERENCE_KEY, preference);
  } catch { /* best-effort */ }
}

export function resolveRightSidebarNarrowLayout(
  drawerWidthPx: number,
  pinned: boolean,
  preference: RightSidebarLayoutPreference,
): boolean {
  if (!pinned || preference === 'auto') {
    return drawerWidthPx < RIGHT_SIDEBAR_NARROW_THRESHOLD_PX;
  }
  return preference === 'narrow';
}

function readGroupByFolder(): boolean {
  return true;
}

function writeGroupByFolder(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(GROUP_BY_FOLDER_KEY, "1");
    else window.localStorage.setItem(GROUP_BY_FOLDER_KEY, "0");
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
  rightTab: RightSidebarTab;
  explorerRoot: string | null;
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  directoryCache: Map<string, FileTreeNode[]>;
  changedFiles: Map<string, GitChangedFile>;
  gitBundleError: string | null;
  gitBundleLastLoadedAt: number | null;
  gitBundleCacheInfo?: { cached?: boolean; stale?: boolean; cacheAgeMs?: number; nestedDeferred?: boolean; untrackedDeferred?: boolean } | null;
}

function isRightSidebarTab(value: unknown): value is RightSidebarTab {
  return value === 'git' || value === 'files' || value === 'diff';
}

function isRightSidebarTabCache(value: unknown): value is Record<string, RightSidebarTab> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isRightSidebarTab);
}

function readRightSidebarTabCache(): Record<string, RightSidebarTab> {
  return readCache(RIGHT_SIDEBAR_TABS_BY_CONTEXT_CACHE_KEY, isRightSidebarTabCache) ?? {};
}

function writeRightSidebarTab(contextKey: string | null, tab: RightSidebarTab): void {
  if (!contextKey) return;
  writeCache(RIGHT_SIDEBAR_TABS_BY_CONTEXT_CACHE_KEY, {
    ...readRightSidebarTabCache(),
    [contextKey]: tab,
  });
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

function isSelectedFilePathCache(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
}

function readSelectedFilePathCache(): Record<string, string> {
  return readCache(SELECTED_FILE_PATHS_CACHE_KEY, isSelectedFilePathCache) ?? {};
}

function writeSelectedFilePath(contextKey: string | null, path: string | null): void {
  if (!contextKey) return;
  const cache = { ...readSelectedFilePathCache() };
  if (path) cache[contextKey] = path;
  else delete cache[contextKey];
  writeCache(SELECTED_FILE_PATHS_CACHE_KEY, cache);
}

function getSidebarContextKey(sessionId: string | null, rootPath: string | null): string | null {
  if (!rootPath) return null;
  return sessionId ? `${sessionId}\u0000${rootPath}` : rootPath;
}

function getRightSidebarWidthContextKey(
  sessionId: string | null,
  rootPath: string | null,
  splitWorkspaceId: string | null,
): string | null {
  return splitWorkspaceId
    ? `split-workspace\u0000${splitWorkspaceId}`
    : getSidebarContextKey(sessionId, rootPath);
}

function readInitializedSplitSidebarStates(): Set<string> {
  const stored = readCache(SPLIT_SIDEBAR_STATE_INITIALIZED_CACHE_KEY, (value): value is string[] => (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  ));
  return new Set(stored ?? []);
}

function markSplitSidebarStateInitialized(splitWorkspaceId: string): void {
  const initialized = readInitializedSplitSidebarStates();
  if (initialized.has(splitWorkspaceId)) return;
  initialized.add(splitWorkspaceId);
  writeCache(SPLIT_SIDEBAR_STATE_INITIALIZED_CACHE_KEY, [...initialized]);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function getInitialShowHiddenFiles(): boolean {
  return readCache(SHOW_HIDDEN_FILES_CACHE_KEY, isBoolean) ?? false;
}

function isFileSortModes(value: unknown): value is Record<string, FileSortMode> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((mode) => mode === 'modified');
}

function getInitialFileSortModes(): Record<string, FileSortMode> {
  return readCache(FILE_SORT_MODES_CACHE_KEY, isFileSortModes) ?? {};
}

let fileSortModesHydration: Promise<void> | null = null;
const fileSortModeSaveSequences = new Map<string, number>();
let pinnedExplorerRootsHydration: Promise<void> | null = null;
const pinnedExplorerRootsOrigin = globalThis.crypto?.randomUUID?.() ?? `pins-${Math.random().toString(36).slice(2)}`;

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  isSymlink?: boolean;
  modified?: string;
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

function sortFileTreeNodes(nodes: FileTreeNode[], sortMode: FileSortMode = 'name'): FileTreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    if (sortMode === 'modified') {
      const modifiedDelta = Date.parse(b.modified ?? '') - Date.parse(a.modified ?? '');
      if (Number.isFinite(modifiedDelta) && modifiedDelta !== 0) return modifiedDelta;
    }
    return a.name.localeCompare(b.name);
  });
}

function toFileTreeNode(event: FileWatchEvent): FileTreeNode | null {
  if (!event.entry) return null;
  return {
    name: event.entry.name,
    path: event.entry.path,
    type: event.entry.type,
    isSymlink: event.entry.isSymlink,
    modified: event.entry.modified,
    expanded: false,
    loaded: false,
    children: event.entry.type === 'directory' ? [] : undefined,
  };
}

interface SidebarState {
  // Sidebar visibility
  leftOpen: boolean;
  rightOpen: boolean;

  // Left sidebar pinned mode (desktop inline layout)
  leftPinned: boolean;
  leftSidebarWidth: number;
  rightPinned: boolean;
  rightSidebarWidth: number;
  rightSidebarLayoutPreference: RightSidebarLayoutPreference;

  // Right sidebar tab
  rightTab: RightSidebarTab;

  // Whether the right sidebar search box is open. Lifted out of the component
  // so global keyboard shortcuts can open + focus it.
  rightSearchOpen: boolean;

  // File tree state
  rootPath: string | null;
  contextKey: string | null;
  rightSidebarWidthContextKey: string | null;
  explorerRoot: string | null;
  explorerRootCache: Record<string, string>;
  pinnedExplorerRootsCache: Record<string, PinnedExplorerEntry[]>;
  pinnedExplorerRootsHydrated: boolean;
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  directoryCache: Map<string, FileTreeNode[]>;
  fileSortModes: Record<string, FileSortMode>;
  fileSortModesHydrated: boolean;

  // Whether dotfiles / hidden entries are shown in the file explorer.
  showHiddenFiles: boolean;

  // 会话分组（按 cwd）：顶栏 tab 与左侧边栏共享同一份状态。
  groupByFolder: boolean;
  collapsedGroups: Set<string>;

  // Changed files (from git status/diff)
  changedFiles: Map<string, GitChangedFile>;

  // 每个绝对路径的"外部变更版本号"。watcher 收到 created / updated / deleted
  // 事件时自增对应路径的版本号，FilePreview / MarkdownImage 等订阅者据此
  // 静默重新加载（文件管理器是纯查看场景，没有覆盖用户编辑的冲突顾虑）。
  fileChangeVersions: Map<string, number>;

  // 全局 watch 纪元。任何「可能丢了事件」的场景都 bump 它：rescan-required
  // 降级、watch 流断线重连、手动刷新。订阅者把 epoch 加进版本号后，这些
  // 场景下所有已加载内容（含 md 引用图）都会刷新，而不是只有选中文件。
  fileWatchEpoch: number;

  // Git bundle loading state (for right sidebar UX)
  gitBundleLoading: boolean;
  gitBundleSlow: boolean;
  gitBundleLoadingOwner: string | null;
  gitBundleError: string | null;
  gitBundleLastLoadedAt: number | null;
  gitBundleCacheInfo: { cached?: boolean; stale?: boolean; cacheAgeMs?: number; nestedDeferred?: boolean; untrackedDeferred?: boolean } | null;
  projectStateCache: Map<string, ProjectSidebarState>;

  // Actions
  openLeft: () => void;
  closeLeft: () => void;
  toggleLeft: () => void;
  toggleLeftPinned: () => void;
  setLeftPinned: (pinned: boolean) => void;
  setLeftSidebarWidth: (width: number) => void;
  toggleRightPinned: () => void;
  setRightPinned: (pinned: boolean) => void;
  setRightSidebarWidth: (width: number) => void;
  setRightSidebarLayoutPreference: (preference: RightSidebarLayoutPreference) => void;
  openRight: () => void;
  closeRight: () => void;
  toggleRight: () => void;
  closeAll: () => void;
  setRightTab: (tab: RightSidebarTab) => void;
  openRightSearch: () => void;
  closeRightSearch: () => void;
  setRightSearchOpen: (open: boolean) => void;
  setRootPath: (
    path: string | null,
    sessionId?: string | null,
    splitWorkspaceId?: string | null,
  ) => void;
  inheritRightSidebarStateFromSplitWorkspace: (
    splitWorkspaceId: string,
    sessions: Array<{ sessionId: string; rootPath: string | null }>,
  ) => void;
  setExplorerRoot: (path: string | null) => void;
  resetExplorerToProject: () => void;
  pinExplorerRoot: (path: string, kind?: PinnedEntryKind) => void;
  unpinExplorerRoot: (path: string) => void;
  hydratePinnedExplorerRoots: () => Promise<void>;
  syncPinnedExplorerRoots: (cache: Record<string, PinnedExplorerEntry[]>) => void;
  toggleExpanded: (path: string) => void;
  selectFile: (path: string | null) => void;
  toggleShowHiddenFiles: () => void;
  toggleGroupByFolder: () => void;
  setGroupByFolder: (enabled: boolean) => void;
  toggleGroupCollapsed: (key: string) => void;
  setDirectoryCache: (path: string, entries: FileTreeNode[]) => void;
  hydrateFileSortModes: () => Promise<void>;
  setDirectorySortMode: (path: string, mode: FileSortMode) => Promise<void>;
  invalidateDirectoryCache: (path: string, recursive?: boolean) => void;
  applyFileWatchEvents: (events: FileWatchEvent[]) => void;
  bumpFileWatchEpoch: () => void;
  setChangedFiles: (files: Map<string, GitChangedFile>) => void;
  beginGitBundleLoading: (owner: string) => void;
  setGitBundleSlowFor: (owner: string, slow: boolean) => void;
  finishGitBundleLoading: (owner: string) => void;
  resetGitBundleLoading: () => void;
  setGitBundleError: (error: string | null) => void;
  markGitBundleLoaded: (info?: { cached?: boolean; stale?: boolean; cacheAgeMs?: number; nestedDeferred?: boolean; untrackedDeferred?: boolean } | null) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  leftOpen: false,
  rightOpen: false,
  leftPinned: readLeftPinnedPreference(),
  leftSidebarWidth: readLeftSidebarWidth(),
  rightPinned: readRightPinnedPreference(),
  rightSidebarWidth: readRightSidebarWidth(),
  rightSidebarLayoutPreference: readRightSidebarLayoutPreference(),
  rightTab: 'files',
  rightSearchOpen: false,
  rootPath: null,
  contextKey: null,
  rightSidebarWidthContextKey: null,
  explorerRoot: null,
  explorerRootCache: readExplorerRootCache(),
  pinnedExplorerRootsCache: readPinnedExplorerRootsCache(),
  pinnedExplorerRootsHydrated: false,
  expandedPaths: new Set(),
  selectedFilePath: null,
  directoryCache: new Map(),
  fileSortModes: getInitialFileSortModes(),
  fileSortModesHydrated: false,
  showHiddenFiles: getInitialShowHiddenFiles(),
  groupByFolder: readGroupByFolder(),
  collapsedGroups: readCollapsedGroups(),
  changedFiles: new Map(),
  fileChangeVersions: new Map(),
  fileWatchEpoch: 0,
  gitBundleLoading: false,
  gitBundleSlow: false,
  gitBundleLoadingOwner: null,
  gitBundleError: null,
  gitBundleLastLoadedAt: null,
  gitBundleCacheInfo: null,
  projectStateCache: new Map(),

  openLeft: () => set({ leftOpen: true }),
  closeLeft: () => set({ leftOpen: false }),
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen, rightOpen: s.leftOpen ? s.rightOpen : false })),
  toggleLeftPinned: () =>
    set((s) => {
      const next = !s.leftPinned;
      writeLeftPinned(next);
      return { leftPinned: next, leftOpen: true };
    }),
  setLeftPinned: (pinned) =>
    set(() => {
      writeLeftPinned(pinned);
      return { leftPinned: pinned };
    }),
  setLeftSidebarWidth: (width) =>
    set((s) => {
      const clamped = Math.min(Math.max(width, 200), 500);
      if (s.leftSidebarWidth === clamped) return s;
      writeLeftSidebarWidth(clamped);
      return { leftSidebarWidth: clamped };
    }),
  toggleRightPinned: () =>
    set((s) => {
      const next = !s.rightPinned;
      writeRightPinned(next);
      return { rightPinned: next, rightOpen: true };
    }),
  setRightPinned: (pinned) =>
    set(() => {
      writeRightPinned(pinned);
      return { rightPinned: pinned };
    }),
  setRightSidebarWidth: (width) =>
    set((s) => {
      const clamped = Math.max(width, RIGHT_SIDEBAR_MIN_WIDTH_PX);
      if (s.rightSidebarWidth === clamped) return s;
      writeRightSidebarWidthForContext(s.rightSidebarWidthContextKey, clamped);
      return { rightSidebarWidth: clamped };
    }),
  setRightSidebarLayoutPreference: (preference) =>
    set((s) => {
      if (s.rightSidebarLayoutPreference === preference) return s;
      writeRightSidebarLayoutPreference(preference);
      return { rightSidebarLayoutPreference: preference };
    }),
  openRight: () => set({ rightOpen: true }),
  closeRight: () => set({ rightOpen: false, rightSearchOpen: false }),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen, rightSearchOpen: s.rightOpen ? false : s.rightSearchOpen, leftOpen: s.rightOpen ? s.leftOpen : false })),
  closeAll: () => set({ leftOpen: false, rightOpen: false, rightSearchOpen: false }),

  setRightTab: (tab) => set((s) => {
    writeRightSidebarTab(s.contextKey, tab);
    return { rightTab: tab };
  }),
  openRightSearch: () => set({ rightSearchOpen: true }),
  closeRightSearch: () => set({ rightSearchOpen: false }),
  setRightSearchOpen: (open) => set({ rightSearchOpen: open }),
  setRootPath: (path, sessionId = null, splitWorkspaceId = null) => set((s) => {
    const sessionContextKey = getSidebarContextKey(sessionId, path);
    const rightSidebarWidthContextKey = getRightSidebarWidthContextKey(
      sessionId,
      path,
      splitWorkspaceId,
    );
    const contextKey = splitWorkspaceId
      ? rightSidebarWidthContextKey
      : sessionContextKey;
    if (
      s.contextKey === contextKey
      && s.rightSidebarWidthContextKey === rightSidebarWidthContextKey
    ) return path === s.rootPath ? s : { rootPath: path };
    const projectStateCache = new Map(s.projectStateCache);
    if (s.contextKey) {
      projectStateCache.set(s.contextKey, {
        rightTab: s.rightTab,
        explorerRoot: s.explorerRoot,
        expandedPaths: new Set(s.expandedPaths),
        selectedFilePath: s.selectedFilePath,
        directoryCache: new Map(s.directoryCache),
        changedFiles: new Map(s.changedFiles),
        gitBundleError: s.gitBundleError,
        gitBundleLastLoadedAt: s.gitBundleLastLoadedAt,
        gitBundleCacheInfo: s.gitBundleCacheInfo,
      });
    }

    const splitStateInitialized = splitWorkspaceId
      ? readInitializedSplitSidebarStates().has(splitWorkspaceId)
      : false;
    let explorerRootCache = {
      ...readExplorerRootCache(),
      ...s.explorerRootCache,
    };
    const shouldInheritSessionState = !!splitWorkspaceId && !splitStateInitialized;
    const sourceState = shouldInheritSessionState && sessionContextKey
      ? (s.contextKey === sessionContextKey
        ? {
            rightTab: s.rightTab,
            explorerRoot: s.explorerRoot,
            expandedPaths: new Set(s.expandedPaths),
            selectedFilePath: s.selectedFilePath,
            directoryCache: new Map(s.directoryCache),
            changedFiles: new Map(s.changedFiles),
            gitBundleError: s.gitBundleError,
            gitBundleLastLoadedAt: s.gitBundleLastLoadedAt,
            gitBundleCacheInfo: s.gitBundleCacheInfo,
          }
        : projectStateCache.get(sessionContextKey))
      : undefined;
    if (shouldInheritSessionState && splitWorkspaceId) {
      const inheritedRightTab = sourceState?.rightTab
        ?? (sessionContextKey ? readRightSidebarTabCache()[sessionContextKey] : undefined)
        ?? 'files';
      const inheritedExplorerRoot = sourceState?.explorerRoot
        ?? (sessionContextKey ? s.explorerRootCache[sessionContextKey] : undefined)
        ?? path;
      const inheritedSelectedFilePath = sourceState?.selectedFilePath
        ?? (sessionContextKey ? readSelectedFilePathCache()[sessionContextKey] : undefined)
        ?? null;
      const inheritedState: ProjectSidebarState = {
        rightTab: inheritedRightTab,
        explorerRoot: inheritedExplorerRoot,
        expandedPaths: new Set(sourceState?.expandedPaths ?? []),
        selectedFilePath: inheritedSelectedFilePath,
        directoryCache: new Map(sourceState?.directoryCache ?? []),
        changedFiles: new Map(sourceState?.changedFiles ?? []),
        gitBundleError: sourceState?.gitBundleError ?? null,
        gitBundleLastLoadedAt: sourceState?.gitBundleLastLoadedAt ?? null,
        gitBundleCacheInfo: sourceState?.gitBundleCacheInfo ?? null,
      };
      if (contextKey) {
        projectStateCache.set(contextKey, inheritedState);
        writeRightSidebarTab(contextKey, inheritedRightTab);
        writeSelectedFilePath(contextKey, inheritedSelectedFilePath);
        if (inheritedExplorerRoot) {
          explorerRootCache = { ...explorerRootCache, [contextKey]: inheritedExplorerRoot };
          writeExplorerRootCache(explorerRootCache);
        }
      }
      markSplitSidebarStateInitialized(splitWorkspaceId);
    }

    const cached = contextKey ? projectStateCache.get(contextKey) : undefined;
    const persistedRightTab = contextKey ? readRightSidebarTabCache()[contextKey] : undefined;
    const widthCache = readRightSidebarWidthCache();
    let persistedRightSidebarWidth = rightSidebarWidthContextKey
      ? widthCache[rightSidebarWidthContextKey]
      : undefined;
    if (splitWorkspaceId && rightSidebarWidthContextKey && persistedRightSidebarWidth === undefined) {
      persistedRightSidebarWidth = (sessionContextKey ? widthCache[sessionContextKey] : undefined)
        ?? readRightSidebarWidth();
      writeRightSidebarWidthForContext(rightSidebarWidthContextKey, persistedRightSidebarWidth);
    }
    const persistedExplorerRoot = contextKey ? explorerRootCache[contextKey] : undefined;
    const persistedSelectedFilePath = contextKey ? readSelectedFilePathCache()[contextKey] : undefined;
    return {
      rootPath: path,
      contextKey,
      rightSidebarWidthContextKey,
      rightSidebarWidth: persistedRightSidebarWidth ?? readRightSidebarWidth(),
      rightTab: cached?.rightTab ?? persistedRightTab ?? 'files',
      explorerRoot: cached?.explorerRoot ?? persistedExplorerRoot ?? path,
      expandedPaths: cached ? new Set(cached.expandedPaths) : new Set(),
      selectedFilePath: cached?.selectedFilePath ?? persistedSelectedFilePath ?? null,
      explorerRootCache,
      directoryCache: cached ? new Map(cached.directoryCache) : new Map(),
      changedFiles: cached ? new Map(cached.changedFiles) : new Map(),
      gitBundleLoading: false,
      gitBundleSlow: false,
      gitBundleLoadingOwner: null,
      gitBundleError: cached?.gitBundleError ?? null,
      gitBundleLastLoadedAt: cached?.gitBundleLastLoadedAt ?? null,
      gitBundleCacheInfo: cached?.gitBundleCacheInfo ?? null,
      projectStateCache,
    };
  }),

  inheritRightSidebarStateFromSplitWorkspace: (splitWorkspaceId, sessions) => set((state) => {
    if (!splitWorkspaceId || sessions.length === 0) return state;
    const widthCache = readRightSidebarWidthCache();
    const splitContextKey = getRightSidebarWidthContextKey(null, null, splitWorkspaceId);
    if (!splitContextKey) return state;
    const splitWidth = widthCache[splitContextKey]
      ?? (state.rightSidebarWidthContextKey === splitContextKey
        ? state.rightSidebarWidth
        : undefined);
    const splitState = state.contextKey === splitContextKey
      ? {
          rightTab: state.rightTab,
          explorerRoot: state.explorerRoot,
          expandedPaths: new Set(state.expandedPaths),
          selectedFilePath: state.selectedFilePath,
          directoryCache: new Map(state.directoryCache),
          changedFiles: new Map(state.changedFiles),
          gitBundleError: state.gitBundleError,
          gitBundleLastLoadedAt: state.gitBundleLastLoadedAt,
          gitBundleCacheInfo: state.gitBundleCacheInfo,
        }
      : state.projectStateCache.get(splitContextKey);
    if (splitWidth === undefined && !splitState) return state;

    const nextWidthCache = { ...widthCache };
    const projectStateCache = new Map(state.projectStateCache);
    const explorerRootCache = { ...state.explorerRootCache };
    for (const session of sessions) {
      const sessionContextKey = getSidebarContextKey(session.sessionId, session.rootPath);
      if (!sessionContextKey) continue;
      if (splitWidth !== undefined) nextWidthCache[sessionContextKey] = splitWidth;
      if (splitState) {
        projectStateCache.set(sessionContextKey, {
          ...splitState,
          expandedPaths: new Set(splitState.expandedPaths),
          directoryCache: new Map(splitState.directoryCache),
          changedFiles: new Map(splitState.changedFiles),
        });
        writeRightSidebarTab(sessionContextKey, splitState.rightTab);
        writeSelectedFilePath(sessionContextKey, splitState.selectedFilePath);
        if (splitState.explorerRoot) explorerRootCache[sessionContextKey] = splitState.explorerRoot;
        else delete explorerRootCache[sessionContextKey];
      }
    }
    if (splitWidth !== undefined) {
      writeCache(RIGHT_SIDEBAR_WIDTHS_BY_CONTEXT_CACHE_KEY, nextWidthCache);
    }
    if (splitState) writeExplorerRootCache(explorerRootCache);
    return { projectStateCache, explorerRootCache };
  }),

  setExplorerRoot: (path) => set((s) => {
    if (s.explorerRoot === path) return s;
    const explorerRootCache = { ...s.explorerRootCache };
    if (s.contextKey && path) {
      explorerRootCache[s.contextKey] = path;
      writeExplorerRootCache(explorerRootCache);
    }
    return { explorerRoot: path, explorerRootCache };
  }),

  resetExplorerToProject: () => set((s) => {
    if (s.explorerRoot === s.rootPath) return s;
    const explorerRootCache = { ...s.explorerRootCache };
    if (s.contextKey && s.rootPath) {
      explorerRootCache[s.contextKey] = s.rootPath;
      writeExplorerRootCache(explorerRootCache);
    }
    return { explorerRoot: s.rootPath, explorerRootCache };
  }),

  pinExplorerRoot: (path, kind = 'directory') => set((s) => {
    if (!s.rootPath || !path) return s;
    const rootPath = s.rootPath;
    const pinned = s.pinnedExplorerRootsCache[s.rootPath] ?? [];
    if (pinned.some((entry) => entry.path === path)) return s;
    const pinnedExplorerRootsCache = {
      ...s.pinnedExplorerRootsCache,
      [s.rootPath]: [{ path, kind }, ...pinned].slice(0, 12),
    };
    writePinnedExplorerRootsCache(pinnedExplorerRootsCache);
    void (async () => {
      try {
        await useSidebarStore.getState().hydratePinnedExplorerRoots();
        const settings = await updateSettings({
          pinnedExplorerRoot: { rootPath, path, kind, pinned: true },
          pinnedExplorerRootsOrigin,
        });
        useSidebarStore.getState().syncPinnedExplorerRoots(settings.pinnedExplorerRoots ?? {});
      } catch { /* local cache remains as an offline fallback */ }
    })();
    return { pinnedExplorerRootsCache };
  }),

  unpinExplorerRoot: (path) => set((s) => {
    if (!s.rootPath || !path) return s;
    const rootPath = s.rootPath;
    const pinned = s.pinnedExplorerRootsCache[s.rootPath] ?? [];
    const removed = pinned.find((entry) => entry.path === path);
    if (!pinned.some((entry) => entry.path === path)) return s;
    const nextPinned = pinned.filter((entry) => entry.path !== path);
    const pinnedExplorerRootsCache = { ...s.pinnedExplorerRootsCache };
    if (nextPinned.length > 0) pinnedExplorerRootsCache[s.rootPath] = nextPinned;
    else delete pinnedExplorerRootsCache[s.rootPath];
    writePinnedExplorerRootsCache(pinnedExplorerRootsCache);
    void (async () => {
      try {
        await useSidebarStore.getState().hydratePinnedExplorerRoots();
        const settings = await updateSettings({
          pinnedExplorerRoot: { rootPath, path, kind: removed?.kind ?? 'directory', pinned: false },
          pinnedExplorerRootsOrigin,
        });
        useSidebarStore.getState().syncPinnedExplorerRoots(settings.pinnedExplorerRoots ?? {});
      } catch { /* local cache remains as an offline fallback */ }
    })();
    return { pinnedExplorerRootsCache };
  }),

  hydratePinnedExplorerRoots: async () => {
    if (useSidebarStore.getState().pinnedExplorerRootsHydrated) return;
    if (pinnedExplorerRootsHydration) return pinnedExplorerRootsHydration;
    pinnedExplorerRootsHydration = (async () => {
      const localRoots = useSidebarStore.getState().pinnedExplorerRootsCache;
      const settings = await getSettings();
      let serverRoots = settings.pinnedExplorerRoots ?? {};
      if (Object.keys(serverRoots).length === 0 && Object.keys(localRoots).length > 0) {
        const migrated = await updateSettings({
          pinnedExplorerRoots: localRoots,
          pinnedExplorerRootsOrigin,
        });
        serverRoots = migrated.pinnedExplorerRoots ?? localRoots;
      }
      useSidebarStore.getState().syncPinnedExplorerRoots(serverRoots);
    })().finally(() => {
      pinnedExplorerRootsHydration = null;
    });
    return pinnedExplorerRootsHydration;
  },

  syncPinnedExplorerRoots: (cache) => set(() => {
    const pinnedExplorerRootsCache: Record<string, PinnedExplorerEntry[]> = {};
    for (const [rootPath, entries] of Object.entries(cache)) {
      const normalized = normalizePinnedEntries(entries);
      if (normalized.length > 0) pinnedExplorerRootsCache[rootPath] = normalized.slice(0, 12);
    }
    clearCache(PINNED_EXPLORER_ROOTS_CACHE_KEY);
    return { pinnedExplorerRootsCache, pinnedExplorerRootsHydrated: true };
  }),

  toggleExpanded: (path) =>
    set((s) => {
      const next = new Set(s.expandedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedPaths: next };
    }),

  selectFile: (path) => set((s) => {
    writeSelectedFilePath(s.contextKey, path);
    return { selectedFilePath: path };
  }),

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

  hydrateFileSortModes: async () => {
    if (useSidebarStore.getState().fileSortModesHydrated) return;
    if (fileSortModesHydration) return fileSortModesHydration;
    fileSortModesHydration = (async () => {
      const localModes = useSidebarStore.getState().fileSortModes;
      const settings = await getSettings();
      let serverModes: Record<string, FileSortMode> = settings.fileSortModes ?? {};
      if (Object.keys(serverModes).length === 0 && Object.keys(localModes).length > 0) {
        const migrated = await updateSettings({ fileSortModes: localModes });
        serverModes = migrated.fileSortModes ?? localModes;
      }
      clearCache(FILE_SORT_MODES_CACHE_KEY);
      set({
        fileSortModes: serverModes,
        fileSortModesHydrated: true,
        directoryCache: new Map(),
      });
    })().finally(() => {
      fileSortModesHydration = null;
    });
    return fileSortModesHydration;
  },

  setDirectorySortMode: async (path, mode) => {
    try {
      await useSidebarStore.getState().hydrateFileSortModes();
    } catch {
      // A settings read failure should not make the local explorer unusable;
      // the write below still gets a chance to persist the explicit choice.
    }
    const previousMode = useSidebarStore.getState().fileSortModes[path] ?? 'name';
    const sequence = (fileSortModeSaveSequences.get(path) ?? 0) + 1;
    fileSortModeSaveSequences.set(path, sequence);
    set((s) => {
      const fileSortModes = { ...s.fileSortModes };
      if (mode === 'modified') fileSortModes[path] = mode;
      else delete fileSortModes[path];
      const directoryCache = new Map(s.directoryCache);
      directoryCache.delete(path);
      return { fileSortModes, fileSortModesHydrated: true, directoryCache };
    });
    try {
      await updateSettings({ fileSortMode: { path, mode } });
      clearCache(FILE_SORT_MODES_CACHE_KEY);
    } catch {
      if (fileSortModeSaveSequences.get(path) !== sequence) return;
      set((s) => {
        const fileSortModes = { ...s.fileSortModes };
        if (previousMode === 'modified') fileSortModes[path] = previousMode;
        else delete fileSortModes[path];
        const directoryCache = new Map(s.directoryCache);
        directoryCache.delete(path);
        return { fileSortModes, directoryCache };
      });
    }
  },

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
      const fileChangeVersions = new Map(s.fileChangeVersions);
      let selectedFilePath = s.selectedFilePath;
      let changed = false;
      let versionsChanged = false;
      let epochChanged = false;

      const bumpVersion = (path: string) => {
        fileChangeVersions.set(path, (fileChangeVersions.get(path) ?? 0) + 1);
        versionsChanged = true;
      };

      for (const event of events) {
        if (event.type === 'rescan-required') {
          for (const key of directoryCache.keys()) {
            if (isSameOrChildPath(event.path, key)) {
              directoryCache.delete(key);
              changed = true;
            }
          }
          // rescan 表示该范围内可能有任意变更（事件风暴 / watcher 出错降级），
          // 具体哪些文件变了无从得知。bump 全局 epoch，让所有把 epoch 计入
          // 版本号的订阅者（md 引用图、lightbox、文件预览）统一刷新；选中
          // 文件仍单独 bump 一份，兼容只按路径订阅的旧用法。
          epochChanged = true;
          if (selectedFilePath && isSameOrChildPath(event.path, selectedFilePath)) {
            bumpVersion(selectedFilePath);
          }
          continue;
        }

        const parent = getParentPath(event.path);
        const siblings = directoryCache.get(parent);

        if (event.type === 'deleted') {
          bumpVersion(event.path);
          if (selectedFilePath && isSameOrChildPath(event.path, selectedFilePath)) {
            selectedFilePath = null;
            writeSelectedFilePath(s.rootPath, null);
          }
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

        // created / updated
        bumpVersion(event.path);

        const node = toFileTreeNode(event);
        if (!node || !siblings) continue;
        const existing = siblings.find((entry) => entry.path === node.path);
        const nextSiblings = sortFileTreeNodes(existing
          ? siblings.map((entry) => entry.path === node.path ? { ...entry, ...node, children: entry.children } : entry)
          : [...siblings, node], s.fileSortModes[parent] ?? 'name');
        directoryCache.set(parent, nextSiblings);
        changed = true;
      }

      if (!changed && !versionsChanged && !epochChanged) return s;
      return {
        directoryCache: changed ? directoryCache : s.directoryCache,
        selectedFilePath,
        fileChangeVersions: versionsChanged ? fileChangeVersions : s.fileChangeVersions,
        fileWatchEpoch: epochChanged ? s.fileWatchEpoch + 1 : s.fileWatchEpoch,
      };
    }),

  bumpFileWatchEpoch: () => set((s) => ({ fileWatchEpoch: s.fileWatchEpoch + 1 })),

  setChangedFiles: (files) => set({ changedFiles: files }),
  beginGitBundleLoading: (owner) => set({ gitBundleLoading: true, gitBundleSlow: false, gitBundleLoadingOwner: owner }),
  setGitBundleSlowFor: (owner, slow) => set((s) => (
    s.gitBundleLoadingOwner === owner ? { gitBundleSlow: slow } : s
  )),
  finishGitBundleLoading: (owner) => set((s) => (
    s.gitBundleLoadingOwner === owner
      ? { gitBundleLoading: false, gitBundleSlow: false, gitBundleLoadingOwner: null }
      : s
  )),
  resetGitBundleLoading: () => set({ gitBundleLoading: false, gitBundleSlow: false, gitBundleLoadingOwner: null }),
  setGitBundleError: (error) => set({ gitBundleError: error }),
  markGitBundleLoaded: (info = null) => set({ gitBundleLastLoadedAt: Date.now(), gitBundleCacheInfo: info }),
}));
