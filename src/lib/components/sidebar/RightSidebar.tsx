import { useEffect, useCallback, useMemo, useState, useDeferredValue, useRef, type Dispatch, type SetStateAction, type UIEvent, type ReactNode } from 'react';
import {
  X as RiCloseLine,
  ArrowLeft as RiArrowLeft,
  ChevronRight as RiChevronRight,
  ChevronDown as RiChevronDown,
  Folder as RiFolder,
  GitCompare as RiGitCompare,
  Search as RiSearch,
  FileText as RiFileText,
  Copy as RiCopy,
  RefreshCw as RiRefresh,
  GitBranch as RiGitBranch,
  Loader2 as RiLoader,
} from 'lucide-react';
import { Sidebar } from './Sidebar';
import { FileTree } from './FileTree';
import { DiffViewer, preloadSidebarDiff } from './DiffViewer';
import { useSidebarStore, type RightSidebarTab } from '../../stores/useSidebarStore';
import { getGitBundle, isPreviewableImagePath, readFileContent, readImagePreviewBlob, runGitAction, type GitActionRequest, type GitBundleResponse, type GitChangedFile, type GitContext } from '../../terminal/api';
import { useI18n } from '../../i18n';
import { flushCacheThrottled, readCache, writeCacheThrottled } from '../../utils/localStorageCache';

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
  copied: { label: 'C', className: 'text-[color:var(--diff-insert-strong)]', title: 'Copied' },
  untracked: { label: 'U', className: 'text-[color:var(--diff-insert-strong)]', title: 'Untracked (new file)' },
  conflicted: { label: '!', className: 'text-destructive', title: 'Conflicted' },
  unknown: { label: '?', className: 'text-muted-foreground', title: 'Unknown' },
};

const RECENT_REFERENCES_STORAGE_KEY = 'termdock:recent-file-references';
const FILE_TREE_SCROLL_STORAGE_KEY = 'termdock:right-sidebar:file-tree-scroll:v1';
const MAX_RECENT_REFERENCES = 8;
const MAX_CONTEXT_PACK_FILES = 14;
const MAX_FILE_TREE_SCROLL_ROOTS = 20;
const FILE_TREE_SCROLL_WRITE_MS = 250;
const GIT_BUNDLE_SLOW_MS = 700;
// Below this width we treat the panel as a phone-sized overlay: dual-pane
// mode collapses to a single column with back-navigation, and the third
// "File" tab is hidden (its content is reachable via the Files tab).
const MOBILE_WIDTH_THRESHOLD_PX = 600;
// Wide mode keeps the dual-pane workspace; below this width the panel falls
// back to stacked tabs even on desktop.
const WIDE_WIDTH_THRESHOLD_PX = 720;

type GitActionKey = GitActionRequest['action'];

type ConfirmGitAction =
  | { kind: 'restore'; file: GitChangedFile; phrase: string }
  | { kind: 'stash-all' };

interface GitActionButton {
  key: GitActionKey;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}

interface RecentReference {
  path: string;
  label: string;
}

interface FileTreeScrollEntry {
  top: number;
  updatedAt: number;
}

type FileTreeScrollCache = Record<string, FileTreeScrollEntry>;

function isFileTreeScrollCache(value: unknown): value is FileTreeScrollCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const maybeEntry = entry as Partial<FileTreeScrollEntry>;
    if (typeof maybeEntry.top !== 'number' || !Number.isFinite(maybeEntry.top)) return false;
    if (typeof maybeEntry.updatedAt !== 'number' || !Number.isFinite(maybeEntry.updatedAt)) return false;
  }
  return true;
}

function readFileTreeScrollCache(): FileTreeScrollCache {
  return readCache(FILE_TREE_SCROLL_STORAGE_KEY, isFileTreeScrollCache) ?? {};
}

function writeFileTreeScrollPosition(rootPath: string, top: number): void {
  const cache = readFileTreeScrollCache();
  const nextEntries = Object.entries({
    ...cache,
    [rootPath]: { top, updatedAt: Date.now() },
  })
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_FILE_TREE_SCROLL_ROOTS);
  writeCacheThrottled(FILE_TREE_SCROLL_STORAGE_KEY, Object.fromEntries(nextEntries), FILE_TREE_SCROLL_WRITE_MS);
}

function Pane({ active, mounted = true, children }: { active: boolean; mounted?: boolean; children: ReactNode }) {
  return (
    <div className={`h-full min-h-0 overflow-hidden ${active ? 'block' : 'hidden'}`} aria-hidden={!active}>
      {mounted ? children : null}
    </div>
  );
}

function GitChangesLoadingState({ slow }: { slow: boolean }) {
  const { t } = useI18n();
  return (
    <div className="mx-3 mt-3 border border-border/15 bg-background-subtle px-4 py-8 text-center text-sm text-muted-foreground">
      <RiLoader size={20} className="mx-auto mb-2 animate-spin text-muted-foreground/80" />
      <div>{t('rightSidebar.loadingGitChanges')}</div>
      {slow && <div className="mt-1 text-xs text-muted-foreground/75">{t('rightSidebar.loadingGitChangesSlow')}</div>}
    </div>
  );
}

function GitChangesErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mx-3 mt-3 border border-destructive/20 bg-destructive/5 px-4 py-5 text-center text-sm text-destructive">
      <div className="font-medium">{t('rightSidebar.gitChangesLoadFailed')}</div>
      <div className="mt-1 break-words text-xs opacity-85">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-full bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/15 active:scale-95"
      >
        {t('rightSidebar.retryGitChanges')}
      </button>
    </div>
  );
}

function GitChangesRefreshingBanner() {
  const { t } = useI18n();
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg bg-background-subtle px-3 py-2 text-[11px] text-muted-foreground">
      <RiLoader size={12} className="shrink-0 animate-spin" />
      <span>{t('rightSidebar.refreshingGitChanges')}</span>
    </div>
  );
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

function toChangedFileMap(files: GitChangedFile[]): Map<string, GitChangedFile> {
  const map = new Map<string, GitChangedFile>();
  for (const file of files) {
    map.set(file.absolutePath || file.path, file);
  }
  return map;
}

function GitActionChips({ actions, running }: { actions: GitActionButton[]; running: { action: GitActionKey; path?: string } | null }) {
  if (actions.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {actions.map((action) => {
        const isRunning = running?.action === action.key;
        return (
          <button
            key={action.key}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              action.onClick();
            }}
            disabled={action.disabled || Boolean(running)}
            className={`inline-flex h-6 items-center rounded-full px-2 text-[10px] font-semibold transition active:scale-95 disabled:opacity-50 ${
              action.destructive
                ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
                : 'bg-background-subtle text-muted-foreground hover:bg-surface-2 hover:text-foreground'
            }`}
          >
            {isRunning ? '…' : action.label}
          </button>
        );
      })}
    </div>
  );
}

interface FilePreviewProps {
  filePath: string | null;
  onInsertReference: (path: string) => void;
  onClose?: () => void;
  isMobile: boolean;
  lineRange: { start: number; end: number } | null;
  onLineRangeChange: Dispatch<SetStateAction<{ start: number; end: number } | null>>;
}

type FilePreviewState =
  | { kind: 'idle' }
  | { kind: 'loading'; mode: 'text' | 'image' }
  | { kind: 'text'; content: string; meta: { size: number; truncated?: boolean } }
  | { kind: 'image'; objectUrl: string; meta: { size: number | null; mimeType: string; modified: string | null }; dimensions?: { width: number; height: number } }
  | { kind: 'error'; message: string };

function FilePreview({ filePath, onInsertReference, onClose, isMobile, lineRange, onLineRangeChange }: FilePreviewProps) {
  const { t } = useI18n();
  const rootPath = useSidebarStore((s) => s.rootPath);
  const [previewState, setPreviewState] = useState<FilePreviewState>({ kind: 'idle' });

  useEffect(() => {
    if (!filePath) {
      setPreviewState({ kind: 'idle' });
      return;
    }

    const readablePath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const isImage = isPreviewableImagePath(readablePath);

    setPreviewState({ kind: 'loading', mode: isImage ? 'image' : 'text' });
    onLineRangeChange(null);

    if (isImage) {
      readImagePreviewBlob(readablePath, controller.signal)
        .then((result) => {
          objectUrl = URL.createObjectURL(result.blob);
          setPreviewState({
            kind: 'image',
            objectUrl,
            meta: { size: result.size, mimeType: result.mimeType, modified: result.modified },
          });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setPreviewState({ kind: 'error', message: err instanceof Error ? err.message : t('rightSidebar.imageLoadFailed') });
        });
    } else {
      readFileContent(readablePath, controller.signal)
        .then((result) => {
          setPreviewState({ kind: 'text', content: result.content, meta: { size: result.size, truncated: result.truncated } });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setPreviewState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to read file' });
        });
    }

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, rootPath, onLineRangeChange, t]);

  if (!filePath) {
    return <div className="mx-3 mt-3 border border-border/15 bg-background-subtle px-4 py-8 text-center text-sm text-muted-foreground">{t('rightSidebar.selectFilePrompt')}</div>;
  }

  const readablePath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
  const display = getRelativeDisplayPath(readablePath, rootPath);
  const reference = buildFileReference(readablePath, rootPath);
  const lines = previewState.kind === 'text' && previewState.content ? previewState.content.split('\n') : [];
  const meta = previewState.kind === 'text' || previewState.kind === 'image' ? previewState.meta : null;
  const isImagePreview = previewState.kind === 'image' || (previewState.kind === 'loading' && previewState.mode === 'image');
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
                aria-label={t('rightSidebar.backToFileList')}
                title={t('common.back')}
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
            {!isMobile && lineRange && !isImagePreview && (
              <button
                type="button"
                onClick={insertRangeReference}
                className="inline-flex h-9 items-center gap-1 rounded-full bg-accent/15 px-3 text-xs font-semibold text-accent transition hover:bg-accent/25 active:scale-95"
                title={`Insert code reference: ${lineReference}`}
              >
                {t('rightSidebar.insertLineRef', { lineLabel: selectedLineLabel ?? '' })}
              </button>
            )}
            {!isMobile && (
              <button
                type="button"
                onClick={() => onInsertReference(readablePath)}
                className="inline-flex h-9 items-center gap-1 rounded-full bg-primary/15 px-3 text-xs font-semibold text-primary transition hover:bg-primary/25 active:scale-95"
                title={`Insert reference: ${reference}`}
              >
                {t('rightSidebar.insertFileRef')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(reference)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-background-subtle text-muted-foreground transition hover:bg-surface-2 hover:text-foreground active:scale-95"
              title={`Copy reference: ${reference}`}
              aria-label={t('rightSidebar.copyFileRef')}
            >
              <RiCopy size={13} />
            </button>
          </div>
        </div>
        {meta && (
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            {meta.size !== null && <span>{meta.size.toLocaleString()} bytes</span>}
            {'truncated' in meta && meta.truncated && <span className="text-yellow-400">preview truncated to 1MB</span>}
            {'mimeType' in meta && <span>{meta.mimeType}</span>}
            {'dimensions' in previewState && previewState.dimensions && <span>{previewState.dimensions.width} × {previewState.dimensions.height}</span>}
          </div>
        )}
        {/* Hint row — fixed height so toggling line range doesn't shift the
            file content below. */}
        <div className="mt-1 flex h-4 items-center gap-2 text-[10px] text-muted-foreground/75">
          <span className="truncate">
            {isImagePreview
              ? t('rightSidebar.imagePreviewHint')
              : lineRange
                ? t('rightSidebar.selectedLineHint', { lineLabel: selectedLineLabel ?? '' })
                : t('rightSidebar.multiLineHint')}
          </span>
        </div>
      </div>
      {previewState.kind === 'loading' ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-8 text-center text-sm text-muted-foreground">
          {previewState.mode === 'image' ? t('rightSidebar.loadingImage') : 'Loading file…'}
        </div>
      ) : previewState.kind === 'error' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-3 mt-3 border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">{previewState.message}</div>
        </div>
      ) : previewState.kind === 'image' ? (
        <div className="min-h-0 flex-1 overflow-auto bg-background-subtle p-3">
          <div className="flex min-h-full items-center justify-center">
            <img
              src={previewState.objectUrl}
              alt={display.name}
              className="max-h-full max-w-full rounded border border-border/15 bg-surface object-contain shadow-sm"
              onLoad={(event) => {
                const img = event.currentTarget;
                setPreviewState((current) => (
                  current.kind === 'image'
                    ? { ...current, dimensions: { width: img.naturalWidth, height: img.naturalHeight } }
                    : current
                ));
              }}
              onError={() => setPreviewState({ kind: 'error', message: t('rightSidebar.imageLoadFailed') })}
            />
          </div>
        </div>
      ) : previewState.kind === 'text' ? (
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
      ) : null}
      {/* Sticky bottom action bar — only shows when a line range is selected.
          Collapsed out of the layout (instead of opacity-0) when no range is
          selected so the scroller can fill the full available height — this
          matters most on mobile where the wasted 53px is a noticeable chunk
          of the viewport. */}
      <div
        className={`shrink-0 overflow-hidden border-t border-border/15 bg-surface transition-all duration-150 ${
          lineRange && !isImagePreview ? 'max-h-24 opacity-100' : 'pointer-events-none max-h-0 opacity-0 border-t-transparent'
        }`}
        aria-hidden={!lineRange || isImagePreview}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
            {t('rightSidebar.selectedLineFooter', { lineLabel: selectedLineLabel ?? '' })}
          </div>
          <button
            type="button"
            onClick={() => onLineRangeChange(null)}
            className="inline-flex h-9 items-center rounded-full bg-background-subtle px-3 text-[12px] font-medium text-muted-foreground transition hover:bg-surface-2 hover:text-foreground active:scale-95"
          >
            {t('rightSidebar.clearSelection')}
          </button>
          <button
            type="button"
            onClick={insertRangeReference}
            className="inline-flex h-9 items-center gap-1 rounded-full bg-primary px-4 text-[12px] font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 active:scale-95"
            title={`Insert code reference: ${lineReference}`}
          >
            {t('rightSidebar.insertLineRef', { lineLabel: selectedLineLabel ?? '' })}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RightSidebar(
  { isOpen, drawerWidthPx, onClose, onOpen, push }: RightSidebarProps,
) {
  const { t } = useI18n();
  const [fileQuery, setFileQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const deferredFileQuery = useDeferredValue(fileQuery);
  const [gitContext, setGitContext] = useState<GitContext | null>(null);
  const [lastInsertedReference, setLastInsertedReference] = useState<string | null>(null);
  const [recentReferences, setRecentReferences] = useState<RecentReference[]>(() => loadRecentReferences());
  // Line-range selection lives in the sidebar so the sticky action bar and
  // the file scroller stay in sync without prop-drilling the click handler.
  const [lineRange, setLineRange] = useState<{ start: number; end: number } | null>(null);
  // On phone-sized panels the diff tab is intentionally a plain grouped list:
  // one file row, tap to expand/collapse its inline diff, no mode switcher.
  const [expandedDiffFiles, setExpandedDiffFiles] = useState<Set<string>>(() => new Set());
  // When on, long diff lines wrap instead of overflowing horizontally. The
  // user can opt in per-session without leaving the panel.
  const [diffWrap, setDiffWrap] = useState(true);
  const [diffRefreshKey, setDiffRefreshKey] = useState(0);
  const [mobileFilePreviewOpen, setMobileFilePreviewOpen] = useState(false);
  const [hasMountedDiffPane, setHasMountedDiffPane] = useState(false);
  const [hasMountedPreviewPane, setHasMountedPreviewPane] = useState(false);
  const [runningGitAction, setRunningGitAction] = useState<{ action: GitActionKey; path?: string } | null>(null);
  const [confirmGitAction, setConfirmGitAction] = useState<ConfirmGitAction | null>(null);
  const [gitActionError, setGitActionError] = useState<string | null>(null);
  const [gitQuickActionsOpen, setGitQuickActionsOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [pushRemote, setPushRemote] = useState('');
  const [pushBranch, setPushBranch] = useState('');
  const isMobile = drawerWidthPx < MOBILE_WIDTH_THRESHOLD_PX;
  const isWide = !isMobile && drawerWidthPx >= WIDE_WIDTH_THRESHOLD_PX;
  const rightTab = useSidebarStore((s) => s.rightTab);
  const setRightTab = useSidebarStore((s) => s.setRightTab);
  const rootPath = useSidebarStore((s) => s.rootPath);
  const selectedFilePath = useSidebarStore((s) => s.selectedFilePath);
  const selectFile = useSidebarStore((s) => s.selectFile);
  const changedFiles = useSidebarStore((s) => s.changedFiles);
  const setChangedFiles = useSidebarStore((s) => s.setChangedFiles);
  const gitBundleLoading = useSidebarStore((s) => s.gitBundleLoading);
  const gitBundleSlow = useSidebarStore((s) => s.gitBundleSlow);
  const gitBundleError = useSidebarStore((s) => s.gitBundleError);
  const gitBundleLastLoadedAt = useSidebarStore((s) => s.gitBundleLastLoadedAt);
  const setGitBundleLoading = useSidebarStore((s) => s.setGitBundleLoading);
  const setGitBundleSlow = useSidebarStore((s) => s.setGitBundleSlow);
  const setGitBundleError = useSidebarStore((s) => s.setGitBundleError);
  const markGitBundleLoaded = useSidebarStore((s) => s.markGitBundleLoaded);
  const rootEntriesLoaded = useSidebarStore((s) => Boolean(rootPath && s.directoryCache.has(rootPath)));
  const fileTreeScrollRef = useRef<HTMLDivElement | null>(null);
  const gitBundleRequestIdRef = useRef(0);

  const applyGitBundle = useCallback((bundle: GitBundleResponse, options: { reloadDiff?: boolean } = {}) => {
    setChangedFiles(toChangedFileMap(bundle.files));
    setGitContext(bundle.context);
    if (options.reloadDiff) setDiffRefreshKey((key) => key + 1);
    const current = useSidebarStore.getState().selectedFilePath;
    if (current && !bundle.files.some((file) => file.path === current || file.absolutePath === current)) {
      selectFile(null);
    }
    setExpandedDiffFiles((expanded) => {
      const valid = new Set(bundle.files.map((file) => file.path));
      const next = new Set<string>();
      for (const path of expanded) {
        if (valid.has(path)) next.add(path);
      }
      return next;
    });
  }, [selectFile, setChangedFiles]);

  useEffect(() => {
    gitBundleRequestIdRef.current += 1;
    if (rootPath !== null) return;
    setGitContext(null);
  }, [rootPath]);

  const loadGitBundle = useCallback(async (cwd: string | undefined = rootPath ?? undefined, options: { reloadDiff?: boolean; preloadDiff?: boolean } = {}) => {
    const requestId = gitBundleRequestIdRef.current + 1;
    gitBundleRequestIdRef.current = requestId;
    let slowTimer: number | null = null;
    setGitBundleLoading(true);
    setGitBundleSlow(false);
    setGitBundleError(null);
    if (typeof window !== 'undefined') {
      slowTimer = window.setTimeout(() => {
        if (gitBundleRequestIdRef.current === requestId) setGitBundleSlow(true);
      }, GIT_BUNDLE_SLOW_MS);
    }

    try {
      const bundle = await getGitBundle(cwd);
      if (gitBundleRequestIdRef.current !== requestId) return null;
      applyGitBundle(bundle, { reloadDiff: options.reloadDiff ?? false });
      if (options.preloadDiff) {
        const current = useSidebarStore.getState().selectedFilePath;
        const currentStillChanged = Boolean(current && bundle.files.some((file) => file.path === current || file.absolutePath === current));
        preloadSidebarDiff(cwd ?? rootPath, currentStillChanged ? current : null, { force: options.reloadDiff ?? false });
      }
      return bundle;
    } catch (err) {
      if (gitBundleRequestIdRef.current !== requestId) return null;
      setGitContext(null);
      setGitBundleError(err instanceof Error ? err.message : 'Failed to load Git changes');
      return null;
    } finally {
      if (slowTimer !== null) window.clearTimeout(slowTimer);
      if (gitBundleRequestIdRef.current === requestId) markGitBundleLoaded();
    }
  }, [applyGitBundle, markGitBundleLoaded, rootPath, setGitBundleError, setGitBundleLoading, setGitBundleSlow]);

  const refreshGitState = useCallback(async () => {
    if (!rootPath) return;
    await loadGitBundle(rootPath, { reloadDiff: true });
  }, [loadGitBundle, rootPath]);

  useEffect(() => {
    if (!isOpen) {
      setFileQuery('');
      setSearchOpen(false);
      setLineRange(null);
      // Keep diff view mode + wrap preference across close/open so the
      // user's chosen reading mode is preserved within a session.
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isMobile) setMobileFilePreviewOpen(false);
  }, [isMobile]);

  const effectiveRightTab: RightSidebarTab = (isMobile || isWide) && rightTab === 'file' ? 'files' : rightTab;
  const filesPaneActive = effectiveRightTab === 'files';
  const diffPaneActive = effectiveRightTab === 'diff';
  const previewPaneActive = effectiveRightTab === 'file' && !isMobile && !isWide;
  const mobilePreviewActive = isMobile && mobileFilePreviewOpen && Boolean(selectedFilePath);

  // Warm Git state for the Changes tab. When the active terminal cwd changes
  // while the sidebar is closed, preloading here lets reopening the sidebar
  // reuse ready git metadata/diff instead of waiting on the first visible paint.
  useEffect(() => {
    const shouldPreloadChanges = diffPaneActive || rightTab === 'diff';
    if (!shouldPreloadChanges || !rootPath || gitBundleLastLoadedAt !== null || gitBundleLoading) return;
    const handle = window.setTimeout(() => {
      void loadGitBundle(rootPath, { preloadDiff: true });
    }, isOpen ? 80 : 180);
    return () => {
      window.clearTimeout(handle);
    };
  }, [diffPaneActive, gitBundleLastLoadedAt, gitBundleLoading, isOpen, loadGitBundle, rightTab, rootPath]);

  useEffect(() => {
    if (diffPaneActive) setHasMountedDiffPane(true);
  }, [diffPaneActive]);

  useEffect(() => {
    if (previewPaneActive) setHasMountedPreviewPane(true);
  }, [previewPaneActive]);

  const handleFileTreeScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (!rootPath) return;
    writeFileTreeScrollPosition(rootPath, event.currentTarget.scrollTop);
  }, [rootPath]);

  useEffect(() => {
    return () => {
      flushCacheThrottled(FILE_TREE_SCROLL_STORAGE_KEY);
    };
  }, []);

  useEffect(() => {
    if (!rootPath || !rootEntriesLoaded) return;
    const savedTop = readFileTreeScrollCache()[rootPath]?.top;
    if (typeof savedTop !== 'number') return;
    let frame = window.requestAnimationFrame(() => {
      if (fileTreeScrollRef.current) fileTreeScrollRef.current.scrollTop = savedTop;
      frame = window.requestAnimationFrame(() => {
        if (fileTreeScrollRef.current) fileTreeScrollRef.current.scrollTop = savedTop;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [rootEntriesLoaded, rootPath]);

  const handleFileSelect = useCallback((path: string) => {
    selectFile(path);
    setLineRange(null);
    if (isMobile) {
      setMobileFilePreviewOpen(true);
      return;
    }
    // In wide mode the preview is already visible alongside the tree, so we
    // don't need to switch tabs and steal focus from the user's browse flow.
    if (!isWide) setRightTab(isMobile ? 'files' : 'file');
  }, [isMobile, isWide, selectFile, setRightTab]);

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
    if (!rootPath) return t('rightSidebar.workspace');
    const normalized = rootPath.replace(/\/+$/, '');
    return normalized.split('/').pop() || normalized;
  }, [rootPath, t]);

  const changedSummary = useMemo(() => {
    const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, untracked: 0, conflicted: 0, staged: 0, other: 0 };
    for (const file of changedFiles.values()) {
      if (file.status === 'added') counts.added += 1;
      else if (file.status === 'modified') counts.modified += 1;
      else if (file.status === 'deleted') counts.deleted += 1;
      else if (file.status === 'renamed') counts.renamed += 1;
      else if (file.status === 'copied') counts.copied += 1;
      else if (file.status === 'untracked') counts.untracked += 1;
      else if (file.status === 'conflicted') counts.conflicted += 1;
      else counts.other += 1;
      if (file.staged) counts.staged += 1;
    }
    return counts;
  }, [changedFiles]);

  const filteredChangedFiles = useMemo(() => {
    const query = deferredFileQuery.trim().toLowerCase();
    const entries = Array.from(changedFiles.entries()).sort(([a], [b]) => a.localeCompare(b));
    if (!query) return entries;
    return entries.filter(([path, file]) => `${path} ${file.path} ${file.status}`.toLowerCase().includes(query));
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
    const files = gitContext?.changedFiles?.length ? gitContext.changedFiles : Array.from(changedFiles.values());
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
      .map(([path, file]) => `- ${file.status} ${buildPromptReference(path, rootPath)}`);
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
    insertContextText(t('rightSidebar.gitInfo'), gitContextInputText);
    if (!push) onClose();
  }, [gitContextInputText, insertContextText, onClose, push, t]);

  const selectDiffFile = useCallback((path: string | null) => {
    selectFile(path);
    setRightTab('diff');
  }, [selectFile, setRightTab]);

  const toggleDiffFile = useCallback((path: string) => {
    setExpandedDiffFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    selectFile(path);
    setRightTab('diff');
  }, [selectFile, setRightTab]);

  const runSidebarGitAction = useCallback(async (request: GitActionRequest, label: string, pathForBusy?: string): Promise<boolean> => {
    setGitActionError(null);
    setRunningGitAction({ action: request.action, path: pathForBusy });
    try {
      const result = await runGitAction(request);
      applyGitBundle(result.bundle, { reloadDiff: true });
      setLastInsertedReference(t('rightSidebar.gitActionSucceeded', { label }));
      window.setTimeout(() => setLastInsertedReference((current) => (
        current === t('rightSidebar.gitActionSucceeded', { label }) ? null : current
      )), 1400);
      setConfirmGitAction(null);
      return true;
    } catch (err) {
      setGitActionError(t('rightSidebar.gitActionFailed', { message: err instanceof Error ? err.message : 'Unknown error' }));
      return false;
    } finally {
      setRunningGitAction(null);
    }
  }, [applyGitBundle, t]);

  const handleQuickCommit = useCallback(async () => {
    if (!rootPath) return;
    const message = commitMessage.trim();
    if (!message) return;
    const ok = await runSidebarGitAction({ action: 'commit', cwd: rootPath, message }, t('rightSidebar.commitChanges'));
    if (ok) setCommitMessage('');
  }, [commitMessage, rootPath, runSidebarGitAction, t]);

  const handleQuickPush = useCallback(async () => {
    if (!rootPath) return;
    const remote = pushRemote.trim();
    const branch = pushBranch.trim();
    await runSidebarGitAction({
      action: 'push',
      cwd: rootPath,
      ...(remote ? { remote } : {}),
      ...(branch ? { branch } : {}),
    }, t('rightSidebar.pushChanges'));
  }, [pushBranch, pushRemote, rootPath, runSidebarGitAction, t]);

  const buildGitActionButtons = useCallback((file: GitChangedFile): GitActionButton[] => {
    if (!rootPath) return [];
    const buttons: GitActionButton[] = [];
    if (file.canStage) {
      buttons.push({
        key: 'stage-file',
        label: t('rightSidebar.stageFile'),
        onClick: () => void runSidebarGitAction({ action: 'stage-file', cwd: rootPath, paths: [file.path] }, t('rightSidebar.stageFile'), file.path),
      });
    }
    if (file.canUnstage) {
      buttons.push({
        key: 'unstage-file',
        label: t('rightSidebar.unstageFile'),
        onClick: () => void runSidebarGitAction({ action: 'unstage-file', cwd: rootPath, paths: [file.path] }, t('rightSidebar.unstageFile'), file.path),
      });
    }
    if (file.canStash) {
      buttons.push({
        key: 'stash-file',
        label: t('rightSidebar.stashFile'),
        onClick: () => void runSidebarGitAction({ action: 'stash-file', cwd: rootPath, paths: [file.path] }, t('rightSidebar.stashFile'), file.path),
      });
    }
    if (file.canRestoreWorktree) {
      buttons.push({
        key: 'restore-worktree-file',
        label: t('rightSidebar.restoreFile'),
        destructive: true,
        onClick: () => setConfirmGitAction({ kind: 'restore', file, phrase: '' }),
      });
    }
    return buttons;
  }, [rootPath, runSidebarGitAction, t]);

  const closeFilePreview = useCallback(() => {
    setMobileFilePreviewOpen(false);
    setLineRange(null);
  }, []);

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
            aria-label={t('rightSidebar.toggleSearch')}
            title={t('common.search')}
          >
            <RiSearch size={14} />
          </button>
          {gitContext?.available && (
            <button
              type="button"
              onClick={() => void refreshGitState()}
              disabled={gitBundleLoading}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:opacity-50 active:scale-95"
              aria-label={t('rightSidebar.refreshGit')}
              title={t('common.refresh')}
            >
              <RiRefresh size={13} className={gitBundleLoading ? 'animate-spin' : ''} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive active:scale-95"
            aria-label={t('rightSidebar.close')}
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
              placeholder={t('rightSidebar.filterChanges')}
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
                aria-label={t('rightSidebar.clearSearch')}
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
            {changedSummary.copied > 0 && (
              <span className="rounded bg-background-subtle px-1.5 py-0.5 text-[color:var(--diff-insert-strong)]">{changedSummary.copied}C</span>
            )}
            {changedSummary.untracked > 0 && (
              <span className="rounded bg-background-subtle px-1.5 py-0.5 text-[color:var(--diff-insert-strong)]">{changedSummary.untracked}U</span>
            )}
            {changedSummary.conflicted > 0 && (
              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">{changedSummary.conflicted}!</span>
            )}
            {changedSummary.other > 0 && (
              <span className="rounded bg-background-subtle px-1.5 py-0.5 text-muted-foreground">{changedSummary.other}?</span>
            )}
            {changedSummary.staged > 0 && (
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent">已暂存 {changedSummary.staged}</span>
            )}
            {gitContext?.available && rootPath && changedFiles.size > 0 && (
              <button
                type="button"
                onClick={() => void runSidebarGitAction({ action: 'stage-all', cwd: rootPath }, t('rightSidebar.stageAll'))}
                disabled={Boolean(runningGitAction)}
                className="rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
                title={t('rightSidebar.stageAll')}
              >
                {t('rightSidebar.stageAll')}
              </button>
            )}
            {gitContext?.available && rootPath && changedFiles.size > 0 && (
              <button
                type="button"
                onClick={() => setConfirmGitAction({ kind: 'stash-all' })}
                disabled={Boolean(runningGitAction)}
                className="rounded-full bg-background-subtle px-2 py-0.5 font-medium text-foreground hover:bg-surface-2 disabled:opacity-50"
                title={t('rightSidebar.stashAll')}
              >
                {t('rightSidebar.stashAll')}
              </button>
            )}
            {gitContext?.available && (
              <>
                <button
                  type="button"
                  onClick={insertGitContext}
                  className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary hover:bg-primary/20"
                  title={t('rightSidebar.insertGitContext')}
                >
                  {t('rightSidebar.insertPreset', { label: t('rightSidebar.gitInfo') })}
                </button>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(gitContextText)}
                  className="rounded-full bg-surface-2 px-2 py-0.5 text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
                  title={t('rightSidebar.copyGitContext')}
                >
                  {t('common.copy')}
                </button>
              </>
            )}
          </div>
        )}

        {gitContext?.available && rootPath && (
          <div className="mt-2 overflow-hidden rounded-xl border border-border/15 bg-background-subtle/60">
            <button
              type="button"
              onClick={() => setGitQuickActionsOpen((open) => !open)}
              aria-expanded={gitQuickActionsOpen}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-semibold text-foreground transition hover:bg-surface-2/60 active:scale-[0.99]"
            >
              <span className={`text-muted-foreground transition-transform ${gitQuickActionsOpen ? 'rotate-90' : ''}`}>
                <RiChevronRight size={13} />
              </span>
              <span className="min-w-0 flex-1 truncate">{t('rightSidebar.gitQuickActions')}</span>
              <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                {changedSummary.staged > 0 ? t('rightSidebar.stagedCount', { count: changedSummary.staged }) : t('rightSidebar.collapsedByDefault')}
              </span>
            </button>
            {gitQuickActionsOpen && (
              <div className="space-y-2 border-t border-border/10 px-3 py-2">
                <div className="flex gap-1.5">
                  <input
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault();
                        void handleQuickCommit();
                      }
                    }}
                    placeholder={t('rightSidebar.commitMessagePlaceholder')}
                    className="min-w-0 flex-1 rounded-lg border border-border/15 bg-surface px-2.5 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground"
                    maxLength={300}
                  />
                  <button
                    type="button"
                    onClick={() => void handleQuickCommit()}
                    disabled={Boolean(runningGitAction) || changedSummary.staged === 0 || !commitMessage.trim()}
                    className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50 active:scale-95"
                    title={changedSummary.staged === 0 ? t('rightSidebar.commitNeedsStaged') : t('rightSidebar.commitChanges')}
                  >
                    {runningGitAction?.action === 'commit' ? t('rightSidebar.gitActionRunning') : t('rightSidebar.commitChanges')}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    value={pushRemote}
                    onChange={(event) => setPushRemote(event.target.value)}
                    placeholder={t('rightSidebar.pushRemotePlaceholder')}
                    className="min-w-[5rem] flex-1 rounded-lg border border-border/15 bg-surface px-2.5 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <input
                    value={pushBranch}
                    onChange={(event) => setPushBranch(event.target.value)}
                    placeholder={t('rightSidebar.pushBranchPlaceholder', { branch: gitContext.branch ?? 'HEAD' })}
                    className="min-w-[6rem] flex-1 rounded-lg border border-border/15 bg-surface px-2.5 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => void handleQuickPush()}
                    disabled={Boolean(runningGitAction)}
                    className="shrink-0 rounded-lg bg-accent/15 px-3 py-1.5 text-[11px] font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-50 active:scale-95"
                    title={t('rightSidebar.pushChanges')}
                  >
                    {runningGitAction?.action === 'push' ? t('rightSidebar.gitActionRunning') : t('rightSidebar.pushChanges')}
                  </button>
                </div>
                <div className="text-[10px] leading-relaxed text-muted-foreground">
                  {t('rightSidebar.gitQuickActionsHint')}
                </div>
              </div>
            )}
          </div>
        )}

        {/* "Insert X" preset chips — always render so toggling visibility
            never reflows the header. The list of presets is a stable order
            and each chip occupies its own slot; we just hide unused ones. */}
        {(() => {
          const presets: { key: string; text: string; label: string; tone: 'primary' | 'accent' | 'subtle'; title: string }[] = [
            { key: 'changes', text: changeContextPackText, label: t('rightSidebar.presetAllChanges'), tone: 'primary', title: t('rightSidebar.insertGitContext') },
            { key: 'current', text: currentFileContextText, label: t('rightSidebar.presetCurrentFile'), tone: 'accent', title: t('rightSidebar.presetCurrentFile') },
            { key: 'search', text: searchContextText, label: t('rightSidebar.presetSearchResults'), tone: 'subtle', title: t('rightSidebar.presetSearchResults') },
            { key: 'recent', text: recentContextText, label: t('rightSidebar.presetRecent'), tone: 'subtle', title: t('rightSidebar.presetRecent') },
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
                    {t('rightSidebar.insertPreset', { label: preset.label })}
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
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{t('rightSidebar.recent')}</span>
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
                title={t('rightSidebar.clearRecent')}
              >
                {t('common.clear')}
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
              effectiveRightTab === 'diff'
                ? 'bg-surface-elevated text-foreground'
                : 'text-muted-foreground hover:bg-surface-2'
            }`}
          >
            <RiGitCompare size={12} />
            {t('rightSidebar.tabChanges')}
            {gitBundleLoading ? (
              <RiLoader size={12} className="animate-spin text-muted-foreground" />
            ) : changedFiles.size > 0 ? (
              <span className="text-[10px] text-accent">{changedFiles.size}</span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => setRightTab('files')}
            className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
              effectiveRightTab === 'files'
                ? 'bg-surface-elevated text-foreground'
                : 'text-muted-foreground hover:bg-surface-2'
            }`}
          >
            <RiFolder size={12} />
            {t('rightSidebar.tabFiles')}
          </button>
          {!isMobile && !isWide && (
            <button
              type="button"
              onClick={() => setRightTab('file')}
              className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                effectiveRightTab === 'file'
                  ? 'bg-surface-elevated text-foreground'
                  : 'text-muted-foreground hover:bg-surface-2'
              }`}
            >
              <RiFileText size={12} />
              {t('rightSidebar.tabPreview')}
            </button>
          )}
        </div>
        <div className="h-2" />

        {/* Toast — absolutely positioned so its 1.4 s lifetime doesn't push
            the tab bar or scroller. */}
        {lastInsertedReference && (
          <div className="pointer-events-none absolute right-12 top-2 z-10 max-w-[60%] truncate rounded-full bg-primary/90 px-3 py-1 text-[11px] font-medium text-primary-foreground shadow-md animate-fade-in">
            {t('rightSidebar.insertedToast', { label: lastInsertedReference })}
          </div>
        )}
        {gitActionError && (
          <div className="mx-1 mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {gitActionError}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Pane active={filesPaneActive}>
          {isWide ? (
            <div className="flex h-full min-h-0">
              <div
                ref={fileTreeScrollRef}
                onScroll={handleFileTreeScroll}
                className="w-[300px] min-w-[260px] shrink-0 overflow-y-auto overscroll-contain border-r border-border/15"
              >
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
          ) : isMobile ? (
            <div className="relative h-full min-h-0 overflow-hidden">
              <div
                ref={fileTreeScrollRef}
                onScroll={handleFileTreeScroll}
                className={`h-full overflow-y-auto overscroll-contain ${mobilePreviewActive ? 'hidden' : 'block'}`}
                aria-hidden={mobilePreviewActive}
              >
                <FileTree
                  rootPath={rootPath ?? ''}
                  onFileSelect={handleFileSelect}
                  onPathReference={insertPathReference}
                  selectedFilePath={selectedFilePath}
                  query={deferredFileQuery}
                />
              </div>
              <div className={`h-full overflow-hidden ${mobilePreviewActive ? 'block' : 'hidden'}`} aria-hidden={!mobilePreviewActive}>
                <FilePreview
                  filePath={selectedFilePath}
                  onInsertReference={insertPathReference}
                  onClose={closeFilePreview}
                  isMobile
                  lineRange={lineRange}
                  onLineRangeChange={setLineRange}
                />
              </div>
            </div>
          ) : (
            <div
              ref={fileTreeScrollRef}
              onScroll={handleFileTreeScroll}
              className="h-full overflow-y-auto overscroll-contain"
            >
              <FileTree
                rootPath={rootPath ?? ''}
                onFileSelect={handleFileSelect}
                onPathReference={insertPathReference}
                selectedFilePath={selectedFilePath}
                query={deferredFileQuery}
              />
            </div>
          )}
        </Pane>

        <Pane active={previewPaneActive} mounted={hasMountedPreviewPane}>
          <FilePreview
            filePath={selectedFilePath}
            onInsertReference={insertPathReference}
            isMobile={false}
            lineRange={lineRange}
            onLineRangeChange={setLineRange}
          />
        </Pane>

        <Pane active={diffPaneActive} mounted={hasMountedDiffPane}>
          {isWide ? (
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
                        {t('rightSidebar.allChanges')}
                      </button>
                      <span className="text-[10px] text-muted-foreground">{filteredChangedFiles.length}/{changedFiles.size}</span>
                    </div>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
                  {gitBundleLoading && changedFiles.size > 0 && <GitChangesRefreshingBanner />}
                  {gitBundleLoading && changedFiles.size === 0 && gitBundleLastLoadedAt === null ? (
                    <GitChangesLoadingState slow={gitBundleSlow} />
                  ) : gitBundleError && changedFiles.size === 0 ? (
                    <GitChangesErrorState message={gitBundleError} onRetry={() => void refreshGitState()} />
                  ) : changedFiles.size === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                      {t('rightSidebar.noChanges')}
                    </div>
                  ) : filteredChangedFiles.length === 0 ? (
                    <div className="bg-background-subtle px-3 py-4 text-center text-xs text-muted-foreground">
                      {t('rightSidebar.noMatchingChanges')}
                    </div>
                  ) : (
                    <div className="space-y-px">
                      {filteredChangedFiles.map(([absolutePath, file]) => {
                        const display = getRelativeDisplayPath(absolutePath, rootPath);
                        const relativePath = file.path;
                        const isSelected = selectedFilePath === relativePath || selectedFilePath === absolutePath;
                        const actions = buildGitActionButtons(file);
                        return (
                          <div
                            key={absolutePath}
                            className={`group rounded-lg px-2 py-1.5 transition ${
                              isSelected
                                ? 'bg-surface-elevated text-foreground'
                                : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                            }`}
                            title={absolutePath}
                          >
                            <button
                              type="button"
                              onClick={() => selectDiffFile(relativePath)}
                              className="flex w-full items-center gap-2 text-left active:scale-[0.99]"
                            >
                              <ChangeBadge status={file.status} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12px] font-medium">{display.name}</span>
                                {display.dir && <span className="block truncate text-[10px] text-muted-foreground/75">{display.dir}</span>}
                              </span>
                            </button>
                            <div className="mt-1 flex items-center justify-between gap-1 pl-6">
                              <GitActionChips actions={actions} running={runningGitAction} />
                              <button
                                type="button"
                                onClick={() => insertPathReference(absolutePath)}
                                className="ml-auto inline-flex h-6 shrink-0 items-center justify-center rounded-full bg-primary/10 px-2 text-[11px] font-semibold text-primary opacity-100 transition active:scale-95 md:opacity-0 md:group-hover:opacity-100"
                                title={t('rightSidebar.insertThisFile')}
                              >
                                {t('rightSidebar.insertFileRef')}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain">
                <DiffViewer active={diffPaneActive} filePath={selectedFilePath} reloadKey={diffRefreshKey} onInsertDiffReference={insertContextText} />
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {changedFiles.size > 0 && (
                <div className="shrink-0 border-b border-border/15 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t('rightSidebar.allChanges')}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {filteredChangedFiles.length}/{changedFiles.size}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDiffWrap((prev) => !prev)}
                      aria-pressed={diffWrap}
                      title={t('rightSidebar.wrapLongLines')}
                      className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition active:scale-95 ${
                        diffWrap
                          ? 'bg-primary/15 text-primary'
                          : 'bg-background-subtle text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span className="font-mono text-[12px] leading-none">Aa</span>
                      <span>{diffWrap ? t('rightSidebar.wrapOn') : t('rightSidebar.wrapOff')}</span>
                    </button>
                  </div>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
                {gitBundleLoading && changedFiles.size > 0 && <GitChangesRefreshingBanner />}
                {gitBundleLoading && changedFiles.size === 0 && gitBundleLastLoadedAt === null ? (
                  <GitChangesLoadingState slow={gitBundleSlow} />
                ) : gitBundleError && changedFiles.size === 0 ? (
                  <GitChangesErrorState message={gitBundleError} onRetry={() => void refreshGitState()} />
                ) : changedFiles.size === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {t('rightSidebar.noChanges')}
                  </div>
                ) : filteredChangedFiles.length === 0 ? (
                  <div className="bg-background-subtle px-3 py-4 text-center text-xs text-muted-foreground">
                    {t('rightSidebar.noMatchingChanges')}
                  </div>
                ) : (
                  <div className="space-y-1.5 pt-2">
                    {filteredChangedFiles.map(([absolutePath, file]) => {
                      const display = getRelativeDisplayPath(absolutePath, rootPath);
                      const relativePath = file.path;
                      const isExpanded = expandedDiffFiles.has(relativePath);
                      const isSelected = selectedFilePath === relativePath || selectedFilePath === absolutePath;
                      const actions = buildGitActionButtons(file);
                      return (
                        <section
                          key={absolutePath}
                          className={`relative scroll-mt-2 rounded-xl border transition ${
                            isExpanded
                              ? 'border-primary/25 bg-surface-elevated shadow-sm'
                              : 'overflow-hidden border-border/15 bg-surface hover:border-border/30'
                          }`}
                        >
                          <div
                            className={`sticky -top-px z-20 flex w-full items-center gap-1 rounded-t-xl ${
                              isExpanded ? 'border-b border-border/15 bg-surface-elevated shadow-sm' : ''
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => toggleDiffFile(relativePath)}
                              aria-expanded={isExpanded}
                              className="group flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2.5 text-left transition active:scale-[0.99]"
                              title={absolutePath}
                            >
                              <span className={`shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-0' : ''}`}>
                                {isExpanded ? <RiChevronDown size={15} /> : <RiChevronRight size={15} />}
                              </span>
                              <ChangeBadge status={file.status} />
                              <span className="min-w-0 flex-1">
                                <span className={`block truncate text-[13px] ${isSelected || isExpanded ? 'font-semibold text-foreground' : 'font-medium text-foreground'}`}>{display.name}</span>
                                {display.dir && <span className="block truncate text-[10px] text-muted-foreground/75">{display.dir}</span>}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                insertPathReference(absolutePath);
                              }}
                              className="mr-2 inline-flex h-7 min-w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 px-2 text-[11px] font-semibold text-primary transition active:scale-95 sm:h-6 sm:min-w-8 md:opacity-0 md:group-hover:opacity-100"
                              title={t('rightSidebar.insertThisFile')}
                            >
                              {t('rightSidebar.insertFileRef')}
                            </button>
                          </div>
                          {actions.length > 0 && (
                            <div className="flex border-t border-border/10 px-2 py-1.5">
                              <GitActionChips actions={actions} running={runningGitAction} />
                            </div>
                          )}
                          {isExpanded && (
                            <div>
                              <DiffViewer
                                active={diffPaneActive}
                                filePath={relativePath}
                                wrap={diffWrap}
                                showScrollHint={!diffWrap}
                                reloadKey={diffRefreshKey}
                                embedded
                                onInsertDiffReference={insertContextText}
                              />
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </Pane>
      </div>
        {confirmGitAction && (
          <div className="fixed inset-0 z-[70] bg-[rgba(0,0,0,0.42)] backdrop-blur-sm" onClick={() => setConfirmGitAction(null)}>
            <div
              className="fixed inset-x-3 bottom-6 mx-auto max-w-md rounded-2xl border border-border/20 bg-surface-elevated p-4 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="text-sm font-semibold text-foreground">
                {confirmGitAction.kind === 'restore' ? t('rightSidebar.confirmRestoreTitle') : t('rightSidebar.confirmStashAllTitle')}
              </div>
              <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {confirmGitAction.kind === 'restore'
                  ? t('rightSidebar.confirmRestoreDescription', { path: buildFileReference(confirmGitAction.file.absolutePath, rootPath) })
                  : t('rightSidebar.confirmStashAllDescription')}
              </div>
              {confirmGitAction.kind === 'restore' && (
                <input
                  value={confirmGitAction.phrase}
                  onChange={(event) => setConfirmGitAction({ ...confirmGitAction, phrase: event.target.value })}
                  placeholder={t('rightSidebar.confirmRestorePlaceholder')}
                  className="mt-3 w-full rounded-xl border border-border/20 bg-background-subtle px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                  autoFocus
                />
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmGitAction(null)}
                  className="rounded-full bg-background-subtle px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={Boolean(runningGitAction) || (confirmGitAction.kind === 'restore' && confirmGitAction.phrase.trim() !== t('rightSidebar.confirmRestorePhrase'))}
                  onClick={() => {
                    if (!rootPath) return;
                    if (confirmGitAction.kind === 'restore') {
                      void runSidebarGitAction({
                        action: 'restore-worktree-file',
                        cwd: rootPath,
                        paths: [confirmGitAction.file.path],
                        confirm: { acknowledged: true, phrase: confirmGitAction.phrase },
                      }, t('rightSidebar.restoreFile'), confirmGitAction.file.path);
                    } else {
                      void runSidebarGitAction({ action: 'stash-all', cwd: rootPath }, t('rightSidebar.stashAll'));
                    }
                  }}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                    confirmGitAction.kind === 'restore'
                      ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'
                  }`}
                >
                  {runningGitAction ? t('rightSidebar.gitActionRunning') : t('rightSidebar.confirmAction')}
                </button>
              </div>
            </div>
          </div>
        )}
    </Sidebar>
  );
}
