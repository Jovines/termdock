import { useEffect, useCallback } from 'react';
import {
  X as RiCloseLine,
  Folder as RiFolder,
  GitCompare as RiGitCompare,
} from 'lucide-react';
import { Sidebar } from './Sidebar';
import { FileTree } from './FileTree';
import { DiffViewer } from './DiffViewer';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { getDiffFileList } from '../../terminal/api';

interface RightSidebarProps {
  isOpen: boolean;
  drawerWidthPx: number;
  onClose: () => void;
  onOpen?: () => void;
  push?: boolean;
}

export function RightSidebar(
  { isOpen, drawerWidthPx, onClose, onOpen, push }: RightSidebarProps,
) {
  const {
    rightTab,
    setRightTab,
    rootPath,
    selectedFilePath,
    selectFile,
    changedFiles,
    setChangedFiles,
  } = useSidebarStore();

  // Load changed files when sidebar opens
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    getDiffFileList(rootPath ?? undefined)
      .then((result) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const f of result.files) {
          map.set(f.path, f.status);
        }
        setChangedFiles(map);
      })
      .catch(() => {
        // Not a git repo or git not available — that's fine
      });
    return () => { cancelled = true; };
  }, [isOpen, rootPath, setChangedFiles]);

  const handleFileSelect = useCallback((path: string) => {
    selectFile(path);
    setRightTab('diff');
  }, [selectFile, setRightTab]);

  return (
    <Sidebar
      side="right"
      isOpen={isOpen}
      drawerWidthPx={drawerWidthPx}
      onClose={onClose}
      onOpen={onOpen}
      push={push}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/15 px-4 py-3">
        <div className="min-w-0">
          <div className="ui-kicker">Explorer</div>
          <h2 className="section-title mt-0.5">
            {rightTab === 'files' ? 'Files' : 'Diff'}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
          aria-label="Close"
        >
          <RiCloseLine size={18} />
        </button>
      </div>

      {/* Tab bar */}
      <div className="shrink-0 border-b border-border/15 px-3 py-2">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setRightTab('files')}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
              rightTab === 'files'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-surface-2'
            }`}
          >
            <RiFolder size={13} />
            Files
            {changedFiles.size > 0 && (
              <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent/20 text-[10px] text-accent">
                {changedFiles.size}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setRightTab('diff')}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
              rightTab === 'diff'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-surface-2'
            }`}
          >
            <RiGitCompare size={13} />
            Diff
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rightTab === 'files' ? (
          <FileTree
            rootPath={rootPath ?? ''}
            onFileSelect={handleFileSelect}
            selectedFilePath={selectedFilePath}
          />
        ) : (
          <DiffViewer filePath={selectedFilePath} />
        )}
      </div>
    </Sidebar>
  );
}
