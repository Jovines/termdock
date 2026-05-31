import { useEffect, useCallback, useMemo, useState } from 'react';
import {
  X as RiCloseLine,
  Folder as RiFolder,
  GitCompare as RiGitCompare,
  Search as RiSearch,
  ListTree as RiListTree,
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

const CHANGE_BADGE_STYLES: Record<string, { label: string; className: string; title: string }> = {
  added: { label: 'A', className: 'text-[color:var(--diff-insert-strong)]', title: 'Added' },
  modified: { label: 'M', className: 'text-[color:var(--diff-hunk-accent)]', title: 'Modified' },
  deleted: { label: 'D', className: 'text-[color:var(--diff-delete-strong)]', title: 'Deleted' },
  renamed: { label: 'R', className: 'text-muted-foreground', title: 'Renamed' },
};

function getRelativeDisplayPath(path: string, rootPath: string | null): { name: string; dir: string } {
  const relative = rootPath && path.startsWith(`${rootPath}/`) ? path.slice(rootPath.length + 1) : path;
  const parts = relative.split('/').filter(Boolean);
  return {
    name: parts.pop() || relative,
    dir: parts.join('/'),
  };
}

function ChangeBadge({ status }: { status: string }) {
  const style = CHANGE_BADGE_STYLES[status] ?? { label: '?', className: 'text-muted-foreground', title: status };
  return (
    <span className={`w-4 shrink-0 text-center text-[10px] font-mono font-bold ${style.className}`} title={style.title}>
      {style.label}
    </span>
  );
}

export function RightSidebar(
  { isOpen, drawerWidthPx, onClose, onOpen, push }: RightSidebarProps,
) {
  const [fileQuery, setFileQuery] = useState('');
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
        if (result.files.length > 0 && !selectedFilePath) {
          setRightTab('diff');
        }
      })
      .catch(() => {
        // Not a git repo or git not available — that's fine
      });
    return () => { cancelled = true; };
  }, [isOpen, rootPath, selectedFilePath, setChangedFiles, setRightTab]);

  const handleFileSelect = useCallback((path: string) => {
    selectFile(path);
    setRightTab('diff');
  }, [selectFile, setRightTab]);

  const rootName = useMemo(() => {
    if (!rootPath) return 'Workspace';
    const normalized = rootPath.replace(/\/+$/, '');
    return normalized.split('/').pop() || normalized;
  }, [rootPath]);

  const changedSummary = useMemo(() => {
    const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, other: 0 };
    for (const status of changedFiles.values()) {
      if (status === 'added') counts.added += 1;
      else if (status === 'modified') counts.modified += 1;
      else if (status === 'deleted') counts.deleted += 1;
      else if (status === 'renamed') counts.renamed += 1;
      else counts.other += 1;
    }
    return counts;
  }, [changedFiles]);

  const filteredChangedFiles = useMemo(() => {
    const query = fileQuery.trim().toLowerCase();
    const entries = Array.from(changedFiles.entries()).sort(([a], [b]) => a.localeCompare(b));
    if (!query) return entries;
    return entries.filter(([path, status]) => `${path} ${status}`.toLowerCase().includes(query));
  }, [changedFiles, fileQuery]);

  const selectDiffFile = useCallback((path: string | null) => {
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
      <div className="shrink-0 border-b border-border/15 bg-surface px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="ui-kicker flex items-center gap-1.5">
              <RiListTree size={11} /> Workspace
            </div>
            <h2 className="section-title mt-0.5 truncate" title={rootPath ?? undefined}>
              {changedFiles.size > 0 ? `${changedFiles.size} changed` : rootName}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            aria-label="Close"
          >
            <RiCloseLine size={18} />
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-md border border-border/20 bg-background-subtle px-2.5 py-1.5 focus-within:border-primary/35">
          <RiSearch size={14} className="shrink-0 text-muted-foreground" />
          <input
            value={fileQuery}
            onChange={(event) => setFileQuery(event.target.value)}
            placeholder="Search changes or files"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {fileQuery && (
            <button
              type="button"
              onClick={() => setFileQuery('')}
              className="rounded p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
              aria-label="Clear search"
            >
              <RiCloseLine size={13} />
            </button>
          )}
        </div>

        {changedFiles.size > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-medium">
            {changedSummary.modified > 0 && <span className="text-[color:var(--diff-hunk-accent)]">{changedSummary.modified} mod</span>}
            {changedSummary.added > 0 && <span className="text-[color:var(--diff-insert-strong)]">{changedSummary.added} add</span>}
            {changedSummary.deleted > 0 && <span className="text-[color:var(--diff-delete-strong)]">{changedSummary.deleted} del</span>}
            {changedSummary.renamed > 0 && <span className="text-muted-foreground">{changedSummary.renamed} ren</span>}
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="shrink-0 border-b border-border/15 px-3 py-2">
        <div className="grid grid-cols-2 gap-1 rounded-md bg-background-subtle p-0.5">
          <button
            type="button"
            onClick={() => setRightTab('diff')}
            className={`flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${
              rightTab === 'diff'
                ? 'bg-surface-elevated text-foreground'
                : 'text-muted-foreground hover:bg-surface-2'
            }`}
          >
            <RiGitCompare size={13} />
            Changes
            {changedFiles.size > 0 && (
              <span className="text-[10px] text-accent">
                {changedFiles.size}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setRightTab('files')}
            className={`flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${
              rightTab === 'files'
                ? 'bg-surface-elevated text-foreground'
                : 'text-muted-foreground hover:bg-surface-2'
            }`}
          >
            <RiFolder size={13} />
            Files
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
            query={fileQuery}
          />
        ) : (
          <div className="flex min-h-full flex-col">
            {changedFiles.size > 0 && (
              <div className="shrink-0 border-b border-border/15 px-3 py-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => selectDiffFile(null)}
                    className={`rounded px-2 py-1 text-[11px] font-medium ${
                      selectedFilePath === null
                        ? 'bg-surface-elevated text-foreground'
                        : 'bg-background-subtle text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                    }`}
                  >
                    All changes
                  </button>
                  <span className="text-[10px] text-muted-foreground">{filteredChangedFiles.length}/{changedFiles.size}</span>
                </div>
                <div className="space-y-px">
                  {filteredChangedFiles.length === 0 ? (
                    <div className="bg-background-subtle px-3 py-4 text-center text-xs text-muted-foreground">
                      No matching changes.
                    </div>
                  ) : filteredChangedFiles.map(([path, status]) => {
                    const display = getRelativeDisplayPath(path, rootPath);
                    const isSelected = selectedFilePath === path;
                    return (
                      <button
                        key={path}
                        type="button"
                        onClick={() => selectDiffFile(path)}
                        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
                          isSelected
                            ? 'bg-surface-elevated text-foreground'
                            : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                        }`}
                        title={path}
                      >
                        <ChangeBadge status={status} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{display.name}</span>
                          {display.dir && <span className="block truncate text-[10px] text-muted-foreground/75">{display.dir}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <DiffViewer filePath={selectedFilePath} />
            </div>
          </div>
        )}
      </div>
    </Sidebar>
  );
}
