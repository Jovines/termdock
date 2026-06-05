import { useEffect, useCallback, useMemo, useState, useDeferredValue, type Dispatch, type SetStateAction } from 'react';
import {
  X as RiCloseLine,
  ArrowLeft as RiArrowLeft,
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
const MAX_CONTEXT_PACK_FILES = 14;
// Below this width we treat the panel as a phone-sized overlay: dual-pane
// mode collapses to a single column with back-navigation, and the third
// "File" tab is hidden (its content is reachable via the Files tab).
const MOBILE_WIDTH_THRESHOLD_PX = 600;
// Wide mode keeps the dual-pane workspace; below this width the panel falls
// back to stacked tabs even on desktop.
const WIDE_WIDTH_THRESHOLD_PX = 720;

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
  if (!rootPath || !path.startsWith(`${rootPath}/`)) {
    if (!path.startsWith('/') && !path.startsWith('./')) {
      return `./${path}`;
    }
    return path;
  }
  return `./${path.slice(rootPath.length + 1)}`;
}

function buildReferenceInputText(path: string, rootPath: string | null): string {
  const reference = buildFileReference(path, rootPath);
  return reference.includes(' ') ? `"${reference}" ` : `${reference} `;
}

function buildPromptReference(path: string, rootPath: string | null): string {
  const reference = buildFileReference(path, rootPath);
  return reference.includes(' ') ? `"${reference}"` : reference;
}

function buildLineReference(path: string, rootPath: string | null, lineRange: { start: number; end: number } | null): string {
  if (!lineRange) return buildPromptReference(path, rootPath);
  const suffix = lineRange.start === lineRange.end ? `${lineRange.start}` : `${lineRange.start}-${lineRange.end}`;
  return `${buildPromptReference(path, rootPath)}:${suffix}`;
}

interface FilePreviewProps {
  filePath: string | null;
  onInsertReference: (path: string) => void;
  onClose?: () => void;
  isMobile: boolean;
  lineRange: { start: number; end: number } | null;
  onLineRangeChange: Dispatch<SetStateAction<{ start: number; end: number } | null>>;
}

function FilePreview({ filePath, onInsertReference, onClose, isMobile, lineRange, onLineRangeChange }: FilePreviewProps) {
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
    onLineRangeChange(null);
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
  }, [filePath, rootPath, onLineRangeChange]);

  if (!filePath) {
    return <div className="mx-3 mt-3 border border-border/15 bg-background-subtle px-4 py-8 text-center text-sm text-muted-foreground">选择文件以预览内容</div>;
  }

  const readablePath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
  const display = getRelativeDisplayPath(readablePath, rootPath);
  const reference = buildFileReference(readablePath, rootPath);
  const lines = content ? content.split('\n') : [];
  const lineReference = buildLineReference(readablePath, rootPath, lineRange);
  const selectedLineLabel = lineRange
    ? (lineRange.start === lineRange.end ? `L${lineRange.start}` : `L${lineRange.start}-${lineRange.end}`)
    : null;

  const handleLineClick = (lineNumber: number) => {
    onLineRangeChange((current) => {
      if (!current || current.start !== current.end) {
        return { start: lineNumber, end: lineNumber };
      }
      if (current.start === lineNumber) {
        return null;
      }
      return { start: Math.min(current.start, lineNumber), end: Math.max(current.start, lineNumber) };
    });
  };

  const insertRangeReference = () => {
    if (!lineRange) return;
    const suffix = lineRange.start === lineRange.end ? `${lineRange.start}` : `${lineRange.start}-${lineRange.end}`;
    onInsertReference(`${readablePath}:${suffix}`);
  };

  return (
    // The container is a flex column that fills the panel. The middle scroller
    // is `min-h-0 flex-1` so the bottom action bar can stick to the visible
    // bottom regardless of file length.
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/15 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {isMobile && onClose && (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                aria-label="返回文件列表"
                title="返回"
              >
                <RiArrowLeft size={14} />
              </button>
            )}
            <div className="min-w-0" title={readablePath}>
              <div className="truncate text-sm font-medium text-foreground">{display.name}</div>
              {display.dir && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{display.dir}</div>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!isMobile && lineRange && (
              <button
                type="button"
                onClick={insertRangeReference}
                className="inline-flex h-9 items-center gap-1 rounded-full bg-accent/15 px-3 text-xs font-semibold text-accent transition hover:bg-accent/25 active:scale-95"
                title={`Insert code reference: ${lineReference}`}
              >
                引用{selectedLineLabel}
              </button>
            )}
            {!isMobile && (
              <button
                type="button"
                onClick={() => onInsertReference(readablePath)}
                className="inline-flex h-9 items-center gap-1 rounded-full bg-primary/15 px-3 text-xs font-semibold text-primary transition hover:bg-primary/25 active:scale-95"
                title={`Insert reference: ${reference}`}
              >
                引用
              </button>
            )}
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
        {/* Hint row — fixed height so toggling line range doesn't shift the
            file content below. */}
        <div className="mt-1 flex h-4 items-center gap-2 text-[10px] text-muted-foreground/75">
          <span className="truncate">
            {lineRange
              ? `已选 ${selectedLineLabel} · 点下方「引用」按钮插入`
              : '多行引用：先点起始行，再点结束行'}
          </span>
        </div>
      </div>
      {loading ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-8 text-center text-sm text-muted-foreground">Loading file…</div>
      ) : error ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-3 mt-3 border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">{error}</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-none bg-background-subtle p-2 font-mono text-[11px] leading-relaxed text-foreground">
          {lines.length > 0 ? (
            <div className="min-w-full">
              {lines.map((line, index) => {
                const lineNumber = index + 1;
                const isSelected = Boolean(lineRange && lineNumber >= lineRange.start && lineNumber <= lineRange.end);
                return (
                  <button
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    type="button"
                    onClick={() => handleLineClick(lineNumber)}
                    className={`grid w-full grid-cols-[2.8rem_1fr] gap-2 rounded px-1 text-left transition active:scale-[0.995] ${
                      isSelected ? 'bg-primary/15 text-foreground' : 'hover:bg-surface-2'
                    }`}
                    title={`Tap to reference ${reference}:${lineNumber}`}
                  >
                    <span className={`select-none text-right text-[10px] ${isSelected ? 'text-primary' : 'text-muted-foreground/55'}`}>{lineNumber}</span>
                    <span className="min-w-0 whitespace-pre-wrap break-words">{line || ' '}</span>
                  </button>
                );
              })}
            </div>
          ) : 'Empty file.'}
        </div>
      )}
      {/* Sticky bottom action bar — only shows when a line range is selected.
          Always present in the DOM so toggling doesn't reflow the scroller; we
          just hide it with visibility to keep the line gutter position stable. */}
      <div
        className={`shrink-0 border-t border-border/15 bg-surface px-3 py-2 transition-all duration-150 ${
          lineRange ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'
        }`}
        aria-hidden={!lineRange}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
            已选 {selectedLineLabel}
          </div>
          <button
            type="button"
            onClick={() => onLineRangeChange(null)}
            className="inline-flex h-9 items-center rounded-full bg-background-subtle px-3 text-[12px] font-medium text-muted-foreground transition hover:bg-surface-2 hover:text-foreground active:scale-95"
          >
            清除
          </button>
          <button
            type="button"
            onClick={insertRangeReference}
            className="inline-flex h-9 items-center gap-1 rounded-full bg-primary px-4 text-[12px] font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 active:scale-95"
            title={`Insert code reference: ${lineReference}`}
          >
            引用{selectedLineLabel}
          </button>
        </div>
      </div>
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
  // Line-range selection lives in the sidebar so the sticky action bar and
  // the file scroller stay in sync without prop-drilling the click handler.
  const [lineRange, setLineRange] = useState<{ start: number; end: number } | null>(null);
  const isMobile = drawerWidthPx < MOBILE_WIDTH_THRESHOLD_PX;
  const isWide = !isMobile && drawerWidthPx >= WIDE_WIDTH_THRESHOLD_PX;
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
      setLineRange(null);
    }
  }, [isOpen]);

  const handleFileSelect = useCallback((path: string) => {
    selectFile(path);
    setLineRange(null);
    // In wide mode the preview is already visible alongside the tree, so we
    // don't need to switch tabs and steal focus from the user's browse flow.
    if (!isWide) setRightTab('files');
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
      detail: { text: buildReferenceInputText(absolutePath, rootPath), focus: false },
    }));
    setLastInsertedReference(reference);
    window.setTimeout(() => setLastInsertedReference((current) => (current === reference ? null : current)), 1400);
  }, [rememberReference, rootPath]);

  const insertContextText = useCallback((label: string, text: string) => {
    if (!text) return;
    window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
      detail: { text: text.endsWith(' ') ? text : `${text} `, focus: false },
    }));
    setLastInsertedReference(label);
    window.setTimeout(() => setLastInsertedReference((current) => (current === label ? null : current)), 1400);
  }, []);

  const rootName = useMemo(() => {
    if (!rootPath) return '工作区';
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
    const changed = (gitContext.changedFiles ?? []).map((file) => `- ${file.status} ./${file.path}`).join('\n');
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
      .map((file) => `${file.status} ./${file.path}`)
      .join('; ');
    const more = (gitContext.changedFiles?.length ?? 0) > 20 ? '; ...' : '';
    return [
      `Git root: ${gitContext.root ?? rootPath ?? ''}`,
      `branch: ${gitContext.branch ?? 'unknown'}`,
      changed ? `changed files: ${changed}${more}` : 'changed files: none',
    ].join('; ') + ' ';
  }, [gitContext, rootPath]);

  const changedFileContextLines = useMemo(() => {
    const files = gitContext?.changedFiles?.length ? gitContext.changedFiles : Array.from(changedFiles.entries()).map(([path, status]) => ({ path, absolutePath: path, status }));
    return files
      .slice(0, MAX_CONTEXT_PACK_FILES)
      .map((file) => `- ${file.status} ${buildPromptReference(file.absolutePath || file.path, rootPath)}`);
  }, [changedFiles, gitContext, rootPath]);

  const currentFileContextText = useMemo(() => {
    if (!selectedFilePath) return '';
    const absolutePath = rootPath && !selectedFilePath.startsWith('/') ? `${rootPath}/${selectedFilePath}` : selectedFilePath;
    return `${buildPromptReference(absolutePath, rootPath)} `;
  }, [rootPath, selectedFilePath]);

  const changeContextPackText = useMemo(() => {
    if (!gitContext?.available && changedFileContextLines.length === 0) return '';
    return [
      gitContext?.root || rootPath ? `Git root：${gitContext?.root ?? rootPath}` : '',
      gitContext?.branch ? `Branch：${gitContext.branch}` : '',
      changedFileContextLines.length > 0
        ? `Changed files：\n${changedFileContextLines.join('\n')}`
        : 'Changed files：none',
    ].filter(Boolean).join('\n') + '\n';
  }, [changedFileContextLines, gitContext, rootPath]);

  const searchContextText = useMemo(() => {
    if (!deferredFileQuery.trim()) return '';
    const results = filteredChangedFiles
      .slice(0, MAX_CONTEXT_PACK_FILES)
      .map(([path, status]) => `- ${status} ${buildPromptReference(path, rootPath)}`);
    return results.length > 0 ? `${results.join('\n')}\n` : '';
  }, [deferredFileQuery, filteredChangedFiles, rootPath]);

  const recentContextText = useMemo(() => {
    if (recentReferences.length === 0) return '';
    const refs = recentReferences
      .slice(0, MAX_CONTEXT_PACK_FILES)
      .map((item) => `- ${buildPromptReference(item.path, rootPath)}`);
    return `${refs.join('\n')}\n`;
  }, [recentReferences, rootPath]);

  const insertGitContext = useCallback(() => {
    if (!gitContextInputText) return;
    insertContextText('Git 信息', gitContextInputText);
    if (!push) onClose();
  }, [gitContextInputText, insertContextText, onClose, push]);

  const selectDiffFile = useCallback((path: string | null) => {
    selectFile(path);
    setRightTab('diff');
  }, [selectFile, setRightTab]);

  const closeFilePreview = useCallback(() => {
    selectFile(null);
    setLineRange(null);
  }, [selectFile]);

  const closeDiffView = useCallback(() => {
    selectFile(null);
    setLineRange(null);
  }, [selectFile]);

  return (
    <Sidebar
      side="right"
      isOpen={isOpen}
      drawerWidthPx={drawerWidthPx}
      onClose={onClose}
      onOpen={onOpen}
      push={push}
    >
      {/* Header — single compact row + tab bar. The header is laid out as a
          fixed-shape column: every conditional block (search, chip row,
          recent refs) reserves a minimum slot so opening/closing them never
          reflows the content below. The toast is absolutely positioned
          inside the header so its appearance doesn't push siblings. */}
      <div className="relative shrink-0 border-b border-border/15 bg-surface px-2 pt-2">
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
            aria-label="切换搜索"
            title="搜索"
          >
            <RiSearch size={14} />
          </button>
          {gitContext?.available && (
            <button
              type="button"
              onClick={() => void refreshGitState()}
              disabled={gitRefreshing}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:opacity-50 active:scale-95"
              aria-label="刷新 Git 状态"
              title="刷新"
            >
              <RiRefresh size={13} className={gitRefreshing ? 'animate-spin' : ''} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive active:scale-95"
            aria-label="关闭"
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
              placeholder="过滤改动或文件"
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
                aria-label="清除搜索"
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
                  title="把当前 Git 信息插入 Terminal"
                >
                  插入 Git 信息
                </button>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(gitContextText)}
                  className="rounded-full bg-surface-2 px-2 py-0.5 text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
                  title="复制 Git 信息"
                >
                  复制
                </button>
              </>
            )}
          </div>
        )}

        {/* "Insert X" preset chips — always render so toggling visibility
            never reflows the header. The list of presets is a stable order
            and each chip occupies its own slot; we just hide unused ones. */}
        {(() => {
          const presets: { key: string; text: string; label: string; tone: 'primary' | 'accent' | 'subtle'; title: string }[] = [
            { key: 'changes', text: changeContextPackText, label: '全部改动', tone: 'primary', title: '插入当前分支、全部改动文件列表' },
            { key: 'current', text: currentFileContextText, label: '当前文件', tone: 'accent', title: '插入当前选中的文件' },
            { key: 'search', text: searchContextText, label: '搜索结果', tone: 'subtle', title: '插入当前搜索词匹配的改动文件' },
            { key: 'recent', text: recentContextText, label: '最近引用', tone: 'subtle', title: '插入最近引用过的文件' },
          ];
          const visible = presets.filter((p) => Boolean(p.text));
          return (
            <div className="mt-2 flex h-7 gap-1 overflow-x-auto pb-0.5 text-[11px] font-semibold">
              {presets.map((preset) => {
                const isVisible = visible.some((v) => v.key === preset.key);
                const toneClass = !isVisible
                  ? 'pointer-events-none invisible'
                  : preset.tone === 'primary'
                    ? 'bg-primary/15 text-primary hover:bg-primary/25'
                    : preset.tone === 'accent'
                      ? 'bg-accent/15 text-accent hover:bg-accent/25'
                      : 'bg-background-subtle text-foreground hover:bg-surface-2';
                return (
                  <button
                    key={preset.key}
                    type="button"
                    tabIndex={isVisible ? 0 : -1}
                    aria-hidden={!isVisible}
                    onClick={() => insertContextText(preset.label, preset.text)}
                    className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 transition active:scale-95 ${toneClass}`}
                    title={preset.title}
                  >
                    插入：{preset.label}
                  </button>
                  );
              })}
            </div>
          );
        })()}

        {/* Recent references — always render the row height so toggling
            doesn't shift the header. Empty list collapses to a 0-height slot
            but still occupies the layout baseline. */}
        <div className="mt-2 h-6">
          {recentReferences.length > 0 && (
            <div className="flex h-full items-center gap-1 overflow-x-auto pb-0.5">
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">最近</span>
              {recentReferences.slice(0, MAX_RECENT_REFERENCES).map((item) => {
                const display = getRelativeDisplayPath(item.path, rootPath);
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => insertPathReference(item.path)}
                    className="inline-flex max-w-[10rem] shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-foreground transition hover:bg-surface-elevated active:scale-95"
                    title={`Insert ${item.label}`}
                  >
                    <RiFileText size={10} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{display.name}</span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setRecentReferences([])}
                className="ml-auto shrink-0 rounded-full bg-background-subtle px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                title="清空最近引用"
              >
                清空
              </button>
            </div>
          )}
        </div>

        {/* Tab bar — mobile collapses the third "File" tab because file
            preview is reachable via the Files tab. Wide desktop shows just
            Changes + Files since the file preview is rendered side-by-side
            inside Files. */}
        <div className={`mt-2 grid gap-0.5 rounded-md bg-background-subtle p-0.5 ${isMobile ? 'grid-cols-2' : isWide ? 'grid-cols-2' : 'grid-cols-3'}`}>
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
            改动
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
            文件
          </button>
          {!isMobile && !isWide && (
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
              预览
            </button>
          )}
        </div>
        <div className="h-2" />

        {/* Toast — absolutely positioned so its 1.4 s lifetime doesn't push
            the tab bar or scroller. */}
        {lastInsertedReference && (
          <div className="pointer-events-none absolute right-12 top-2 z-10 max-w-[60%] truncate rounded-full bg-primary/90 px-3 py-1 text-[11px] font-medium text-primary-foreground shadow-md animate-fade-in">
            已插入 {lastInsertedReference}
          </div>
        )}
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
              <div className="min-w-0 flex-1 overflow-hidden">
                <FilePreview
                  filePath={selectedFilePath}
                  onInsertReference={insertPathReference}
                  isMobile={false}
                  lineRange={lineRange}
                  onLineRangeChange={setLineRange}
                />
              </div>
            </div>
          ) : (
            // Narrow (desktop narrow or mobile): single column. Mobile
            // navigates tree → preview → back; desktop narrow swaps by tab.
            <div className="h-full overflow-y-auto overscroll-contain">
              {isMobile && selectedFilePath ? (
                <FilePreview
                  filePath={selectedFilePath}
                  onInsertReference={insertPathReference}
                  onClose={closeFilePreview}
                  isMobile
                  lineRange={lineRange}
                  onLineRangeChange={setLineRange}
                />
              ) : (
                <FileTree
                  rootPath={rootPath ?? ''}
                  onFileSelect={handleFileSelect}
                  onPathReference={insertPathReference}
                  selectedFilePath={selectedFilePath}
                  query={deferredFileQuery}
                />
              )}
            </div>
          )
        ) : rightTab === 'file' && !isMobile && !isWide ? (
          // Desktop narrow: dedicated preview tab.
          <div className="h-full overflow-hidden">
            <FilePreview
              filePath={selectedFilePath}
              onInsertReference={insertPathReference}
              isMobile={false}
              lineRange={lineRange}
              onLineRangeChange={setLineRange}
            />
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
                      全部改动
                    </button>
                    <span className="text-[10px] text-muted-foreground">{filteredChangedFiles.length}/{changedFiles.size}</span>
                  </div>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
                {changedFiles.size === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    没有改动
                  </div>
                ) : filteredChangedFiles.length === 0 ? (
                  <div className="bg-background-subtle px-3 py-4 text-center text-xs text-muted-foreground">
                    没有匹配的改动
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
                          className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition active:scale-[0.99] ${
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
                            className="inline-flex h-6 shrink-0 items-center justify-center rounded-full bg-primary/10 px-2 text-[11px] font-semibold text-primary opacity-100 transition active:scale-95 md:opacity-0 md:group-hover:opacity-100"
                            title="把这个文件引用插入 Terminal"
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
              <DiffViewer filePath={selectedFilePath} onInsertDiffReference={insertContextText} />
            </div>
          </div>
        ) : (
          // Narrow changes view: stacked. Mobile navigates list → diff → back.
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {changedFiles.size > 0 && (
              <div className="shrink-0 border-b border-border/15 px-3 py-2">
                {isMobile && selectedFilePath ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={closeDiffView}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                      aria-label="返回改动列表"
                      title="返回"
                    >
                      <RiArrowLeft size={14} />
                    </button>
                    <span className="text-[12px] font-medium text-foreground">查看 diff</span>
                  </div>
                ) : (
                  <>
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
                        全部改动
                      </button>
                      <span className="text-[10px] text-muted-foreground">{filteredChangedFiles.length}/{changedFiles.size}</span>
                    </div>
                    <div className="space-y-px">
                      {filteredChangedFiles.length === 0 ? (
                        <div className="bg-background-subtle px-3 py-4 text-center text-xs text-muted-foreground">
                          没有匹配的改动
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
                            className={`group flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition active:scale-[0.99] ${
                              isSelected
                                ? 'bg-surface-elevated text-foreground'
                                : 'hover:bg-surface-2'
                            }`}
                            title={absolutePath}
                          >
                            <ChangeBadge status={status} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium">{display.name}</span>
                              {display.dir && <span className="block truncate text-[10px] text-muted-foreground/75">{display.dir}</span>}
                            </span>
                            {/* On mobile the inline cite button is always
                                visible (no hover state). On desktop narrow
                                it appears on row hover. */}
                            <span
                              onClick={(event) => {
                                event.stopPropagation();
                                insertPathReference(absolutePath);
                              }}
                              className="inline-flex h-7 min-w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 px-2 text-[11px] font-semibold text-primary transition active:scale-95 sm:h-6 sm:min-w-8 md:opacity-0 md:group-hover:opacity-100"
                              title="把这个文件引用插入 Terminal"
                            >
                              引用
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {isMobile && !selectedFilePath ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">选择上面的文件查看 diff</div>
              ) : (
                <DiffViewer filePath={selectedFilePath} onInsertDiffReference={insertContextText} />
              )}
            </div>
          </div>
        )}
      </div>
    </Sidebar>
  );
}
