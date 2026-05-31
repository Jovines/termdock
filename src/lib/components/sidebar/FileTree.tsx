import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight as RiChevronRight,
  ChevronDown as RiChevronDown,
  Folder as RiFolder,
  FolderOpen as RiFolderOpen,
  File as RiFile,
  FileCode as RiFileCode,
  Loader2 as RiLoader,
} from 'lucide-react';
import { useSidebarStore, type FileTreeNode } from '../../stores/useSidebarStore';
import { listDirectory, type FileEntry } from '../../terminal/api';

interface FileTreeProps {
  rootPath: string;
  onFileSelect: (path: string) => void;
  selectedFilePath: string | null;
  query?: string;
}

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt', '.sh', '.css', '.scss', '.html', '.json', '.yaml', '.yml', '.toml', '.md']);

const CHANGE_STYLES: Record<string, { label: string; className: string; title: string }> = {
  added: { label: 'A', className: 'text-[color:var(--diff-insert-strong)]', title: 'Added' },
  modified: { label: 'M', className: 'text-[color:var(--diff-hunk-accent)]', title: 'Modified' },
  deleted: { label: 'D', className: 'text-[color:var(--diff-delete-strong)]', title: 'Deleted' },
  renamed: { label: 'R', className: 'text-muted-foreground', title: 'Renamed' },
};

function getFileIcon(name: string, type: 'file' | 'directory' | 'symlink') {
  if (type === 'directory') return null; // handled separately
  const ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')) : '';
  return CODE_EXTS.has(ext) ? <RiFileCode size={14} /> : <RiFile size={14} />;
}

function getChangeStatusBadge(path: string, changedFiles: Map<string, string>) {
  const status = changedFiles.get(path);
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

function FileTreeItem({
  node,
  depth,
  onFileSelect,
  selectedFilePath,
  changedFiles,
  queryLower,
}: {
  node: FileTreeNode;
  depth: number;
  onFileSelect: (path: string) => void;
  selectedFilePath: string | null;
  changedFiles: Map<string, string>;
  queryLower: string;
}) {
  const { expandedPaths, toggleExpanded, directoryCache, setDirectoryCache } = useSidebarStore();
  const [loading, setLoading] = useState(false);
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = node.path === selectedFilePath;
  const children = directoryCache.get(node.path);
  const showChildren = node.type === 'directory' && (isExpanded || Boolean(queryLower));
  const visibleChildren = useMemo(() => {
    if (!children) return undefined;
    if (!queryLower) return children;
    return children.filter((child) => hasMatchingDescendant(child, queryLower, directoryCache));
  }, [children, directoryCache, queryLower]);

  const handleToggle = useCallback(async () => {
    if (node.type !== 'directory') {
      onFileSelect(node.path);
      return;
    }

    toggleExpanded(node.path);

    // Lazy load children if not cached
    if (!directoryCache.has(node.path) && !loading) {
      setLoading(true);
      try {
        const result = await listDirectory(node.path);
        const treeNodes: FileTreeNode[] = result.entries.map((e: FileEntry) => ({
          name: e.name,
          path: e.path,
          type: e.type,
          expanded: false,
          loaded: false,
          children: e.type === 'directory' ? [] : undefined,
        }));
        setDirectoryCache(node.path, treeNodes);
      } catch {
        // Silently fail — user can retry by collapsing and re-expanding
      } finally {
        setLoading(false);
      }
    }
  }, [node.path, node.type, directoryCache.has(node.path), loading, toggleExpanded, setDirectoryCache, onFileSelect]);

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        className={`flex w-full items-center gap-1 rounded px-2 py-1 text-[13px] ${
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
            {showChildren ? <RiFolderOpen size={14} className="shrink-0 text-amber-300/85" /> : <RiFolder size={14} className="shrink-0 text-amber-300/80" />}
          </>
        ) : (
          <>
            <span className="w-[14px] shrink-0" />
            <span className={isSelected ? 'text-primary' : 'text-muted-foreground/80'}>
              {getFileIcon(node.name, node.type)}
            </span>
          </>
        )}
        <span className={`min-w-0 flex-1 truncate ${isSelected ? 'font-medium' : ''}`}>{node.name}</span>
        {loading && <RiLoader size={12} className="shrink-0 animate-spin text-muted-foreground" />}
        {getChangeStatusBadge(node.path, changedFiles)}
      </button>

      {showChildren && visibleChildren && visibleChildren.length > 0 && (
        <div className={depth === 0 ? 'mt-0.5' : ''}>
          {visibleChildren.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              onFileSelect={onFileSelect}
              selectedFilePath={selectedFilePath}
              changedFiles={changedFiles}
              queryLower={queryLower}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ rootPath, onFileSelect, selectedFilePath, query = '' }: FileTreeProps) {
  const { directoryCache, setDirectoryCache, changedFiles } = useSidebarStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryLower = query.trim().toLowerCase();

  // Load root directory
  useEffect(() => {
    if (!rootPath) return;
    if (directoryCache.has(rootPath)) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    listDirectory(rootPath)
      .then((result) => {
        if (cancelled) return;
        const treeNodes: FileTreeNode[] = result.entries.map((e: FileEntry) => ({
          name: e.name,
          path: e.path,
          type: e.type,
          expanded: false,
          loaded: false,
          children: e.type === 'directory' ? [] : undefined,
        }));
        setDirectoryCache(rootPath, treeNodes);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load directory');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [rootPath, directoryCache.has(rootPath), setDirectoryCache]);

  const rootEntries = rootPath ? directoryCache.get(rootPath) : undefined;
  const visibleRootEntries = useMemo(() => {
    if (!rootEntries) return undefined;
    if (!queryLower) return rootEntries;
    return rootEntries.filter((node) => hasMatchingDescendant(node, queryLower, directoryCache));
  }, [directoryCache, queryLower, rootEntries]);

  if (!rootPath) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        No working directory detected.
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
        Empty directory.
      </div>
    );
  }

  if (!visibleRootEntries || visibleRootEntries.length === 0) {
    return (
      <div className="mx-3 mt-3 border border-border/15 bg-background-subtle px-4 py-8 text-center text-sm text-muted-foreground">
        No matching files.
      </div>
    );
  }

  return (
    <div className="space-y-px px-2 py-2">
      {visibleRootEntries.map((node) => (
        <FileTreeItem
          key={node.path}
          node={node}
          depth={0}
          onFileSelect={onFileSelect}
          selectedFilePath={selectedFilePath}
          changedFiles={changedFiles}
          queryLower={queryLower}
        />
      ))}
    </div>
  );
}
