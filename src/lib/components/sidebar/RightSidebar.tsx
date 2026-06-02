import { useEffect, useCallback, useMemo, useState, useDeferredValue } from 'react';
import {
  X as RiCloseLine,
  Folder as RiFolder,
  GitCompare as RiGitCompare,
  Search as RiSearch,
  FileText as RiFileText,
  Copy as RiCopy,
  RefreshCw as RiRefresh,
  GitBranch as RiGitBranch,
} from 'lucide-react';
import { Sidebar } from './Sidebar';
import { FileTree } from './FileTree';
import { DiffViewer } from './DiffViewer';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { getGitBundle, readFileContent, type GitContext } from '../../terminal/api';

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

const RECENT_REFERENCES_STORAGE_KEY = 'termdock:recent-file-references';
const MAX_RECENT_REFERENCES = 8;

interface RecentReference {
  path: string;
  label: string;
}

function loadRecentReferences(): RecentReference[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_REFERENCES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentReference => (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as RecentReference).path === 'string' &&
        typeof (item as RecentReference).label === 'string'
      ))
      .slice(0, MAX_RECENT_REFERENCES);
  } catch {
    return [];
  }
}

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

function buildFileReference(path: string, rootPath: string | null): string {
  if (!rootPath || !path.startsWith(`${rootPath}/`)) return path;
  return path.slice(rootPath.length + 1);
}

function buildReferenceInputText(path: string, rootPath: string | null): string {
  const reference = buildFileReference(path, rootPath).replace(/^\.\//, '');
  return reference.includes(' ') ? `"${reference}" ` : `${reference} `;
}

function FilePreview({ filePath, onInsertReference }: { filePath: string | null; onInsertReference: (path: string) => void }) {
  const rootPath = useSidebarStore((s) => s.rootPath);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ size: number; truncated?: boolean } | null>(null);

  useEffect(() => {
    if (!filePath) return;
    const readablePath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent('');
    setMeta(null);
    readFileContent(readablePath)
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        setMeta({ size: result.size, truncated: result.truncated });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to read file');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [filePath, rootPath]);

  if (!filePath) {
    return <div className="mx-3 mt-3 border border-border/15 bg-background-subtle px-4 py-8 text-center text-sm text-muted-foreground">Select a file to preview.</div>;
  }

  const readablePath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
  const display = getRelativeDisplayPath(readablePath, rootPath);
  const reference = buildFileReference(readablePath, rootPath);

  return (
    <div className="flex min-h-full flex-col px-3 py-2">
      <div className="shrink-0 border-b border-border/15 px-1 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0" title={readablePath}>
            <div className="truncate text-sm font-medium text-foreground">{display.name}</div>
            {display.dir && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{display.dir}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onInsertReference(readablePath)}
              className="inline-flex h-9 items-center gap-1 rounded-full bg-primary/15 px-3 text-xs font-semibold text-primary transition hover:bg-primary/25 active:scale-95"
              title={`Insert reference: ${reference}`}
            >
              引用
            </button>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(reference)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-background-subtle text-muted-foreground transition hover:bg-surface-2 hover:text-foreground active:scale-95"
              title={`Copy reference: ${reference}`}
              aria-label="Copy file reference"
            >
              <RiCopy size={13} />
            </button>
          </div>
        </div>
        {meta && (
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>{meta.size.toLocaleString()} bytes</span>
            {meta.truncated && <span className="text-yellow-400">preview truncated to 1MB</span>}
          </div>
        )}
      </div>
      {loading ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">Loading file…</div>
      ) : error ? (
        <div className="mt-3 border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">{error}</div>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-background-subtle p-3 font-mono text-[11px] leading-relaxed text-foreground">
          {content || 'Empty file.'}
        </pre>
      )}
    </div>
  );
}

export function RightSidebar(
  { isOpen, drawerWidthPx, onClose, onOpen, push }: RightSidebarProps,
) {
  const [fileQuery, setFileQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const deferredFileQuery = useDeferredValue(fileQuery);
  const [gitContext, setGitContext] = useState<GitContext | null>(null);
  const [gitRefreshing, setGitRefreshing] = useState(false);
  const [lastInsertedReference, setLastInsertedReference] = useState<string | null>(null);
  const [recentReferences, setRecentReferences] = useState<RecentReference[]>(() => loadRecentReferences());
  // Wide mode: when the panel is at least 720px we switch to a dual-column
  // workspace (file list / tree on the left, content on the right) so users
  // don't have to jump between tabs to peek at a file's diff or content.
  const isWide = drawerWidthPx >= 720;
  const rightTab = useSidebarStore((s) => s.rightTab);
  const setRightTab = useSidebarStore((s) => s.setRightTab);
  const rootPath = useSidebarStore((s) => s.rootPath);
  const selectedFilePath = useSidebarStore((s) => s.selectedFilePath);
  const selectFile = useSidebarStore((s) => s.selectFile);
  const changedFiles = useSidebarStore((s) => s.changedFiles);
  const setChangedFiles = useSidebarStore((s) => s.setChangedFiles);

  const refreshGitState = useCallback(async () => {
    if (!rootPath) return;
    setGitRefreshing(true);
    try {
      const bundle = await getGitBundle(rootPath);
      const map = new Map<string, string>();
      for (const f of bundle.files) {
        map.set(f.absolutePath || f.path, f.status);
      }
      setChangedFiles(map);
      setGitContext(bundle.context);
      if (bundle.files.length > 0 && useSidebarStore.getState().selectedFilePath === null) {
        setRightTab('diff');
      }
    } catch {
      // Not a git repo or git not available — keep file explorer usable.
      setGitContext(null);
    } finally {
      setGitRefreshing(false);
    }
  }, [rootPath, setChangedFiles, setRightTab]);

  // Load changed files when sidebar opens — debounced to avoid bursts when
  // the user rapidly switches sessions / cwd. The server already caches
  // findGitRoot; this guards against React render-burst storms.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      setGitRefreshing(true);
      getGitBundle(rootPath ?? undefined)
        .then((bundle) => {
          if (cancelled) return;
          const map = new Map<string, string>();
          for (const f of bundle.files) {
            map.set(f.absolutePath || f.path, f.status);
          }
          setChangedFiles(map);
          setGitContext(bundle.context);
          if (bundle.files.length > 0 && useSidebarStore.getState().selectedFilePath === null) {
            setRightTab('diff');
          }
        })
        .catch(() => {
          if (!cancelled) setGitContext(null);
        })
        .finally(() => {
          if (!cancelled) setGitRefreshing(false);
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [isOpen, rootPath, setChangedFiles, setRightTab]);

  useEffect(() => {
    if (!isOpen) {
      setFileQuery('');
      setSearchOpen(false);
    }
  }, [isOpen]);

  const handleFileSelect = useCallback((path: string) => {
    selectFile(path);
    // In wide mode the preview is already visible alongside the tree, so we
    // don't need to switch tabs and steal focus from the user's browse flow.
    if (!isWide) setRightTab('file');
  }, [selectFile, setRightTab, isWide]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(RECENT_REFERENCES_STORAGE_KEY, JSON.stringify(recentReferences));
  }, [recentReferences]);

  const rememberReference = useCallback((absolutePath: string) => {
    const label = buildFileReference(absolutePath, rootPath);
    setRecentReferences((current) => [
      { path: absolutePath, label },
      ...current.filter((item) => item.path !== absolutePath),
    ].slice(0, MAX_RECENT_REFERENCES));
    return label;
  }, [rootPath]);

  const insertPathReference = useCallback((path: string) => {
    const absolutePath = rootPath && !path.startsWith('/') ? `${rootPath}/${path}` : path;
    const reference = rememberReference(absolutePath);
    window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
      detail: { text: buildReferenceInputText(absolutePath, rootPath) },
    }));
    setLastInsertedReference(reference);
    window.setTimeout(() => setLastInsertedReference((current) => (current === reference ? null : current)), 1400);
  }, [rememberReference, rootPath]);

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
    const query = deferredFileQuery.trim().toLowerCase();
    const entries = Array.from(changedFiles.entries()).sort(([a], [b]) => a.localeCompare(b));
    if (!query) return entries;
    return entries.filter(([path, status]) => `${path} ${status}`.toLowerCase().includes(query));
  }, [changedFiles, deferredFileQuery]);

  const gitContextText = useMemo(() => {
    if (!gitContext?.available) return '';
    const changed = (gitContext.changedFiles ?? []).map((file) => `- ${file.status} ${file.path}`).join('\n');
    const commits = (gitContext.recentCommits ?? []).map((commit) => `- ${commit}`).join('\n');
    return [
      `Git root: ${gitContext.root ?? rootPath ?? ''}`,
      `Branch: ${gitContext.branch ?? '(detached or unknown)'}`,
      changed ? `Changed files:\n${changed}` : 'Changed files: none',
      commits ? `Recent commits:\n${commits}` : '',
    ].filter(Boolean).join('\n\n');
  }, [gitContext, rootPath]);

  const gitContextInputText = useMemo(() => {
    if (!gitContext?.available) return '';
    const changed = (gitContext.changedFiles ?? [])
      .slice(0, 20)
      .map((file) => `${file.status} ${file.path}`)
      .join('; ');
    const more = (gitContext.changedFiles?.length ?? 0) > 20 ? '; ...' : '';
    return [
      `Git root: ${gitContext.root ?? rootPath ?? ''}`,
      `branch: ${gitContext.branch ?? 'unknown'}`,
      changed ? `changed files: ${changed}${more}` : 'changed files: none',
    ].join('; ') + ' ';
  }, [gitContext, rootPath]);

  const insertGitContext = useCallback(() => {
    if (!gitContextInputText) return;
    window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
      detail: { text: gitContextInputText },
    }));
    setLastInsertedReference('Git context');
    window.setTimeout(() => setLastInsertedReference((current) => (current === 'Git context' ? null : current)), 1400);
    if (!push) onClose();
  }, [gitContextInputText, onClose, push]);

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
      {/* Header — single compact row + tab bar */}
      <div className="shrink-0 border-b border-border/15 bg-surface px-2 pt-2">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1 px-1">
            <div className="flex items-baseline gap-1.5">
              <span className="truncate text-[13px] font-semibold text-foreground" title={rootPath ?? undefined}>
                {rootName}
              </span>
              {gitContext?.available && gitContext.branch && (
                <span className="inline-flex items-center gap-0.5 truncate text-[11px] text-muted-foreground" title={gitContext.branch}>
                  <RiGitBranch size={10} className="shrink-0" />
                  <span className="truncate max-w-[7rem]">{gitContext.branch}</span>
                </span>
              )}
              {changedFiles.size > 0 && (
                <span className="text-[11px] text-accent">{changedFiles.size}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setSearchOpen((prev) => !prev);
              if (!searchOpen) setTimeout(() => {
                document.querySelector<HTMLInputElement>('input[data-right-search]')?.focus();
              }, 50);
            }}
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition active:scale-95 ${
              searchOpen
                ? 'bg-primary/15 text-primary'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            aria-label="Toggle search"
            title="Search"
          >
            <RiSearch size={14} />
          </button>
          {gitContext?.available && (
            <button
              type="button"
              onClick={() => void refreshGitState()}
              disabled={gitRefreshing}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:opacity-50 active:scale-95"
              aria-label="Refresh git"
              title="Refresh"
            >
              <RiRefresh size={13} className={gitRefreshing ? 'animate-spin' : ''} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive active:scale-95"
            aria-label="Close"
          >
            <RiCloseLine size={14} />
          </button>
        </div>

        {searchOpen && (
          <div className="mt-2 flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-muted-foreground focus-within:bg-surface-elevated">
            <RiSearch size={12} className="shrink-0" />
            <input
              data-right-search
              type="search"
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="Filter changes or files"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              enterKeyHint="search"
              spellCheck={false}
            />
            {fileQuery && (
              <button
                type="button"
                onClick={() => setFileQuery('')}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
                aria-label="Clear search"
              >
                <RiCloseLine size={12} />
              </button>
            )}
          </div>
        )}

        {/* Changed-file mini summary chips (only when there are changes) */}
        {changedFiles.size > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px] font-medium">
            {changedSummary.modified > 0 && (
              <span className="rounded bg-background-subtle px-1.5 py-0.5 text-[color:var(--diff-hunk-accent)]">{changedSummary.modified}M</span>
            )}
            {changedSummary.added > 0 && (
              <span className="rounded bg-background-subtle px-1.5 py-0.5 text-[color:var(--diff-insert-strong)]">+{changedSummary.added}</span>
            )}
            {changedSummary.deleted > 0 && (
              <span className="rounded bg-background-subtle px-1.5 py-0.5 text-[color:var(--diff-delete-strong)]">-{changedSummary.deleted}</span>
            )}
            {changedSummary.renamed > 0 && (
              <span className="rounded bg-background-subtle px-1.5 py-0.5 text-muted-foreground">{changedSummary.renamed}R</span>
            )}
            {gitContext?.available && (
              <>
                <button
                  type="button"
                  onClick={insertGitContext}
                  className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary hover:bg-primary/20"
                  title="Insert git context into active terminal"
                >
                  插入 ctx
                </button>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(gitContextText)}
                  className="rounded-full bg-surface-2 px-2 py-0.5 text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
                  title="Copy git context for AI"
                >
                  Copy
                </button>
              </>
            )}
          </div>
        )}

        {/* Recent references — collapsible */}
        {recentReferences.length > 0 && (
          <details className="mt-2 group">
            <summary className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-1 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground hover:bg-surface-2">
              <span>最近引用 · {recentReferences.length}</span>
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); setRecentReferences([]); }}
                className="rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-surface hover:text-foreground"
              >
                清空
              </button>
            </summary>
            <div className="mt-1 flex gap-1 overflow-x-auto pb-0.5">
              {recentReferences.map((item) => {
                const display = getRelativeDisplayPath(item.path, rootPath);
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => insertPathReference(item.path)}
                    className="inline-flex max-w-[10rem] shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:bg-surface-elevated active:scale-95"
                    title={`Insert ${item.label}`}
                  >
                    <RiFileText size={10} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{display.name}</span>
                  </button>
                );
              })}
            </div>
          </details>
        )}

        {lastInsertedReference && (
          <div className="mt-2 rounded-full bg-primary/10 px-3 py-1 text-[11px] font-medium text-primary">
            已插入 {lastInsertedReference}
          </div>
        )}

        {/* Tab bar — fused with header. Wide mode merges Files+File into a
            single dual-column workspace, so the third tab is unnecessary. */}
        <div className={`mt-2 grid gap-0.5 rounded-md bg-background-subtle p-0.5 ${isWide ? 'grid-cols-2' : 'grid-cols-3'}`}>
          <button
            type="button"
            onClick={() => setRightTab('diff')}
            className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
              rightTab === 'diff'
                ? 'bg-surface-elevated text-foreground'
                : 'text-muted-foreground hover:bg-surface-2'
            }`}
          >
            <RiGitCompare size={12} />
            Changes
            {changedFiles.size > 0 && (
              <span className="text-[10px] text-accent">{changedFiles.size}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setRightTab('files')}
            className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
              (rightTab === 'files' || (isWide && rightTab === 'file'))
                ? 'bg-surface-elevated text-foreground'
                : 'text-muted-foreground hover:bg-surface-2'
            }`}
          >
            <RiFolder size={12} />
            Files
          </button>
          {!isWide && (
          <button
            type="button"
            onClick={() => setRightTab('file')}
            className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
              rightTab === 'file'
                ? 'bg-surface-elevated text-foreground'
                : 'text-muted-foreground hover:bg-surface-2'
            }`}
          >
            <RiFileText size={12} />
            File
          </button>
          )}
        </div>
        <div className="h-2" />
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {(rightTab === 'files' || (isWide && rightTab === 'file')) ? (
          isWide ? (
            <div className="flex h-full min-h-0">
              <div className="w-[300px] min-w-[260px] shrink-0 overflow-y-auto overscroll-contain border-r border-border/15">
                <FileTree
                  rootPath={rootPath ?? ''}
                  onFileSelect={handleFileSelect}
                  onPathReference={insertPathReference}
                  selectedFilePath={selectedFilePath}
                  query={deferredFileQuery}
                />
              </div>
              <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain">
                <FilePreview filePath={selectedFilePath} onInsertReference={insertPathReference} />
              </div>
            </div>
          ) : (
            <div className="h-full overflow-y-auto overscroll-contain">
              <FileTree
                rootPath={rootPath ?? ''}
                onFileSelect={handleFileSelect}
                onPathReference={insertPathReference}
                selectedFilePath={selectedFilePath}
                query={deferredFileQuery}
              />
            </div>
          )
        ) : rightTab === 'file' ? (
          <div className="h-full overflow-y-auto overscroll-contain">
            <FilePreview filePath={selectedFilePath} onInsertReference={insertPathReference} />
          </div>
        ) : isWide ? (
          // Wide changes view: list on the left, diff on the right
          <div className="flex h-full min-h-0">
            <div className="w-[320px] min-w-[260px] shrink-0 flex flex-col overflow-hidden border-r border-border/15">
              {changedFiles.size > 0 && (
                <div className="shrink-0 border-b border-border/15 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => selectDiffFile(null)}
                      className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                        selectedFilePath === null
                          ? 'bg-surface-elevated text-foreground'
                          : 'bg-background-subtle text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                      }`}
                    >
                      All changes
                    </button>
                    <span className="text-[10px] text-muted-foreground">{filteredChangedFiles.length}/{changedFiles.size}</span>
                  </div>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
                {changedFiles.size === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    No changes.
                  </div>
                ) : filteredChangedFiles.length === 0 ? (
                  <div className="bg-background-subtle px-3 py-4 text-center text-xs text-muted-foreground">
                    No matching changes.
                  </div>
                ) : (
                  <div className="space-y-px">
                    {filteredChangedFiles.map(([absolutePath, status]) => {
                      const display = getRelativeDisplayPath(absolutePath, rootPath);
                      const relativePath = rootPath && absolutePath.startsWith(`${rootPath}/`) ? absolutePath.slice(rootPath.length + 1) : absolutePath;
                      const isSelected = selectedFilePath === relativePath || selectedFilePath === absolutePath;
                      return (
                        <button
                          key={absolutePath}
                          type="button"
                          onClick={() => selectDiffFile(relativePath)}
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition active:scale-[0.99] ${
                            isSelected
                              ? 'bg-surface-elevated text-foreground'
                              : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                          }`}
                          title={absolutePath}
                        >
                          <ChangeBadge status={status} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] font-medium">{display.name}</span>
                            {display.dir && <span className="block truncate text-[10px] text-muted-foreground/75">{display.dir}</span>}
                          </span>
                          <span
                            onClick={(event) => {
                              event.stopPropagation();
                              insertPathReference(absolutePath);
                            }}
                            className="inline-flex h-6 shrink-0 items-center justify-center rounded-full bg-primary/10 px-2 text-[11px] font-semibold text-primary opacity-0 transition active:scale-95 group-hover:opacity-100 sm:opacity-0"
                            title="Insert file reference into active terminal"
                          >
                            引用
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain">
              <DiffViewer filePath={selectedFilePath} />
            </div>
          </div>
        ) : (
          // Narrow changes view: stacked
          <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
            {changedFiles.size > 0 && (
              <div className="shrink-0 border-b border-border/15 px-3 py-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => selectDiffFile(null)}
                    className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
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
                  ) : filteredChangedFiles.map(([absolutePath, status]) => {
                    const display = getRelativeDisplayPath(absolutePath, rootPath);
                    const relativePath = rootPath && absolutePath.startsWith(`${rootPath}/`) ? absolutePath.slice(rootPath.length + 1) : absolutePath;
                    const isSelected = selectedFilePath === relativePath || selectedFilePath === absolutePath;
                    return (
                      <button
                        key={absolutePath}
                        type="button"
                        onClick={() => selectDiffFile(relativePath)}
                        className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition active:scale-[0.99] ${
                          isSelected
                            ? 'bg-surface-elevated text-foreground'
                            : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                        }`}
                        title={absolutePath}
                      >
                        <ChangeBadge status={status} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{display.name}</span>
                          {display.dir && <span className="block truncate text-[10px] text-muted-foreground/75">{display.dir}</span>}
                        </span>
                        <span
                          onClick={(event) => {
                            event.stopPropagation();
                            insertPathReference(absolutePath);
                          }}
                          className="inline-flex h-7 min-w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 px-2 text-[11px] font-semibold text-primary transition active:scale-95 sm:h-6 sm:min-w-8"
                          title="Insert file reference into active terminal"
                        >
                          引用
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
