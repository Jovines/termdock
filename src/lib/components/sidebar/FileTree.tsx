import { useCallback, useEffect, useState } from 'react';
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
}

function getFileIcon(name: string, type: 'file' | 'directory' | 'symlink') {
  if (type === 'directory') return null; // handled separately
  const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt', '.sh', '.css', '.scss', '.html', '.json', '.yaml', '.yml', '.toml', '.md']);
  const ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')) : '';
  return codeExts.has(ext) ? <RiFileCode size={14} /> : <RiFile size={14} />;
}

function getChangeStatusBadge(path: string, changedFiles: Map<string, string>) {
  const status = changedFiles.get(path);
  if (!status) return null;
  const label = status === 'modified' ? 'M' : status === 'added' ? 'A' : status === 'deleted' ? 'D' : 'R';
  const color = status === 'added' ? 'text-green-400' : status === 'deleted' ? 'text-red-400' : status === 'renamed' ? 'text-yellow-400' : 'text-accent';
  return <span className={`text-[10px] font-mono font-bold ${color}`}>{label}</span>;
}

function FileTreeItem({
  node,
  depth,
  onFileSelect,
  selectedFilePath,
  changedFiles,
}: {
  node: FileTreeNode;
  depth: number;
  onFileSelect: (path: string) => void;
  selectedFilePath: string | null;
  changedFiles: Map<string, string>;
}) {
  const { expandedPaths, toggleExpanded, directoryCache, setDirectoryCache } = useSidebarStore();
  const [loading, setLoading] = useState(false);
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = node.path === selectedFilePath;
  const children = directoryCache.get(node.path);

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
        className={`w-full flex items-center gap-1 py-1 px-2 text-[13px] rounded-md transition ${
          isSelected
            ? 'bg-primary/15 text-primary'
            : 'text-foreground hover:bg-surface-2'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {node.type === 'directory' ? (
          <>
            {isExpanded ? <RiChevronDown size={14} className="shrink-0" /> : <RiChevronRight size={14} className="shrink-0" />}
            {isExpanded ? <RiFolderOpen size={14} className="shrink-0 text-yellow-500" /> : <RiFolder size={14} className="shrink-0 text-yellow-500" />}
          </>
        ) : (
          <>
            <span className="w-[14px] shrink-0" />
            {getFileIcon(node.name, node.type)}
          </>
        )}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {loading && <RiLoader size={12} className="shrink-0 animate-spin text-muted-foreground" />}
        {getChangeStatusBadge(node.path, changedFiles)}
      </button>

      {isExpanded && children && (
        <div>
          {children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              onFileSelect={onFileSelect}
              selectedFilePath={selectedFilePath}
              changedFiles={changedFiles}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ rootPath, onFileSelect, selectedFilePath }: FileTreeProps) {
  const { directoryCache, setDirectoryCache, changedFiles } = useSidebarStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="py-1">
      {rootEntries.map((node) => (
        <FileTreeItem
          key={node.path}
          node={node}
          depth={0}
          onFileSelect={onFileSelect}
          selectedFilePath={selectedFilePath}
          changedFiles={changedFiles}
        />
      ))}
    </div>
  );
}
