import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight as RiChevronRight,
  ChevronDown as RiChevronDown,
  Folder as RiFolder,
  FolderOpen as RiFolderOpen,
  File as RiFile,
  FileCode as RiFileCode,
  Box as RiBox,
  Video as RiVideo,
  Loader2 as RiLoader,
  Pin as RiPin,
  PinOff as RiPinOff,
  MoreHorizontal as RiMoreHorizontal,
  Link2 as RiLink,
  Download as RiDownload,
  Check as RiCheck,
  Trash2 as RiTrash,
  Clock3 as RiClock,
  ArrowDownAZ as RiSortName,
  FolderSearch as RiFolderSearch,
} from 'lucide-react';
import { useSidebarStore, type FileTreeNode } from '../../stores/useSidebarStore';
import { cancelIoSlot, listDirectory, searchFilesStream, downloadFile, deleteFile, isPreviewableModel3dPath, isPreviewableVideoPath, type FileEntry, type FileSearchEngine, type FileContentSearchEntry, type FileSearchMode, type FileSearchOptions } from '../../terminal/api';
import { useI18n } from '../../i18n';
import { useReferenceLongPressCopy } from './referenceLongPress';

interface FileTreeProps {
  rootPath: string;
  onFileSelect: (path: string) => void;
  /** Reuses the explorer tree as a directory picker without exposing file actions. */
  directoriesOnly?: boolean;
  onPathReference?: (path: string, key?: string) => void;
  getReferenceText?: (path: string) => string;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  onDirectoryRoot?: (path: string) => void;
  onSearchFromDirectory?: (path: string) => void;
  onDirectoryPinToggle?: (path: string) => void;
  onFilePinToggle?: (path: string) => void;
  onOpenInFileBrowser?: (path: string) => void;
  canOpenInFileBrowser?: boolean;
  pinnedPaths?: Set<string>;
  selectedFilePath: string | null;
  query?: string;
  searchRootPath?: string;
  searchOptions?: FileSearchOptions;
  searchMode?: FileSearchMode;
  onContentMatchSelect?: (path: string, line: number) => void;
  onDirectoryDropFiles?: (path: string, files: File[]) => void;
  revealDirectory?: { path: string; nonce: number } | null;
}

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt', '.sh', '.css', '.scss', '.html', '.json', '.yaml', '.yml', '.toml', '.md']);
const SEARCH_INITIAL_VISIBLE = 120;
const SEARCH_LOAD_MORE_STEP = 120;
const EMPTY_PINNED_PATHS = new Set<string>();
const EMPTY_EXCLUDE_PATTERNS: string[] = [];

const CHANGE_STYLES: Record<string, { label: string; className: string; title: string }> = {
  added: { label: 'A', className: 'text-[color:var(--diff-insert-strong)]', title: 'Added' },
  modified: { label: 'M', className: 'text-[color:var(--diff-hunk-accent)]', title: 'Modified' },
  deleted: { label: 'D', className: 'text-[color:var(--diff-delete-strong)]', title: 'Deleted' },
  renamed: { label: 'R', className: 'text-muted-foreground', title: 'Renamed' },
  copied: { label: 'C', className: 'text-[color:var(--diff-insert-strong)]', title: 'Copied' },
  untracked: { label: 'U', className: 'text-[color:var(--diff-insert-strong)]', title: 'Untracked (new file)' },
  conflicted: { label: '!', className: 'text-destructive', title: 'Conflicted' },
  unknown: { label: '?', className: 'text-muted-foreground', title: 'Unknown' },
};

function getFileIcon(name: string, type: 'file' | 'directory' | 'symlink') {
  if (type === 'directory') return null; // handled separately
  if (isPreviewableModel3dPath(name)) return <RiBox size={14} />;
  if (isPreviewableVideoPath(name)) return <RiVideo size={14} />;
  const ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')) : '';
  return CODE_EXTS.has(ext) ? <RiFileCode size={14} /> : <RiFile size={14} />;
}

function ChangeBadge({ path }: { path: string }) {
  // 精确订阅：只关心这一条 path 的状态字符串。
  // 其他 path 变化不会触发本组件 re-render。
  const file = useSidebarStore((s) => s.changedFiles.get(path));
  const status = file?.status;
  if (!status) return null;
  const style = CHANGE_STYLES[status] ?? { label: '?', className: 'text-muted-foreground', title: status };
  return (
    <span
      className={`w-4 shrink-0 text-center text-[10px] font-mono font-bold ${style.className}`}
      title={style.title}
    >
      {style.label}
    </span>
  );
}

function iconActionVisibilityClass(visible: boolean): string {
  if (visible) return 'ml-1 w-6 opacity-100';
  return 'ml-1 w-6 opacity-100 sm:ml-0 sm:w-0 sm:overflow-hidden sm:opacity-0 sm:group-hover:ml-1 sm:group-hover:w-6 sm:group-hover:opacity-100';
}

function textActionVisibilityClass(visible: boolean): string {
  return iconActionVisibilityClass(visible);
}

const FileDownloadAction = memo(function FileDownloadAction({ path }: { path: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'idle' | 'pending' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleClick = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (status === 'pending') return;
    setStatus('pending');
    setErrorMsg(null);
    try {
      await downloadFile(path);
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : t('rightSidebar.downloadFailed'));
    }
  }, [path, status, t]);

  return (
    <span
      role="button"
      tabIndex={-1}
      onClick={(e) => void handleClick(e)}
      className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-muted-foreground transition active:scale-95 ${iconActionVisibilityClass(status === 'pending')} ${status === 'pending' ? 'bg-surface-elevated text-foreground' : 'bg-surface-2 hover:bg-surface-elevated hover:text-foreground'}`}
      title={status === 'error' ? errorMsg ?? t('rightSidebar.downloadFailed') : t('rightSidebar.downloadFile')}
    >
      {status === 'pending' ? <RiLoader size={12} className="animate-spin" /> : <RiDownload size={12} />}
    </span>
  );
});

function useFileDownloadAction() {
  const { t } = useI18n();
  const [state, setState] = useState<{ status: 'idle' | 'pending' | 'error'; message?: string }>({ status: 'idle' });
  const run = useCallback(async (path: string) => {
    setState({ status: 'pending' });
    try {
      await downloadFile(path);
      setState({ status: 'idle' });
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : t('rightSidebar.downloadFailed') });
    }
  }, [t]);
  return { state, run };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function hasNativeTextSelection(): boolean {
  if (typeof window === 'undefined') return false;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

function isDesktopContextMenu(event: React.MouseEvent): boolean {
  return event.button === 2 || event.ctrlKey;
}

const DIRECTORY_MENU_WIDTH_PX = 176;
const DIRECTORY_MENU_ESTIMATED_HEIGHT_PX = 160;
const DIRECTORY_MENU_VIEWPORT_MARGIN_PX = 8;

interface CursorMenuPosition {
  anchorX: number;
  anchorY: number;
  left: number;
  top: number;
}

function resolveCursorMenuPosition(clientX: number, clientY: number, menuWidth: number, menuHeight: number): CursorMenuPosition {
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
  const minLeft = viewportLeft + DIRECTORY_MENU_VIEWPORT_MARGIN_PX;
  const minTop = viewportTop + DIRECTORY_MENU_VIEWPORT_MARGIN_PX;
  const maxLeft = Math.max(minLeft, viewportRight - menuWidth - DIRECTORY_MENU_VIEWPORT_MARGIN_PX);
  const maxTop = Math.max(minTop, viewportBottom - menuHeight - DIRECTORY_MENU_VIEWPORT_MARGIN_PX);
  const preferredTop = clientY + menuHeight <= viewportBottom - DIRECTORY_MENU_VIEWPORT_MARGIN_PX
    ? clientY
    : clientY - menuHeight;

  return {
    anchorX: clientX,
    anchorY: clientY,
    left: Math.min(Math.max(clientX, minLeft), maxLeft),
    top: Math.min(Math.max(preferredTop, minTop), maxTop),
  };
}

function useCursorAnchoredMenu(actionsOpen: boolean) {
  const [position, setPosition] = useState<CursorMenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const openAt = useCallback((clientX: number, clientY: number) => {
    setPosition(resolveCursorMenuPosition(
      clientX,
      clientY,
      DIRECTORY_MENU_WIDTH_PX,
      DIRECTORY_MENU_ESTIMATED_HEIGHT_PX,
    ));
  }, []);

  useLayoutEffect(() => {
    if (!actionsOpen || !position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const next = resolveCursorMenuPosition(position.anchorX, position.anchorY, rect.width, rect.height);
    if (next.left === position.left && next.top === position.top) return;
    setPosition(next);
  }, [actionsOpen, position]);

  return { position, menuRef, openAt, clearPosition: () => setPosition(null) };
}

function renderDirectoryMenu(menu: ReactNode, atCursor: boolean): ReactNode {
  return atCursor && typeof document !== 'undefined' ? createPortal(menu, document.body) : menu;
}

function nodeMatchesQuery(node: FileTreeNode, queryLower: string): boolean {
  if (!queryLower) return true;
  return `${node.name} ${node.path}`.toLowerCase().includes(queryLower);
}

function hasMatchingDescendant(node: FileTreeNode, queryLower: string, directoryCache: Map<string, FileTreeNode[]>): boolean {
  if (!queryLower) return true;
  if (nodeMatchesQuery(node, queryLower)) return true;
  const children = directoryCache.get(node.path);
  if (!children) return false;
  return children.some((child) => hasMatchingDescendant(child, queryLower, directoryCache));
}

function toTreeNodes(entries: FileEntry[]): FileTreeNode[] {
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    type: e.type,
    isSymlink: e.isSymlink,
    modified: e.modified,
    expanded: false,
    loaded: false,
    children: e.type === 'directory' ? [] : undefined,
  }));
}

function getRelativePath(rootPath: string, filePath: string): string {
  if (!rootPath || !filePath.startsWith(rootPath)) return filePath;
  return filePath.slice(rootPath.length).replace(/^\/+/, '') || filePath;
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  onFileSelect: (path: string) => void;
  directoriesOnly?: boolean;
  onPathReference?: (path: string, key?: string) => void;
  getReferenceText?: (path: string) => string;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  onDirectoryRoot?: (path: string) => void;
  onSearchFromDirectory?: (path: string) => void;
  onDirectoryPinToggle?: (path: string) => void;
  onFilePinToggle?: (path: string) => void;
  onOpenInFileBrowser?: (path: string) => void;
  canOpenInFileBrowser?: boolean;
  pinnedPaths: Set<string>;
  selectedFilePath: string | null;
  queryLower: string;
  onDirectoryDropFiles?: (path: string, files: File[]) => void;
  onFileDeleteRequest: (node: FileTreeNode) => void;
  deletingFilePath: string | null;
  revealedDirectoryPath?: string | null;
}

const FileTreeItem = memo(function FileTreeItem({
  node,
  depth,
  onFileSelect,
  directoriesOnly = false,
  onPathReference,
  getReferenceText,
  onReferenceCopied,
  insertedReferenceKey,
  copiedReferenceKey,
  onDirectoryRoot,
  onSearchFromDirectory,
  onDirectoryPinToggle,
  onFilePinToggle,
  onOpenInFileBrowser,
  canOpenInFileBrowser,
  pinnedPaths,
  selectedFilePath,
  queryLower,
  onDirectoryDropFiles,
  onFileDeleteRequest,
  deletingFilePath,
  revealedDirectoryPath,
}: FileTreeItemProps) {
  const { t } = useI18n();
  // 精确订阅：每个节点只关心和自己相关的字段
  const isExpanded = useSidebarStore((s) => s.expandedPaths.has(node.path));
  const children = useSidebarStore((s) => s.directoryCache.get(node.path));
  const showHiddenFiles = useSidebarStore((s) => s.showHiddenFiles);
  const toggleExpanded = useSidebarStore((s) => s.toggleExpanded);
  const setDirectoryCache = useSidebarStore((s) => s.setDirectoryCache);
  const sortMode = useSidebarStore((s) => s.fileSortModes[node.path] ?? 'name');
  const setDirectorySortMode = useSidebarStore((s) => s.setDirectorySortMode);
  const [loading, setLoading] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const { position: cursorMenuPosition, menuRef: directoryMenuRef, openAt: openDirectoryMenuAt, clearPosition: clearDirectoryMenuPosition } = useCursorAnchoredMenu(actionsOpen);
  const [dropTarget, setDropTarget] = useState(false);
  const dropDepthRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const isSelected = node.path === selectedFilePath || node.path === revealedDirectoryPath;
  const showChildren = node.type === 'directory' && (isExpanded || Boolean(queryLower));
  const isDirectory = node.type === 'directory';
  const isPinned = pinnedPaths.has(node.path);
  const canPinFile = !isDirectory && Boolean(onFilePinToggle);
  const canOpenLocal = Boolean(canOpenInFileBrowser && onOpenInFileBrowser);
  const referenceKey = `path:${node.path}`;
  const referenceInserted = insertedReferenceKey === referenceKey;
  const referenceCopied = copiedReferenceKey === referenceKey;
  const referenceText = getReferenceText?.(node.path) ?? node.path;
  const getReferenceLongPressHandlers = useReferenceLongPressCopy(onReferenceCopied);
  const { state: fileDownloadState, run: runFileDownload } = useFileDownloadAction();
  const isDeleting = deletingFilePath === node.path;
  const hasDirectoryActions = isDirectory
    && !directoriesOnly
    && Boolean(onDirectoryRoot || onSearchFromDirectory || onDirectoryPinToggle || canOpenLocal);

  const visibleChildren = useMemo(() => {
    if (!children) return undefined;
    if (!queryLower) return children;
    // 搜索过滤需要查 directoryCache 的孙节点 — 这里读一次就够，
    // 不会触发额外订阅（getState 不订阅）。
    const cache = useSidebarStore.getState().directoryCache;
    return children.filter((child) => (!directoriesOnly || child.type === 'directory') && hasMatchingDescendant(child, queryLower, cache));
  }, [children, directoriesOnly, queryLower]);

  const loadChildren = useCallback(async () => {
    const cached = useSidebarStore.getState().directoryCache.has(node.path);
    if (!cached && !loading) {
      const requestSlotId = `file-tree:${node.path}`;
      loadAbortRef.current?.abort();
      cancelIoSlot(requestSlotId);
      const controller = new AbortController();
      loadAbortRef.current = controller;
      setLoading(true);
      try {
        const result = await listDirectory(node.path, controller.signal, showHiddenFiles, 'expand_directory', requestSlotId, sortMode);
        const treeNodes = toTreeNodes(result.entries);
        setDirectoryCache(node.path, treeNodes);
      } catch (error) {
        if (!isAbortError(error)) {
          // Silently fail — user can retry by collapsing and re-expanding
        }
      } finally {
        if (loadAbortRef.current === controller) loadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [node.path, loading, setDirectoryCache, showHiddenFiles, sortMode]);

  const handleToggle = useCallback(async () => {
    if (node.type !== 'directory') {
      onFileSelect(node.path);
      return;
    }
    if (directoriesOnly && onDirectoryRoot) {
      onDirectoryRoot(node.path);
      return;
    }

    const willExpand = !useSidebarStore.getState().expandedPaths.has(node.path);
    toggleExpanded(node.path);
    if (willExpand) await loadChildren();
  }, [directoriesOnly, node.path, node.type, loadChildren, onDirectoryRoot, toggleExpanded, onFileSelect]);

  useEffect(() => {
    if (node.type === 'directory' && isExpanded && !children && !loading) {
      void loadChildren();
    }
  }, [children, isExpanded, loadChildren, loading, node.type]);

  const handleReferenceClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onPathReference?.(node.path, referenceKey);
  }, [onPathReference, node.path, referenceKey]);

  const handleDirectoryRootClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onDirectoryRoot?.(node.path);
    setActionsOpen(false);
  }, [node.path, onDirectoryRoot]);

  const handleSearchFromDirectory = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onSearchFromDirectory?.(node.path);
    setActionsOpen(false);
  }, [node.path, onSearchFromDirectory]);

  const handleDirectoryPinClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onDirectoryPinToggle?.(node.path);
    setActionsOpen(false);
  }, [node.path, onDirectoryPinToggle]);

  const handleDirectorySortClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    void setDirectorySortMode(node.path, sortMode === 'modified' ? 'name' : 'modified');
    setActionsOpen(false);
  }, [node.path, setDirectorySortMode, sortMode]);

  const handleFilePinClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onFilePinToggle?.(node.path);
    setActionsOpen(false);
  }, [node.path, onFilePinToggle]);

  const handleFileDownload = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setActionsOpen(false);
    void runFileDownload(node.path);
  }, [node.path, runFileDownload]);

  const handleFileDelete = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setActionsOpen(false);
    onFileDeleteRequest(node);
  }, [node, onFileDeleteRequest]);

  const handleOpenInFileBrowser = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onOpenInFileBrowser?.(node.path);
    setActionsOpen(false);
  }, [node.path, onOpenInFileBrowser]);

  const handleDirectoryDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isDirectory || !onDirectoryDropFiles || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepthRef.current += 1;
    setDropTarget(true);
  }, [isDirectory, onDirectoryDropFiles]);

  const handleDirectoryDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isDirectory || !onDirectoryDropFiles || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDropTarget(true);
  }, [isDirectory, onDirectoryDropFiles]);

  const handleDirectoryDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isDirectory || !onDirectoryDropFiles) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepthRef.current -= 1;
    if (dropDepthRef.current <= 0) {
      dropDepthRef.current = 0;
      setDropTarget(false);
    }
  }, [isDirectory, onDirectoryDropFiles]);

  const handleDirectoryDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isDirectory || !onDirectoryDropFiles) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepthRef.current = 0;
    setDropTarget(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onDirectoryDropFiles(node.path, files);
  }, [isDirectory, node.path, onDirectoryDropFiles]);

  const handleDirectoryMoreClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    clearDirectoryMenuPosition();
    setActionsOpen((open) => !open);
  }, [clearDirectoryMenuPosition]);

  const handleDirectoryContextMenu = useCallback((event: React.MouseEvent) => {
    if (!hasDirectoryActions || !isDesktopContextMenu(event)) return;
    event.preventDefault();
    event.stopPropagation();
    openDirectoryMenuAt(event.clientX, event.clientY);
    setActionsOpen(true);
  }, [hasDirectoryActions, openDirectoryMenuAt]);

  useEffect(() => {
    if (!actionsOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (actionMenuRef.current?.contains(target) || directoryMenuRef.current?.contains(target))) return;
      setActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [actionsOpen, directoryMenuRef]);

  useEffect(() => () => {
    loadAbortRef.current?.abort();
  }, []);

  return (
    <div>
      <div ref={actionMenuRef} className="relative">
        {getReferenceLongPressHandlers.popoverNode}
        <div
        data-file-tree-path={node.path}
        data-sort-mode={sortMode}
        role="button"
        tabIndex={0}
        onClick={() => {
          if (hasNativeTextSelection()) return;
          void handleToggle();
        }}
        onContextMenu={handleDirectoryContextMenu}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          void handleToggle();
        }}
        onDragEnter={handleDirectoryDragEnter}
        onDragOver={handleDirectoryDragOver}
        onDragLeave={handleDirectoryDragLeave}
        onDrop={handleDirectoryDrop}
        className={`group relative flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1 text-[13px] transition ${
          dropTarget
            ? 'scale-[1.015] bg-primary/15 text-foreground shadow-[0_0_0_1px_rgb(var(--primary-rgb)_/_0.45)]'
            : isSelected
              ? 'bg-surface-elevated text-foreground'
              : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
        }`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        title={node.path}
      >
        {dropTarget && (
          <span className="pointer-events-none absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-md">
            {t('fileTree.dropToUploadHere')}
          </span>
        )}
        {node.type === 'directory' ? (
          <>
            {showChildren ? <RiChevronDown size={14} className="shrink-0 text-muted-foreground/80" /> : <RiChevronRight size={14} className="shrink-0 text-muted-foreground/80" />}
            {showChildren ? <RiFolderOpen size={14} className="shrink-0 text-[color:var(--folder)]" /> : <RiFolder size={14} className="shrink-0 text-[color:var(--folder)]" />}
          </>
        ) : (
          <>
            <span className="w-[14px] shrink-0" />
            <span className={isSelected ? 'text-primary' : 'text-muted-foreground/80'}>
              {getFileIcon(node.name, node.type)}
            </span>
          </>
        )}
        <span className={`min-w-0 flex-1 select-text whitespace-normal break-all text-left leading-snug ${isSelected ? 'font-medium' : ''}`}>
          {node.name}
          {sortMode === 'modified' && (
            <span className="ml-1 inline-flex align-middle text-primary" title={t('fileTree.sortedByModified')} aria-label={t('fileTree.sortedByModified')}>
              <RiClock size={11} />
            </span>
          )}
          {node.isSymlink && (
            <span className="ml-1 inline-flex align-middle text-muted-foreground/70" title={t('fileTree.symbolicLink')}>
              <RiLink size={11} />
            </span>
          )}
        </span>
        {loading && <RiLoader size={12} className="shrink-0 animate-spin text-muted-foreground" />}
        <ChangeBadge path={node.path} />
        {hasDirectoryActions && (
          <span
            onClick={handleDirectoryMoreClick}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-muted-foreground transition active:scale-95 ${iconActionVisibilityClass(actionsOpen)} ${actionsOpen ? 'bg-surface-elevated text-foreground' : 'bg-surface-2 hover:bg-surface-elevated hover:text-foreground'}`}
            title={t('fileTree.moreDirActions')}
          >
            <RiMoreHorizontal size={13} />
          </span>
        )}
        {!isDirectory && (
          <span
            onClick={handleDirectoryMoreClick}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-muted-foreground transition active:scale-95 ${iconActionVisibilityClass(actionsOpen || fileDownloadState.status === 'pending' || isDeleting || isPinned)} ${actionsOpen ? 'bg-surface-elevated text-foreground' : isPinned ? 'bg-primary/15 text-primary' : 'bg-surface-2 hover:bg-surface-elevated hover:text-foreground'}`}
            title={fileDownloadState.status === 'error' ? fileDownloadState.message ?? t('rightSidebar.downloadFailed') : t('fileTree.moreFileActions')}
          >
            {fileDownloadState.status === 'pending' || isDeleting ? <RiLoader size={13} className="animate-spin" /> : <RiMoreHorizontal size={13} />}
          </span>
        )}
        {onPathReference && (
          <span
            onClick={handleReferenceClick}
            {...getReferenceLongPressHandlers(referenceText, referenceKey)}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-[11px] font-semibold transition active:scale-95 ${textActionVisibilityClass(referenceInserted || referenceCopied)} ${referenceInserted || referenceCopied ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary'}`}
            aria-label={referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('fileTree.insertRefTitle')}
            title={referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('fileTree.insertRefTitle')}
          >
            {referenceCopied || referenceInserted ? <RiCheck size={12} /> : <RiLink size={12} />}
          </span>
        )}
        </div>

        {hasDirectoryActions && actionsOpen && renderDirectoryMenu(
          <div
            ref={directoryMenuRef}
            className={`${cursorMenuPosition ? 'fixed z-menu-panel' : 'absolute right-2 top-[calc(100%+2px)] z-30'} w-44 overflow-hidden rounded-xl border border-border/15 bg-surface/98 p-1 text-[12px] shadow-xl shadow-[0_18px_48px_var(--app-shadow-soft)] backdrop-blur animate-fade-in`}
            style={cursorMenuPosition ? { left: cursorMenuPosition.left, top: cursorMenuPosition.top } : undefined}
          >
          {canOpenLocal && (
            <button
              type="button"
              onClick={handleOpenInFileBrowser}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-foreground transition hover:bg-surface-2 active:scale-[0.99]"
              title={t('fileTree.openInFileBrowserTitle')}
            >
              <RiFolderOpen size={13} className="shrink-0 text-[color:var(--folder)]" />
              <span className="min-w-0 flex-1 truncate">{t('fileTree.openInFileBrowser')}</span>
            </button>
          )}
          {onDirectoryRoot && (
            <button
              type="button"
              onClick={handleDirectoryRootClick}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-foreground transition hover:bg-surface-2 active:scale-[0.99]"
              title={t('fileTree.openDirRootTitle')}
            >
              <RiFolderOpen size={13} className="shrink-0 text-[color:var(--folder)]" />
              <span className="min-w-0 flex-1 truncate">{t('fileTree.openDirRoot')}</span>
            </button>
          )}
          {onSearchFromDirectory && (
            <button
              type="button"
              onClick={handleSearchFromDirectory}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-foreground transition hover:bg-surface-2 active:scale-[0.99]"
              title={t('fileTree.searchFromDirTitle')}
            >
              <RiFolderSearch size={13} className="shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{t('fileTree.searchFromDir')}</span>
            </button>
          )}
          {onDirectoryPinToggle && (
            <button
              type="button"
              onClick={handleDirectoryPinClick}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium transition active:scale-[0.99] ${isPinned ? 'text-primary hover:bg-primary/10' : 'text-foreground hover:bg-surface-2'}`}
              title={isPinned ? t('fileTree.unpinDirTitle') : t('fileTree.pinDirTitle')}
            >
              {isPinned ? <RiPinOff size={13} className="shrink-0" /> : <RiPin size={13} className="shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{isPinned ? t('fileTree.unpinDir') : t('fileTree.pinDir')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleDirectorySortClick}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-foreground transition hover:bg-surface-2 active:scale-[0.99]"
          >
            {sortMode === 'modified' ? <RiSortName size={13} className="shrink-0" /> : <RiClock size={13} className="shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{sortMode === 'modified' ? t('fileTree.sortByName') : t('fileTree.sortByModified')}</span>
          </button>
          </div>,
          Boolean(cursorMenuPosition),
        )}

        {!isDirectory && actionsOpen && (
          <div className="absolute right-2 top-[calc(100%+2px)] z-30 w-44 overflow-hidden rounded-xl border border-border/15 bg-surface/98 p-1 text-[12px] shadow-xl shadow-[0_18px_48px_var(--app-shadow-soft)] backdrop-blur animate-fade-in">
          {canOpenLocal && (
            <button
              type="button"
              onClick={handleOpenInFileBrowser}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-foreground transition hover:bg-surface-2 active:scale-[0.99]"
              title={t('fileTree.openInFileBrowserTitle')}
            >
              <RiFile size={13} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t('fileTree.openInFileBrowser')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleFileDownload}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-foreground transition hover:bg-surface-2 active:scale-[0.99]"
            title={t('rightSidebar.downloadFile')}
          >
            <RiDownload size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t('rightSidebar.downloadFile')}</span>
          </button>
          {canPinFile && (
            <button
              type="button"
              onClick={handleFilePinClick}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium transition active:scale-[0.99] ${isPinned ? 'text-primary hover:bg-primary/10' : 'text-foreground hover:bg-surface-2'}`}
              title={isPinned ? t('fileTree.unpinFileTitle') : t('fileTree.pinFileTitle')}
            >
              {isPinned ? <RiPinOff size={13} className="shrink-0" /> : <RiPin size={13} className="shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{isPinned ? t('fileTree.unpinFile') : t('fileTree.pinFile')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleFileDelete}
            disabled={isDeleting}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-destructive transition hover:bg-destructive/10 active:scale-[0.99] disabled:opacity-50"
            title={t('fileTree.deleteFile')}
          >
            {isDeleting ? <RiLoader size={13} className="shrink-0 animate-spin" /> : <RiTrash size={13} className="shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{t('fileTree.deleteFile')}</span>
          </button>
          </div>
        )}
      </div>

      {showChildren && visibleChildren && visibleChildren.length > 0 && (
        <div className={depth === 0 ? 'mt-0.5' : ''}>
          {visibleChildren.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              onFileSelect={onFileSelect}
              directoriesOnly={directoriesOnly}
              onPathReference={onPathReference}
              getReferenceText={getReferenceText}
              onReferenceCopied={onReferenceCopied}
              onDirectoryRoot={onDirectoryRoot}
              onSearchFromDirectory={onSearchFromDirectory}
              onDirectoryPinToggle={onDirectoryPinToggle}
              onFilePinToggle={onFilePinToggle}
              onOpenInFileBrowser={onOpenInFileBrowser}
              canOpenInFileBrowser={canOpenInFileBrowser}
              pinnedPaths={pinnedPaths}
              selectedFilePath={selectedFilePath}
              queryLower={queryLower}
              insertedReferenceKey={insertedReferenceKey}
              copiedReferenceKey={copiedReferenceKey}
              onDirectoryDropFiles={onDirectoryDropFiles}
              onFileDeleteRequest={onFileDeleteRequest}
              deletingFilePath={deletingFilePath}
              revealedDirectoryPath={revealedDirectoryPath}
            />
          ))}
        </div>
      )}
    </div>
  );
});

interface FileSearchResultItemProps {
  node: FileTreeNode;
  rootPath: string;
  onFileSelect: (path: string) => void;
  onPathReference?: (path: string, key?: string) => void;
  getReferenceText?: (path: string) => string;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  onDirectoryRoot?: (path: string) => void;
  onSearchFromDirectory?: (path: string) => void;
  onDirectoryPinToggle?: (path: string) => void;
  onFilePinToggle?: (path: string) => void;
  pinnedPaths: Set<string>;
  selectedFilePath: string | null;
  onFileDeleteRequest: (node: FileTreeNode) => void;
  deletingFilePath: string | null;
}

const FileSearchResultItem = memo(function FileSearchResultItem({
  node,
  rootPath,
  onFileSelect,
  onPathReference,
  getReferenceText,
  onReferenceCopied,
  insertedReferenceKey,
  copiedReferenceKey,
  onDirectoryRoot,
  onSearchFromDirectory,
  onDirectoryPinToggle,
  onFilePinToggle,
  pinnedPaths,
  selectedFilePath,
  onFileDeleteRequest,
  deletingFilePath,
}: FileSearchResultItemProps) {
  const { t } = useI18n();
  const isSelected = node.path === selectedFilePath;
  const isDirectory = node.type === 'directory';
  const isPinned = pinnedPaths.has(node.path);
  const canPinFile = !isDirectory && Boolean(onFilePinToggle);
  const referenceKey = `path:${node.path}`;
  const referenceInserted = insertedReferenceKey === referenceKey;
  const referenceCopied = copiedReferenceKey === referenceKey;
  const referenceText = getReferenceText?.(node.path) ?? node.path;
  const getReferenceLongPressHandlers = useReferenceLongPressCopy(onReferenceCopied);
  const { state: fileDownloadState, run: runFileDownload } = useFileDownloadAction();
  const [actionsOpen, setActionsOpen] = useState(false);
  const { position: cursorMenuPosition, menuRef: directoryMenuRef, openAt: openDirectoryMenuAt, clearPosition: clearDirectoryMenuPosition } = useCursorAnchoredMenu(actionsOpen);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const isDeleting = deletingFilePath === node.path;
  const hasDirectoryActions = isDirectory
    && Boolean(onDirectoryRoot || onSearchFromDirectory || onDirectoryPinToggle);

  const handleClick = useCallback(() => {
    if (hasNativeTextSelection()) return;
    if (node.type === 'directory') onDirectoryRoot?.(node.path);
    else onFileSelect(node.path);
  }, [node.path, node.type, onDirectoryRoot, onFileSelect]);

  const handleReferenceClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onPathReference?.(node.path, referenceKey);
  }, [onPathReference, node.path, referenceKey]);

  const handleDirectoryPinClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onDirectoryPinToggle?.(node.path);
    setActionsOpen(false);
  }, [node.path, onDirectoryPinToggle]);

  const handleFilePinClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onFilePinToggle?.(node.path);
    setActionsOpen(false);
  }, [node.path, onFilePinToggle]);

  const handleFileDownload = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setActionsOpen(false);
    void runFileDownload(node.path);
  }, [node.path, runFileDownload]);

  const handleFileDelete = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setActionsOpen(false);
    onFileDeleteRequest(node);
  }, [node, onFileDeleteRequest]);

  const handleDirectoryMoreClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    clearDirectoryMenuPosition();
    setActionsOpen((open) => !open);
  }, [clearDirectoryMenuPosition]);

  const handleDirectoryContextMenu = useCallback((event: React.MouseEvent) => {
    if (!hasDirectoryActions || !isDesktopContextMenu(event)) return;
    event.preventDefault();
    event.stopPropagation();
    openDirectoryMenuAt(event.clientX, event.clientY);
    setActionsOpen(true);
  }, [hasDirectoryActions, openDirectoryMenuAt]);

  useEffect(() => {
    if (!actionsOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (actionMenuRef.current?.contains(target) || directoryMenuRef.current?.contains(target))) return;
      setActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [actionsOpen, directoryMenuRef]);

  return (
    <div ref={actionMenuRef} className="relative border-b border-border/10 last:border-b-0">
      {getReferenceLongPressHandlers.popoverNode}
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onContextMenu={handleDirectoryContextMenu}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          handleClick();
        }}
        className={`group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] transition ${
          isSelected
            ? 'bg-surface-elevated text-foreground'
            : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
        }`}
        title={node.path}
      >
        {node.type === 'directory' ? (
          <>
            <span className="w-[14px] shrink-0" />
            <RiFolder size={14} className="shrink-0 text-[color:var(--folder)]" />
          </>
        ) : (
          <>
            <span className="w-[14px] shrink-0" />
            <span className={isSelected ? 'text-primary' : 'text-muted-foreground/80'}>{getFileIcon(node.name, node.type)}</span>
          </>
        )}
        <span className="min-w-0 flex-1 select-text">
          <span className={`block whitespace-normal break-all font-medium leading-snug ${isSelected ? 'text-primary' : 'text-foreground'}`}>
            {node.name}
            {node.isSymlink && (
              <span className="ml-1 inline-flex align-middle text-muted-foreground/70" title={t('fileTree.symbolicLink')}>
                <RiLink size={11} />
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/80">{getRelativePath(rootPath, node.path)}</span>
        </span>
        <ChangeBadge path={node.path} />
        {node.type === 'directory' && (onDirectoryPinToggle || onSearchFromDirectory) && (
          <span
            onClick={handleDirectoryMoreClick}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-muted-foreground transition active:scale-95 ${iconActionVisibilityClass(actionsOpen)} ${actionsOpen ? 'bg-surface-elevated text-foreground' : 'bg-surface-2 hover:bg-surface-elevated hover:text-foreground'}`}
            title={t('fileTree.moreDirActions')}
          >
            <RiMoreHorizontal size={13} />
          </span>
        )}
        {!isDirectory && (
          <span
            onClick={handleDirectoryMoreClick}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-muted-foreground transition active:scale-95 ${iconActionVisibilityClass(actionsOpen || fileDownloadState.status === 'pending' || isDeleting || isPinned)} ${actionsOpen ? 'bg-surface-elevated text-foreground' : isPinned ? 'bg-primary/15 text-primary' : 'bg-surface-2 hover:bg-surface-elevated hover:text-foreground'}`}
            title={fileDownloadState.status === 'error' ? fileDownloadState.message ?? t('rightSidebar.downloadFailed') : t('fileTree.moreFileActions')}
          >
            {fileDownloadState.status === 'pending' || isDeleting ? <RiLoader size={13} className="animate-spin" /> : <RiMoreHorizontal size={13} />}
          </span>
        )}
        {onPathReference && (
          <span
            onClick={handleReferenceClick}
            {...getReferenceLongPressHandlers(referenceText, referenceKey)}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-[11px] font-semibold transition active:scale-95 ${textActionVisibilityClass(referenceInserted || referenceCopied)} ${referenceInserted || referenceCopied ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary'}`}
            aria-label={referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('fileTree.insertRefTitle')}
            title={referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('fileTree.insertRefTitle')}
          >
            {referenceCopied || referenceInserted ? <RiCheck size={12} /> : <RiLink size={12} />}
          </span>
        )}
      </div>
      {hasDirectoryActions && actionsOpen && renderDirectoryMenu(
        <div
          ref={directoryMenuRef}
          className={`${cursorMenuPosition ? 'fixed z-menu-panel' : 'absolute right-2 top-[calc(100%+2px)] z-30'} w-44 overflow-hidden rounded-xl border border-border/15 bg-surface/98 p-1 text-[12px] shadow-xl shadow-[0_18px_48px_var(--app-shadow-soft)] backdrop-blur animate-fade-in`}
          style={cursorMenuPosition ? { left: cursorMenuPosition.left, top: cursorMenuPosition.top } : undefined}
        >
          {onDirectoryRoot && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDirectoryRoot(node.path);
                setActionsOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-foreground transition hover:bg-surface-2 active:scale-[0.99]"
              title={t('fileTree.openDirRootTitle')}
            >
              <RiFolderOpen size={13} className="shrink-0 text-[color:var(--folder)]" />
              <span className="min-w-0 flex-1 truncate">{t('fileTree.openDirRoot')}</span>
            </button>
          )}
          {onSearchFromDirectory && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSearchFromDirectory(node.path);
                setActionsOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-foreground transition hover:bg-surface-2 active:scale-[0.99]"
            >
              <RiFolderSearch size={13} className="shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{t('fileTree.searchFromDir')}</span>
            </button>
          )}
          {onDirectoryPinToggle && <button
            type="button"
            onClick={handleDirectoryPinClick}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium transition active:scale-[0.99] ${isPinned ? 'text-primary hover:bg-primary/10' : 'text-foreground hover:bg-surface-2'}`}
            title={isPinned ? t('fileTree.unpinDirTitle') : t('fileTree.pinDirTitle')}
          >
            {isPinned ? <RiPinOff size={13} className="shrink-0" /> : <RiPin size={13} className="shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{isPinned ? t('fileTree.unpinDir') : t('fileTree.pinDir')}</span>
          </button>}
        </div>,
        Boolean(cursorMenuPosition),
      )}

      {!isDirectory && actionsOpen && (
        <div className="absolute right-2 top-[calc(100%+2px)] z-30 w-44 overflow-hidden rounded-xl border border-border/15 bg-surface/98 p-1 text-[12px] shadow-xl shadow-[0_18px_48px_var(--app-shadow-soft)] backdrop-blur animate-fade-in">
          <button
            type="button"
            onClick={handleFileDownload}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-foreground transition hover:bg-surface-2 active:scale-[0.99]"
            title={t('rightSidebar.downloadFile')}
          >
            <RiDownload size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t('rightSidebar.downloadFile')}</span>
          </button>
          {canPinFile && (
            <button
              type="button"
              onClick={handleFilePinClick}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium transition active:scale-[0.99] ${isPinned ? 'text-primary hover:bg-primary/10' : 'text-foreground hover:bg-surface-2'}`}
              title={isPinned ? t('fileTree.unpinFileTitle') : t('fileTree.pinFileTitle')}
            >
              {isPinned ? <RiPinOff size={13} className="shrink-0" /> : <RiPin size={13} className="shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{isPinned ? t('fileTree.unpinFile') : t('fileTree.pinFile')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleFileDelete}
            disabled={isDeleting}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-destructive transition hover:bg-destructive/10 active:scale-[0.99] disabled:opacity-50"
            title={t('fileTree.deleteFile')}
          >
            {isDeleting ? <RiLoader size={13} className="shrink-0 animate-spin" /> : <RiTrash size={13} className="shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{t('fileTree.deleteFile')}</span>
          </button>
        </div>
      )}
    </div>
  );
});

const SEARCH_INITIAL_VISIBLE_CONTENT = 60;
const SEARCH_LOAD_MORE_STEP_CONTENT = 60;
const MAX_VISIBLE_MATCHES_PER_FILE = 20;

function SearchResultsHeader({ count, loading, engine, limited, scope, content }: {
  count: number;
  loading: boolean;
  engine?: FileSearchEngine;
  limited?: boolean;
  scope: string;
  content: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="sticky top-0 z-10 -mx-2 -mt-2 mb-2 border-b border-border/15 bg-surface/95 px-3 py-2.5 backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2 text-[12px] font-semibold text-foreground">
          <RiFolderSearch size={14} className="shrink-0 text-primary" />
          <span>{content ? t('fileTree.contentMatchesCount', { count }) : t('fileTree.searchResults', { count })}</span>
        </span>
        {engine && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            {loading && <RiLoader size={9} className="animate-spin" />}
            {engine}{limited ? ' · limited' : ''}
          </span>
        )}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="shrink-0">{t('fileTree.searchScope')}</span>
        <span className="min-w-0 truncate font-mono text-foreground/75" title={scope}>{scope}</span>
        {loading && <span className="ml-auto shrink-0">{t('fileTree.searching')}</span>}
      </div>
    </div>
  );
}

interface ContentSearchResultItemProps {
  entry: FileContentSearchEntry;
  rootPath: string;
  selectedFilePath: string | null;
  query: string;
  onContentMatchSelect?: (path: string, line: number) => void;
  onPathReference?: (path: string, key?: string) => void;
  getReferenceText?: (path: string) => string;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let from = 0;
  let index = lower.indexOf(needle, from);
  let key = 0;
  while (index >= 0 && needle) {
    if (index > from) nodes.push(text.slice(from, index));
    nodes.push(
      <mark key={`m-${key++}`} className="rounded-sm bg-[rgb(var(--warning-rgb)_/_0.30)] px-0.5 text-foreground">
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    from = index + needle.length;
    index = lower.indexOf(needle, from);
  }
  if (from < text.length) nodes.push(text.slice(from));
  return nodes.length > 0 ? nodes : text;
}

const ContentSearchResultItem = memo(function ContentSearchResultItem({
  entry,
  rootPath,
  selectedFilePath,
  query,
  onContentMatchSelect,
  onPathReference,
  getReferenceText,
  onReferenceCopied,
  insertedReferenceKey,
  copiedReferenceKey,
}: ContentSearchResultItemProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const isSelected = entry.path === selectedFilePath;
  const visibleMatches = expanded ? entry.matches.slice(0, MAX_VISIBLE_MATCHES_PER_FILE) : [];
  const hiddenCount = entry.matches.length - visibleMatches.length;
  const referenceKey = `path:${entry.path}`;
  const referenceInserted = insertedReferenceKey === referenceKey;
  const referenceCopied = copiedReferenceKey === referenceKey;
  const referenceText = getReferenceText?.(entry.path) ?? entry.path;
  const getReferenceLongPressHandlers = useReferenceLongPressCopy(onReferenceCopied);

  return (
    <div className="border-b border-border/10 last:border-b-0">
      {getReferenceLongPressHandlers.popoverNode}
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (hasNativeTextSelection()) return;
          setExpanded((open) => !open);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setExpanded((open) => !open);
        }}
        className={`group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] transition ${
          isSelected ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
        }`}
        title={entry.path}
      >
        {expanded ? <RiChevronDown size={14} className="shrink-0 text-muted-foreground/80" /> : <RiChevronRight size={14} className="shrink-0 text-muted-foreground/80" />}
        <span className={isSelected ? 'text-primary' : 'text-muted-foreground/80'}>{getFileIcon(entry.name, 'file')}</span>
        <span className="min-w-0 flex-1 select-text">
          <span className="block whitespace-normal break-all font-medium leading-snug">{entry.name}</span>
          <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/80">{getRelativePath(rootPath, entry.path)}</span>
        </span>
        <span className="shrink-0 select-none rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{entry.matches.length}</span>
        <FileDownloadAction path={entry.path} />
        {onPathReference && (
          <span
            onClick={(event) => {
              event.stopPropagation();
              onPathReference(entry.path, referenceKey);
            }}
            {...getReferenceLongPressHandlers(referenceText, referenceKey)}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-[11px] font-semibold transition active:scale-95 ${textActionVisibilityClass(referenceInserted || referenceCopied)} ${referenceInserted || referenceCopied ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary'}`}
            aria-label={referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('fileTree.insertRefTitle')}
            title={referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('fileTree.insertRefTitle')}
          >
            {referenceCopied || referenceInserted ? <RiCheck size={12} /> : <RiLink size={12} />}
          </span>
        )}
      </div>
      {expanded && (
        <div className="mb-1 ml-3 border-l border-border/20 pl-1">
          {visibleMatches.map((match, matchIndex) => (
            <div
              // eslint-disable-next-line react/no-array-index-key
              key={`${match.line}-${matchIndex}`}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (hasNativeTextSelection()) return;
                onContentMatchSelect?.(entry.path, match.line);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onContentMatchSelect?.(entry.path, match.line);
              }}
              className="flex w-full cursor-pointer items-start gap-2 rounded px-2 py-1 text-left font-mono text-[11px] text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
              title={`${getRelativePath(rootPath, entry.path)}:${match.line}`}
            >
              <span className="shrink-0 select-none tabular-nums text-muted-foreground/60">{match.line}</span>
              <span className="min-w-0 flex-1 truncate whitespace-pre select-text">{highlightMatch(match.text, query)}</span>
            </div>
          ))}
          {hiddenCount > 0 && (
            <div className="px-2 py-1 text-[10px] text-muted-foreground/70">
              {t('fileTree.moreMatches', { count: hiddenCount })}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export function FileTree({ rootPath, onFileSelect, directoriesOnly = false, onPathReference, getReferenceText, onReferenceCopied, insertedReferenceKey, copiedReferenceKey, onDirectoryRoot, onSearchFromDirectory, onDirectoryPinToggle, onFilePinToggle, onOpenInFileBrowser, canOpenInFileBrowser = false, pinnedPaths = EMPTY_PINNED_PATHS, selectedFilePath, query = '', searchRootPath, searchOptions = {}, searchMode = 'name', onContentMatchSelect, onDirectoryDropFiles, revealDirectory }: FileTreeProps) {
  const { t } = useI18n();
  // 只订阅根目录条目 — 其他树节点变化不重渲染 FileTree 容器
  const rootEntries = useSidebarStore((s) => (rootPath ? s.directoryCache.get(rootPath) : undefined));
  const setDirectoryCache = useSidebarStore((s) => s.setDirectoryCache);
  const showHiddenFiles = useSidebarStore((s) => s.showHiddenFiles);
  const fileSortModesHydrated = useSidebarStore((s) => s.fileSortModesHydrated);
  const rootSortMode = useSidebarStore((s) => s.fileSortModes[rootPath] ?? 'name');
  const hydrateFileSortModes = useSidebarStore((s) => s.hydrateFileSortModes);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rootTruncated, setRootTruncated] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [sortHydrationSettled, setSortHydrationSettled] = useState(fileSortModesHydrated);
  const sortModeReady = fileSortModesHydrated || sortHydrationSettled;

  useEffect(() => {
    let cancelled = false;
    void hydrateFileSortModes()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setSortHydrationSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrateFileSortModes]);
  const [searchEntries, setSearchEntries] = useState<FileTreeNode[]>([]);
  const [searchMeta, setSearchMeta] = useState<{ truncated: boolean; total: number; engine: FileSearchEngine; limited: boolean; done: boolean } | null>(null);
  const [visibleSearchCount, setVisibleSearchCount] = useState(SEARCH_INITIAL_VISIBLE);
  const [contentEntries, setContentEntries] = useState<FileContentSearchEntry[]>([]);
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const searchRequestSeqRef = useRef(0);
  const queryLower = query.trim().toLowerCase();
  const isContentMode = searchMode === 'content';
  const activeSearchRoot = searchRootPath || rootPath;
  const excludePatterns = searchOptions.excludePatterns ?? EMPTY_EXCLUDE_PATTERNS;
  const excludeKey = excludePatterns.join('\n');

  useEffect(() => {
    const targetPath = revealDirectory?.path;
    if (!targetPath || (!targetPath.startsWith(`${rootPath}/`) && targetPath !== rootPath)) return;

    const relative = targetPath.slice(rootPath.length).replace(/^\/+/, '');
    const parts = relative ? relative.split('/') : [];
    const pathsToExpand = parts.map((_, index) => `${rootPath}/${parts.slice(0, index + 1).join('/')}`);
    const store = useSidebarStore.getState();
    const missingPaths = pathsToExpand.filter((path) => !store.expandedPaths.has(path));
    if (missingPaths.length > 0) {
      useSidebarStore.setState((state) => ({
        expandedPaths: new Set([...state.expandedPaths, ...missingPaths]),
      }));
    }

    let cancelled = false;
    let attempts = 0;
    const reveal = () => {
      if (cancelled) return;
      const target = Array.from(document.querySelectorAll<HTMLElement>('[data-file-tree-path]'))
        .find((element) => element.dataset.fileTreePath === targetPath);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      attempts += 1;
      if (attempts < 80) window.setTimeout(reveal, 50);
    };
    const frame = window.requestAnimationFrame(reveal);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [revealDirectory?.nonce, revealDirectory?.path, rootPath]);

  const handleFileDeleteRequest = useCallback(async (node: FileTreeNode) => {
    if (deletingFilePath || node.type === 'directory') return;
    if (!window.confirm(t('fileTree.deleteFileConfirm', { name: node.name }))) return;

    setDeletingFilePath(node.path);
    try {
      await deleteFile(node.path);
      useSidebarStore.getState().applyFileWatchEvents([{ type: 'deleted', path: node.path }]);
      setSearchEntries((entries) => entries.filter((entry) => entry.path !== node.path));
      setContentEntries((entries) => entries.filter((entry) => entry.path !== node.path));
      if (pinnedPaths.has(node.path)) onFilePinToggle?.(node.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(t('fileTree.deleteFileFailed', { message }));
    } finally {
      setDeletingFilePath(null);
    }
  }, [deletingFilePath, onFilePinToggle, pinnedPaths, t]);

  // Load root directory
  useEffect(() => {
    if (!rootPath) return;
    // The persisted sort mode determines the server request. Waiting for this
    // lightweight hydration prevents a name-sorted request from completing
    // just before hydration clears it and triggers a second visible loading.
    if (!sortModeReady) return;
    if (queryLower) {
      setLoading(false);
      return;
    }
    if (useSidebarStore.getState().directoryCache.has(rootPath)) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    listDirectory(rootPath, controller.signal, showHiddenFiles, 'load_file_tree_root', `file-tree-root:${rootPath}`, rootSortMode)
      .then((result) => {
        if (cancelled) return;
        const treeNodes = toTreeNodes(result.entries);
        setRootTruncated(Boolean(result.truncated));
        setDirectoryCache(rootPath, treeNodes);
      })
      .catch((err) => {
        if (cancelled || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Failed to load directory');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      cancelIoSlot(`file-tree-root:${rootPath}`);
    };
  }, [queryLower, rootEntries, rootPath, rootSortMode, setDirectoryCache, showHiddenFiles, sortModeReady]);

  useEffect(() => {
    if (!activeSearchRoot || !queryLower) {
      setSearchLoading(false);
      setSearchError(null);
      setSearchEntries([]);
      setContentEntries([]);
      setSearchMeta(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const seen = new Set<string>();
    setSearchLoading(true);
    setSearchError(null);
    setSearchEntries([]);
    setContentEntries([]);
    setVisibleSearchCount(isContentMode ? SEARCH_INITIAL_VISIBLE_CONTENT : SEARCH_INITIAL_VISIBLE);
    setSearchMeta({ truncated: false, total: 0, engine: 'rg', limited: false, done: false });

    const requestSlotId = `file-search:${activeSearchRoot}:${++searchRequestSeqRef.current}`;
    searchFilesStream(activeSearchRoot, query.trim(), (progress) => {
      if (cancelled) return;
      if (progress.engine) {
        setSearchMeta((current) => ({
          truncated: current?.truncated ?? false,
          total: current?.total ?? 0,
          engine: progress.engine!,
          limited: progress.limited ?? current?.limited ?? false,
          done: current?.done ?? false,
        }));
      }
      if (progress.entries?.length) {
        const nextEntries = progress.entries.filter((entry) => {
          if (seen.has(entry.path)) return false;
          seen.add(entry.path);
          return true;
        });
        if (nextEntries.length > 0) {
          setSearchEntries((current) => [...current, ...toTreeNodes(nextEntries)]);
          setSearchMeta((current) => current ? { ...current, total: seen.size } : { truncated: false, total: seen.size, engine: 'rg', limited: false, done: false });
        }
      }
      if (progress.contentEntries?.length) {
        const nextEntries = progress.contentEntries.filter((entry) => {
          if (seen.has(entry.path)) return false;
          seen.add(entry.path);
          return true;
        });
        if (nextEntries.length > 0) {
          setContentEntries((current) => [...current, ...nextEntries]);
          setSearchMeta((current) => current ? { ...current, total: seen.size } : { truncated: false, total: seen.size, engine: 'rg', limited: false, done: false });
        }
      }
      if (progress.done) {
        setSearchMeta((current) => ({
          truncated: Boolean(progress.truncated),
          total: typeof progress.total === 'number' ? progress.total : seen.size,
          engine: progress.engine ?? current?.engine ?? 'rg',
          limited: Boolean(progress.limited),
          done: true,
        }));
      }
    }, controller.signal, showHiddenFiles, searchMode, requestSlotId, {
      excludePatterns,
      caseSensitive: searchOptions.caseSensitive,
      wholeWord: searchOptions.wholeWord,
      regex: searchOptions.regex,
    })
      .catch((err) => {
        if (cancelled || isAbortError(err)) return;
        setSearchError(err instanceof Error ? err.message : 'Failed to search files');
        setSearchEntries([]);
        setContentEntries([]);
        setSearchMeta(null);
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      cancelIoSlot(requestSlotId);
    };
  }, [activeSearchRoot, excludeKey, isContentMode, query, queryLower, searchMode, searchOptions.caseSensitive, searchOptions.regex, searchOptions.wholeWord, showHiddenFiles]);

  useEffect(() => {
    if (!queryLower) return;
    const target = loadMoreRef.current;
    if (!target) return;
    const totalLength = isContentMode ? contentEntries.length : searchEntries.length;
    const step = isContentMode ? SEARCH_LOAD_MORE_STEP_CONTENT : SEARCH_LOAD_MORE_STEP;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisibleSearchCount((count) => Math.min(count + step, totalLength));
    }, { rootMargin: '160px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [queryLower, searchEntries.length, contentEntries.length, isContentMode]);

  const visibleRootEntries = useMemo(() => {
    if (!rootEntries) return undefined;
    if (!queryLower) return directoriesOnly ? rootEntries.filter((node) => node.type === 'directory') : rootEntries;
    const cache = useSidebarStore.getState().directoryCache;
    return rootEntries.filter((node) => (!directoriesOnly || node.type === 'directory') && hasMatchingDescendant(node, queryLower, cache));
  }, [directoriesOnly, queryLower, rootEntries]);

  if (!rootPath) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        {t('fileTree.noWorkingDir')}
      </div>
    );
  }

  if (loading || !sortModeReady) {
    return (
      <div className="flex items-center justify-center py-8">
        <RiLoader size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (queryLower && isContentMode) {
    const foundCount = searchMeta?.total ?? contentEntries.length;
    const displayedEntries = contentEntries.slice(0, visibleSearchCount);
    const hasBufferedMore = visibleSearchCount < contentEntries.length;
    return (
      <div className="termdock-native-select min-h-full space-y-px bg-surface px-2 py-2">
        <SearchResultsHeader count={foundCount} loading={searchLoading} engine={searchMeta?.engine} limited={searchMeta?.limited} scope={activeSearchRoot} content />
        {searchError ? (
          <div className="mx-1 mt-3 rounded-xl border border-border/15 bg-surface-2 px-4 py-5 text-center text-sm text-muted-foreground">
            {t('fileTree.contentSearchNeedsRipgrep')}
            <div className="mt-1 break-words text-[11px] text-muted-foreground/70">{searchError}</div>
          </div>
        ) : searchLoading && contentEntries.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <RiLoader size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : contentEntries.length === 0 ? (
          <div className="mx-1 mt-3 overflow-hidden rounded-xl border border-border/15 bg-surface-2 px-4 py-8 text-center text-sm text-muted-foreground">
            {t('fileTree.noContentMatches')}
          </div>
        ) : (
          <>
            {searchMeta?.limited && (
              <div className="mb-2 rounded-xl bg-[rgb(var(--warning-rgb)_/_0.12)] px-3 py-2 text-[11px] text-[color:var(--warning)]">
                {t('fileTree.searchTruncatedHint', { count: searchMeta.total })}
              </div>
            )}
            {displayedEntries.map((entry) => (
              <ContentSearchResultItem
                key={entry.path}
                entry={entry}
                rootPath={activeSearchRoot}
                selectedFilePath={selectedFilePath}
                query={query.trim()}
                onContentMatchSelect={onContentMatchSelect}
                onPathReference={onPathReference}
                getReferenceText={getReferenceText}
                onReferenceCopied={onReferenceCopied}
                insertedReferenceKey={insertedReferenceKey}
                copiedReferenceKey={copiedReferenceKey}
              />
            ))}
            <div ref={loadMoreRef} className="py-2 text-center text-[11px] text-muted-foreground">
              {hasBufferedMore ? (
                <button
                  type="button"
                  onClick={() => setVisibleSearchCount((count) => Math.min(count + SEARCH_LOAD_MORE_STEP_CONTENT, contentEntries.length))}
                  className="rounded-full bg-surface-2 px-3 py-1 hover:bg-surface-elevated hover:text-foreground"
                >
                  {t('fileTree.loadMoreSearchResults', { shown: displayedEntries.length, total: contentEntries.length })}
                </button>
              ) : searchLoading ? (
                <span className="inline-flex items-center gap-1"><RiLoader size={10} className="animate-spin" />{t('fileTree.searchStillRunning')}</span>
              ) : displayedEntries.length > 0 ? (
                <span>{t('fileTree.showingSearchResults', { shown: displayedEntries.length, total: foundCount })}</span>
              ) : null}
            </div>
          </>
        )}
      </div>
    );
  }

  if (queryLower) {
    const foundCount = searchMeta?.total ?? searchEntries.length;
    const displayedSearchEntries = searchEntries.slice(0, visibleSearchCount);
    const hasBufferedMore = visibleSearchCount < searchEntries.length;
    return (
      <div className="termdock-native-select min-h-full space-y-px bg-surface px-2 py-2">
        <SearchResultsHeader count={foundCount} loading={searchLoading} engine={searchMeta?.engine} limited={searchMeta?.limited} scope={activeSearchRoot} content={false} />
        {searchLoading && searchEntries.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <RiLoader size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : searchError ? (
          <div className="px-4 py-4 text-sm text-destructive">{searchError}</div>
        ) : searchEntries.length === 0 ? (
          <div className="mx-1 mt-3 overflow-hidden rounded-xl border border-border/15 bg-surface-2 px-4 py-8 text-center text-sm text-muted-foreground">
            {t('fileTree.noMatchingFiles')}
          </div>
        ) : (
          <>
            {searchMeta?.limited && (
              <div className="mb-2 rounded-xl bg-[rgb(var(--warning-rgb)_/_0.12)] px-3 py-2 text-[11px] text-[color:var(--warning)]">
                {t('fileTree.searchTruncatedHint', { count: searchMeta.total })}
              </div>
            )}
            {displayedSearchEntries.map((node) => (
              <FileSearchResultItem
                key={node.path}
                node={node}
                rootPath={activeSearchRoot}
                onFileSelect={onFileSelect}
                onPathReference={onPathReference}
                getReferenceText={getReferenceText}
                onReferenceCopied={onReferenceCopied}
                onDirectoryRoot={onDirectoryRoot}
                onSearchFromDirectory={onSearchFromDirectory}
                onDirectoryPinToggle={onDirectoryPinToggle}
                onFilePinToggle={onFilePinToggle}
                pinnedPaths={pinnedPaths}
                selectedFilePath={selectedFilePath}
                insertedReferenceKey={insertedReferenceKey}
                copiedReferenceKey={copiedReferenceKey}
                onFileDeleteRequest={handleFileDeleteRequest}
                deletingFilePath={deletingFilePath}
              />
            ))}
            <div ref={loadMoreRef} className="py-2 text-center text-[11px] text-muted-foreground">
              {hasBufferedMore ? (
                <button
                  type="button"
                  onClick={() => setVisibleSearchCount((count) => Math.min(count + SEARCH_LOAD_MORE_STEP, searchEntries.length))}
                  className="rounded-full bg-surface-2 px-3 py-1 hover:bg-surface-elevated hover:text-foreground"
                >
                  {t('fileTree.loadMoreSearchResults', { shown: displayedSearchEntries.length, total: searchEntries.length })}
                </button>
              ) : searchLoading ? (
                <span className="inline-flex items-center gap-1"><RiLoader size={10} className="animate-spin" />{t('fileTree.searchStillRunning')}</span>
              ) : displayedSearchEntries.length > 0 ? (
                <span>{t('fileTree.showingSearchResults', { shown: displayedSearchEntries.length, total: foundCount })}</span>
              ) : null}
            </div>
          </>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-4 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!rootEntries || rootEntries.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        {t('fileTree.emptyDir')}
      </div>
    );
  }

  if (!visibleRootEntries || visibleRootEntries.length === 0) {
    return (
      <div className="mx-3 mt-3 overflow-hidden rounded-xl border border-border/15 bg-surface-2 px-4 py-8 text-center text-sm text-muted-foreground">
        {t('fileTree.noMatchingFiles')}
      </div>
    );
  }

  return (
    <div className="termdock-native-select space-y-px px-2 py-2">
      {rootTruncated && (
        <div className="mb-2 rounded-xl bg-[rgb(var(--warning-rgb)_/_0.12)] px-3 py-2 text-[11px] text-[color:var(--warning)]">
          {t('fileTree.truncatedHint')}
        </div>
      )}
      {visibleRootEntries.map((node) => (
        <FileTreeItem
          key={node.path}
          node={node}
          depth={0}
          onFileSelect={onFileSelect}
          directoriesOnly={directoriesOnly}
          onPathReference={onPathReference}
          getReferenceText={getReferenceText}
          onReferenceCopied={onReferenceCopied}
          onDirectoryRoot={onDirectoryRoot}
          onSearchFromDirectory={onSearchFromDirectory}
          onDirectoryPinToggle={onDirectoryPinToggle}
          onFilePinToggle={onFilePinToggle}
          onOpenInFileBrowser={onOpenInFileBrowser}
          canOpenInFileBrowser={canOpenInFileBrowser}
          pinnedPaths={pinnedPaths}
          selectedFilePath={selectedFilePath}
          queryLower={queryLower}
          insertedReferenceKey={insertedReferenceKey}
          copiedReferenceKey={copiedReferenceKey}
          onDirectoryDropFiles={onDirectoryDropFiles}
          onFileDeleteRequest={handleFileDeleteRequest}
          deletingFilePath={deletingFilePath}
          revealedDirectoryPath={revealDirectory?.path}
        />
      ))}
    </div>
  );
}
