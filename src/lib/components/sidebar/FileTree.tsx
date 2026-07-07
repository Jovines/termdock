import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight as RiChevronRight,
  ChevronDown as RiChevronDown,
  Folder as RiFolder,
  FolderOpen as RiFolderOpen,
  File as RiFile,
  FileCode as RiFileCode,
  Loader2 as RiLoader,
  Pin as RiPin,
  PinOff as RiPinOff,
  MoreHorizontal as RiMoreHorizontal,
  Link2 as RiLink,
} from 'lucide-react';
import { useSidebarStore, type FileTreeNode } from '../../stores/useSidebarStore';
import { cancelIoSlot, listDirectory, searchFilesStream, type FileEntry, type FileSearchEngine, type FileContentSearchEntry, type FileSearchMode } from '../../terminal/api';
import { useI18n } from '../../i18n';
import { useReferenceLongPressCopy } from './referenceLongPress';

interface FileTreeProps {
  rootPath: string;
  onFileSelect: (path: string) => void;
  onPathReference?: (path: string, key?: string) => void;
  getReferenceText?: (path: string) => string;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  onDirectoryRoot?: (path: string) => void;
  onDirectoryPinToggle?: (path: string) => void;
  onFilePinToggle?: (path: string) => void;
  pinnedPaths?: Set<string>;
  selectedFilePath: string | null;
  query?: string;
  searchMode?: FileSearchMode;
  onContentMatchSelect?: (path: string, line: number) => void;
}

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt', '.sh', '.css', '.scss', '.html', '.json', '.yaml', '.yml', '.toml', '.md']);
const SEARCH_INITIAL_VISIBLE = 120;
const SEARCH_LOAD_MORE_STEP = 120;
const EMPTY_PINNED_PATHS = new Set<string>();

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
  if (visible) return 'ml-1 min-w-8 px-2 opacity-100';
  return 'ml-1 min-w-8 px-2 opacity-100 sm:ml-0 sm:w-0 sm:min-w-0 sm:overflow-hidden sm:px-0 sm:opacity-0 sm:group-hover:ml-1 sm:group-hover:w-auto sm:group-hover:min-w-8 sm:group-hover:px-2 sm:group-hover:opacity-100';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function hasNativeTextSelection(): boolean {
  if (typeof window === 'undefined') return false;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
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
  onPathReference?: (path: string, key?: string) => void;
  getReferenceText?: (path: string) => string;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  onDirectoryRoot?: (path: string) => void;
  onDirectoryPinToggle?: (path: string) => void;
  onFilePinToggle?: (path: string) => void;
  pinnedPaths: Set<string>;
  selectedFilePath: string | null;
  queryLower: string;
}

const FileTreeItem = memo(function FileTreeItem({
  node,
  depth,
  onFileSelect,
  onPathReference,
  getReferenceText,
  onReferenceCopied,
  insertedReferenceKey,
  copiedReferenceKey,
  onDirectoryRoot,
  onDirectoryPinToggle,
  onFilePinToggle,
  pinnedPaths,
  selectedFilePath,
  queryLower,
}: FileTreeItemProps) {
  const { t } = useI18n();
  // 精确订阅：每个节点只关心和自己相关的字段
  const isExpanded = useSidebarStore((s) => s.expandedPaths.has(node.path));
  const children = useSidebarStore((s) => s.directoryCache.get(node.path));
  const showHiddenFiles = useSidebarStore((s) => s.showHiddenFiles);
  const toggleExpanded = useSidebarStore((s) => s.toggleExpanded);
  const setDirectoryCache = useSidebarStore((s) => s.setDirectoryCache);
  const [loading, setLoading] = useState(false);
  const [directoryActionsOpen, setDirectoryActionsOpen] = useState(false);
  const loadAbortRef = useRef<AbortController | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const isSelected = node.path === selectedFilePath;
  const showChildren = node.type === 'directory' && (isExpanded || Boolean(queryLower));
  const isDirectory = node.type === 'directory';
  const isPinned = pinnedPaths.has(node.path);
  const canPinFile = !isDirectory && Boolean(onFilePinToggle);
  const referenceKey = `path:${node.path}`;
  const referenceInserted = insertedReferenceKey === referenceKey;
  const referenceCopied = copiedReferenceKey === referenceKey;
  const referenceText = getReferenceText?.(node.path) ?? node.path;
  const getReferenceLongPressHandlers = useReferenceLongPressCopy(onReferenceCopied);

  const visibleChildren = useMemo(() => {
    if (!children) return undefined;
    if (!queryLower) return children;
    // 搜索过滤需要查 directoryCache 的孙节点 — 这里读一次就够，
    // 不会触发额外订阅（getState 不订阅）。
    const cache = useSidebarStore.getState().directoryCache;
    return children.filter((child) => hasMatchingDescendant(child, queryLower, cache));
  }, [children, queryLower]);

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
        const result = await listDirectory(node.path, controller.signal, showHiddenFiles, 'expand_directory', requestSlotId);
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
  }, [node.path, loading, setDirectoryCache, showHiddenFiles]);

  const handleToggle = useCallback(async () => {
    if (node.type !== 'directory') {
      onFileSelect(node.path);
      return;
    }

    const willExpand = !useSidebarStore.getState().expandedPaths.has(node.path);
    toggleExpanded(node.path);
    if (willExpand) await loadChildren();
  }, [node.path, node.type, loadChildren, toggleExpanded, onFileSelect]);

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
    setDirectoryActionsOpen(false);
  }, [node.path, onDirectoryRoot]);

  const handleDirectoryPinClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onDirectoryPinToggle?.(node.path);
    setDirectoryActionsOpen(false);
  }, [node.path, onDirectoryPinToggle]);

  const handleFilePinClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onFilePinToggle?.(node.path);
  }, [node.path, onFilePinToggle]);

  const handleDirectoryMoreClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setDirectoryActionsOpen((open) => !open);
  }, []);

  useEffect(() => {
    if (!directoryActionsOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && actionMenuRef.current?.contains(target)) return;
      setDirectoryActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDirectoryActionsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [directoryActionsOpen]);

  useEffect(() => () => {
    loadAbortRef.current?.abort();
  }, []);

  return (
    <div ref={actionMenuRef} className="relative">
      {getReferenceLongPressHandlers.popoverNode}
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (hasNativeTextSelection()) return;
          void handleToggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          void handleToggle();
        }}
        className={`group flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1 text-[13px] ${
          isSelected
            ? 'bg-surface-elevated text-foreground'
            : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
        }`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        title={node.path}
      >
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
        <span className={`min-w-0 flex-1 select-text whitespace-normal break-all text-left leading-snug ${isSelected ? 'font-medium' : ''}`} data-sidebar-gesture-ignore>
          {node.name}
          {node.isSymlink && (
            <span className="ml-1 inline-flex align-middle text-muted-foreground/70" title="Symbolic link">
              <RiLink size={11} />
            </span>
          )}
        </span>
        {loading && <RiLoader size={12} className="shrink-0 animate-spin text-muted-foreground" />}
        <ChangeBadge path={node.path} />
        {node.type === 'directory' && (onDirectoryRoot || onDirectoryPinToggle) && (
          <span
            onClick={handleDirectoryMoreClick}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-muted-foreground transition active:scale-95 ${iconActionVisibilityClass(directoryActionsOpen)} ${directoryActionsOpen ? 'bg-surface-elevated text-foreground' : 'bg-surface-2 hover:bg-surface-elevated hover:text-foreground'}`}
            title={t('fileTree.moreDirActions')}
          >
            <RiMoreHorizontal size={13} />
          </span>
        )}
        {canPinFile && (
          <span
            onClick={handleFilePinClick}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full transition active:scale-95 ${iconActionVisibilityClass(isPinned)} ${isPinned ? 'bg-primary/15 text-primary' : 'text-muted-foreground bg-surface-2 hover:bg-surface-elevated hover:text-foreground'}`}
            title={isPinned ? t('fileTree.unpinFileTitle') : t('fileTree.pinFileTitle')}
          >
            {isPinned ? <RiPinOff size={12} /> : <RiPin size={12} />}
          </span>
        )}
        {onPathReference && (
          <span
            onClick={handleReferenceClick}
            {...getReferenceLongPressHandlers(referenceText, referenceKey)}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-[11px] font-semibold transition active:scale-95 ${textActionVisibilityClass(referenceInserted || referenceCopied)} ${referenceInserted || referenceCopied ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary'}`}
            title={t('fileTree.insertRefTitle')}
          >
            {referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('fileTree.insertRef')}
          </span>
        )}
      </div>

      {node.type === 'directory' && directoryActionsOpen && (onDirectoryRoot || onDirectoryPinToggle) && (
        <div className="absolute right-2 top-[calc(100%+2px)] z-30 w-44 overflow-hidden rounded-xl border border-border/15 bg-surface/98 p-1 text-[12px] shadow-xl shadow-[0_18px_48px_var(--app-shadow-soft)] backdrop-blur animate-fade-in">
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
        </div>
      )}

      {showChildren && visibleChildren && visibleChildren.length > 0 && (
        <div className={depth === 0 ? 'mt-0.5' : ''}>
          {visibleChildren.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              onFileSelect={onFileSelect}
              onPathReference={onPathReference}
              getReferenceText={getReferenceText}
              onReferenceCopied={onReferenceCopied}
              onDirectoryRoot={onDirectoryRoot}
              onDirectoryPinToggle={onDirectoryPinToggle}
              onFilePinToggle={onFilePinToggle}
              pinnedPaths={pinnedPaths}
              selectedFilePath={selectedFilePath}
              queryLower={queryLower}
              insertedReferenceKey={insertedReferenceKey}
              copiedReferenceKey={copiedReferenceKey}
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
  onDirectoryPinToggle?: (path: string) => void;
  onFilePinToggle?: (path: string) => void;
  pinnedPaths: Set<string>;
  selectedFilePath: string | null;
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
  onDirectoryPinToggle,
  onFilePinToggle,
  pinnedPaths,
  selectedFilePath,
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
  const [directoryActionsOpen, setDirectoryActionsOpen] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);

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
    setDirectoryActionsOpen(false);
  }, [node.path, onDirectoryPinToggle]);

  const handleFilePinClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onFilePinToggle?.(node.path);
  }, [node.path, onFilePinToggle]);

  const handleDirectoryMoreClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setDirectoryActionsOpen((open) => !open);
  }, []);

  useEffect(() => {
    if (!directoryActionsOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && actionMenuRef.current?.contains(target)) return;
      setDirectoryActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDirectoryActionsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [directoryActionsOpen]);

  return (
    <div ref={actionMenuRef} className="relative">
      {getReferenceLongPressHandlers.popoverNode}
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          handleClick();
        }}
        className={`group flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-left text-[13px] ${
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
        <span className="min-w-0 flex-1 select-text" data-sidebar-gesture-ignore>
          <span className={`block whitespace-normal break-all leading-snug ${isSelected ? 'font-medium' : ''}`}>
            {node.name}
            {node.isSymlink && (
              <span className="ml-1 inline-flex align-middle text-muted-foreground/70" title="Symbolic link">
                <RiLink size={11} />
              </span>
            )}
          </span>
          <span className="block truncate text-[10px] text-muted-foreground/70">{getRelativePath(rootPath, node.path)}</span>
        </span>
        <ChangeBadge path={node.path} />
        {node.type === 'directory' && onDirectoryPinToggle && (
          <span
            onClick={handleDirectoryMoreClick}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-muted-foreground transition active:scale-95 ${iconActionVisibilityClass(directoryActionsOpen)} ${directoryActionsOpen ? 'bg-surface-elevated text-foreground' : 'bg-surface-2 hover:bg-surface-elevated hover:text-foreground'}`}
            title={t('fileTree.moreDirActions')}
          >
            <RiMoreHorizontal size={13} />
          </span>
        )}
        {canPinFile && (
          <span
            onClick={handleFilePinClick}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full transition active:scale-95 ${iconActionVisibilityClass(isPinned)} ${isPinned ? 'bg-primary/15 text-primary' : 'text-muted-foreground bg-surface-2 hover:bg-surface-elevated hover:text-foreground'}`}
            title={isPinned ? t('fileTree.unpinFileTitle') : t('fileTree.pinFileTitle')}
          >
            {isPinned ? <RiPinOff size={12} /> : <RiPin size={12} />}
          </span>
        )}
        {onPathReference && (
          <span
            onClick={handleReferenceClick}
            {...getReferenceLongPressHandlers(referenceText, referenceKey)}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-[11px] font-semibold transition active:scale-95 ${textActionVisibilityClass(referenceInserted || referenceCopied)} ${referenceInserted || referenceCopied ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary'}`}
            title={t('fileTree.insertRefTitle')}
          >
            {referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('fileTree.insertRef')}
          </span>
        )}
      </div>
      {node.type === 'directory' && directoryActionsOpen && (onDirectoryRoot || onDirectoryPinToggle) && (
        <div className="absolute right-2 top-[calc(100%+2px)] z-30 w-44 overflow-hidden rounded-xl border border-border/15 bg-surface/98 p-1 text-[12px] shadow-xl shadow-[0_18px_48px_var(--app-shadow-soft)] backdrop-blur animate-fade-in">
          {onDirectoryRoot && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDirectoryRoot(node.path);
                setDirectoryActionsOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium text-foreground transition hover:bg-surface-2 active:scale-[0.99]"
              title={t('fileTree.openDirRootTitle')}
            >
              <RiFolderOpen size={13} className="shrink-0 text-[color:var(--folder)]" />
              <span className="min-w-0 flex-1 truncate">{t('fileTree.openDirRoot')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleDirectoryPinClick}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium transition active:scale-[0.99] ${isPinned ? 'text-primary hover:bg-primary/10' : 'text-foreground hover:bg-surface-2'}`}
            title={isPinned ? t('fileTree.unpinDirTitle') : t('fileTree.pinDirTitle')}
          >
            {isPinned ? <RiPinOff size={13} className="shrink-0" /> : <RiPin size={13} className="shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{isPinned ? t('fileTree.unpinDir') : t('fileTree.pinDir')}</span>
          </button>
        </div>
      )}
    </div>
  );
});

const SEARCH_INITIAL_VISIBLE_CONTENT = 60;
const SEARCH_LOAD_MORE_STEP_CONTENT = 60;
const MAX_VISIBLE_MATCHES_PER_FILE = 20;

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
    <div className="rounded">
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
        className={`group flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-left text-[13px] ${
          isSelected ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
        }`}
        title={entry.path}
      >
        {expanded ? <RiChevronDown size={14} className="shrink-0 text-muted-foreground/80" /> : <RiChevronRight size={14} className="shrink-0 text-muted-foreground/80" />}
        <span className={isSelected ? 'text-primary' : 'text-muted-foreground/80'}>{getFileIcon(entry.name, 'file')}</span>
        <span className="min-w-0 flex-1 select-text" data-sidebar-gesture-ignore>
          <span className="block whitespace-normal break-all font-medium leading-snug">{entry.name}</span>
          <span className="block truncate text-[10px] text-muted-foreground/70">{getRelativePath(rootPath, entry.path)}</span>
        </span>
        <span className="shrink-0 select-none rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{entry.matches.length}</span>
        {onPathReference && (
          <span
            onClick={(event) => {
              event.stopPropagation();
              onPathReference(entry.path, referenceKey);
            }}
            {...getReferenceLongPressHandlers(referenceText, referenceKey)}
            className={`inline-flex h-6 shrink-0 select-none items-center justify-center rounded-full text-[11px] font-semibold transition active:scale-95 ${textActionVisibilityClass(referenceInserted || referenceCopied)} ${referenceInserted || referenceCopied ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary'}`}
            title={t('fileTree.insertRefTitle')}
          >
            {referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('fileTree.insertRef')}
          </span>
        )}
      </div>
      {expanded && (
        <div className="ml-3 border-l border-border/15 pl-1">
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
              <span className="min-w-0 flex-1 truncate whitespace-pre select-text" data-sidebar-gesture-ignore>{highlightMatch(match.text, query)}</span>
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

export function FileTree({ rootPath, onFileSelect, onPathReference, getReferenceText, onReferenceCopied, insertedReferenceKey, copiedReferenceKey, onDirectoryRoot, onDirectoryPinToggle, onFilePinToggle, pinnedPaths = EMPTY_PINNED_PATHS, selectedFilePath, query = '', searchMode = 'name', onContentMatchSelect }: FileTreeProps) {
  const { t } = useI18n();
  // 只订阅根目录条目 — 其他树节点变化不重渲染 FileTree 容器
  const rootEntries = useSidebarStore((s) => (rootPath ? s.directoryCache.get(rootPath) : undefined));
  const setDirectoryCache = useSidebarStore((s) => s.setDirectoryCache);
  const showHiddenFiles = useSidebarStore((s) => s.showHiddenFiles);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rootTruncated, setRootTruncated] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchEntries, setSearchEntries] = useState<FileTreeNode[]>([]);
  const [searchMeta, setSearchMeta] = useState<{ truncated: boolean; total: number; engine: FileSearchEngine; limited: boolean; done: boolean } | null>(null);
  const [visibleSearchCount, setVisibleSearchCount] = useState(SEARCH_INITIAL_VISIBLE);
  const [contentEntries, setContentEntries] = useState<FileContentSearchEntry[]>([]);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const queryLower = query.trim().toLowerCase();
  const isContentMode = searchMode === 'content';

  // Load root directory
  useEffect(() => {
    if (!rootPath) return;
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

    listDirectory(rootPath, controller.signal, showHiddenFiles, 'load_file_tree_root', `file-tree-root:${rootPath}`)
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
  }, [queryLower, rootEntries, rootPath, setDirectoryCache, showHiddenFiles]);

  useEffect(() => {
    if (!rootPath || !queryLower) {
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

    const requestSlotId = `file-search:${rootPath}`;
    searchFilesStream(rootPath, query.trim(), (progress) => {
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
    }, controller.signal, showHiddenFiles, searchMode, requestSlotId)
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
  }, [query, queryLower, rootPath, showHiddenFiles, searchMode, isContentMode]);

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
    if (!queryLower) return rootEntries;
    const cache = useSidebarStore.getState().directoryCache;
    return rootEntries.filter((node) => hasMatchingDescendant(node, queryLower, cache));
  }, [queryLower, rootEntries]);

  if (!rootPath) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        {t('fileTree.noWorkingDir')}
      </div>
    );
  }

  if (loading) {
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
      <div className="termdock-native-select space-y-px px-2 py-2">
        <div className="mb-2 flex items-center justify-between gap-2 px-1 text-[10px] text-muted-foreground">
          <span>{searchLoading ? t('fileTree.searchingWithCount', { count: foundCount }) : t('fileTree.contentMatchesCount', { count: foundCount })}</span>
          {searchMeta && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 uppercase tracking-[0.12em]">
              {searchLoading && <RiLoader size={9} className="animate-spin" />}
              {searchMeta.engine}{searchMeta.limited ? ' · limited' : ''}
            </span>
          )}
        </div>
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
                rootPath={rootPath}
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
      <div className="termdock-native-select space-y-px px-2 py-2">
        <div className="mb-2 flex items-center justify-between gap-2 px-1 text-[10px] text-muted-foreground">
          <span>{searchLoading ? t('fileTree.searchingWithCount', { count: foundCount }) : t('fileTree.searchResults', { count: foundCount })}</span>
          {searchMeta && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 uppercase tracking-[0.12em]">
              {searchLoading && <RiLoader size={9} className="animate-spin" />}
              {searchMeta.engine}{searchMeta.limited ? ' · limited' : ''}
            </span>
          )}
        </div>
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
                rootPath={rootPath}
                onFileSelect={onFileSelect}
                onPathReference={onPathReference}
                getReferenceText={getReferenceText}
                onReferenceCopied={onReferenceCopied}
                onDirectoryRoot={onDirectoryRoot}
                onDirectoryPinToggle={onDirectoryPinToggle}
                onFilePinToggle={onFilePinToggle}
                pinnedPaths={pinnedPaths}
                selectedFilePath={selectedFilePath}
                insertedReferenceKey={insertedReferenceKey}
                copiedReferenceKey={copiedReferenceKey}
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
          onPathReference={onPathReference}
          getReferenceText={getReferenceText}
          onReferenceCopied={onReferenceCopied}
          onDirectoryRoot={onDirectoryRoot}
          onDirectoryPinToggle={onDirectoryPinToggle}
          onFilePinToggle={onFilePinToggle}
          pinnedPaths={pinnedPaths}
          selectedFilePath={selectedFilePath}
          queryLower={queryLower}
          insertedReferenceKey={insertedReferenceKey}
          copiedReferenceKey={copiedReferenceKey}
        />
      ))}
    </div>
  );
}
