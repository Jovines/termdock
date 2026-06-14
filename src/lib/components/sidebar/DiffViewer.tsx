import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { GitCompare as RiGitCompare, Loader2 as RiLoader, MoveHorizontal as RiMoveHorizontal } from 'lucide-react';
import { parseDiff, Diff, Hunk, Decoration } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { getFileDiff, isPreviewableImagePath, readImagePreviewBlob } from '../../terminal/api';
import { useI18n } from '../../i18n';

const MAX_DIFF_CACHE_ENTRIES = 24;

type DiffLoadResult = { path: string | null; diff: string; error?: string };

const diffResultCache = new Map<string, DiffLoadResult>();
const diffPromiseCache = new Map<string, Promise<DiffLoadResult>>();
const diffCacheVersions = new Map<string, number>();

function buildDiffCacheKey(filePath: string | undefined, cwd: string | undefined): string {
  return `${cwd ?? ''}\u0000${filePath ?? ''}`;
}

function rememberDiffResult(key: string, result: DiffLoadResult): DiffLoadResult {
  if (diffResultCache.has(key)) diffResultCache.delete(key);
  diffResultCache.set(key, result);
  while (diffResultCache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldest = diffResultCache.keys().next().value;
    if (oldest === undefined) break;
    diffResultCache.delete(oldest);
  }
  return result;
}

function loadFileDiffCached(filePath: string | undefined, cwd: string | undefined, force = false): Promise<DiffLoadResult> {
  const key = buildDiffCacheKey(filePath, cwd);
  if (force) {
    diffResultCache.delete(key);
    diffPromiseCache.delete(key);
    diffCacheVersions.set(key, (diffCacheVersions.get(key) ?? 0) + 1);
  }
  const version = diffCacheVersions.get(key) ?? 0;

  const cached = diffResultCache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = diffPromiseCache.get(key);
  if (pending) return pending;

  const promise = getFileDiff(filePath, undefined, cwd)
    .then((result) => (diffCacheVersions.get(key) ?? 0) === version ? rememberDiffResult(key, result) : result)
    .finally(() => {
      if (diffPromiseCache.get(key) === promise) diffPromiseCache.delete(key);
    });
  diffPromiseCache.set(key, promise);
  return promise;
}

function toDiffRequestPath(path: string | null, rootPath: string | null): string | undefined {
  if (!path) return undefined;
  return rootPath && path.startsWith(`${rootPath}/`)
    ? path.slice(rootPath.length + 1)
    : path;
}

export function preloadSidebarDiff(rootPath: string | null | undefined, filePath: string | null, options: { force?: boolean } = {}): void {
  if (!rootPath) return;
  const requestPath = toDiffRequestPath(filePath, rootPath);
  void loadFileDiffCached(requestPath, rootPath, options.force).catch(() => {
    // Preload is best-effort; DiffViewer will surface errors when it becomes visible.
  });
}

interface DiffViewerProps {
  filePath: string | null;
  onInsertDiffReference?: (label: string, text: string) => void;
  /**
   * When true, long diff lines wrap inside each cell instead of forcing a
   * horizontal scroll. Helpful on phone-sized panels.
   */
  wrap?: boolean;
  /**
   * When true, render a small inline hint above each file's diff row to
   * tell the user the content can be swiped horizontally. Only shown when
   * `wrap` is off — the hint would lie otherwise.
   */
  showScrollHint?: boolean;
  /** Re-fetch the current diff even when the file path did not change. */
  reloadKey?: number;
  /**
   * Render only the diff body, without the outer summary/file chrome.
   * Used by the mobile accordion where the list row is the file header.
   */
  embedded?: boolean;
  /** Keep mounted panes from issuing background diff requests while hidden. */
  active?: boolean;
}

function getPathParts(path: string | null, fallback: { name: string; dir: string }): { name: string; dir: string } {
  if (!path) return fallback;
  const parts = path.split('/').filter(Boolean);
  return {
    name: parts.pop() || path,
    dir: parts.join('/'),
  };
}

function formatDiffReference(diffText: string): string {
  return `${diffText.trimEnd()}\n`;
}

/**
 * Inline hint that says "swipe to see more" above a file's diff row.
 * Self-dismisses on first tap so it doesn't get in the way of repeat
 * visits — the user has seen it once, they know now.
 */
function DiffScrollHint() {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <button
      type="button"
      onClick={() => setDismissed(true)}
      className="flex w-full items-center justify-center gap-1.5 border-b border-border/15 bg-surface-2/40 px-2 py-1 text-[10px] text-muted-foreground transition active:scale-[0.99] hover:bg-surface-2 hover:text-foreground"
      title={t('rightSidebar.horizontalScrollHint')}
    >
      <RiMoveHorizontal size={11} className="shrink-0" />
      <span className="truncate">{t('rightSidebar.horizontalScrollHint')}</span>
    </button>
  );
}

export function DiffViewer({ filePath, onInsertDiffReference, wrap = false, showScrollHint = false, reloadKey = 0, embedded = false, active = true }: DiffViewerProps) {
  const { t } = useI18n();
  // Each viewer owns its request state. This is important for the mobile
  // accordion: multiple files can stay expanded without fighting over one
  // global diff slot in the sidebar store.
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<{
    objectUrl: string;
    size: number | null;
    mimeType: string;
    dimensions?: { width: number; height: number };
  } | null>(null);
  const rootPath = useSidebarStore((s) => s.rootPath);
  const previousReloadKeyRef = useRef(reloadKey);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    const path = filePath;

    const requestPath = toDiffRequestPath(path, rootPath);
    const readablePath = path && rootPath && !path.startsWith('/') ? `${rootPath}/${path}` : path;
    const forceReload = previousReloadKeyRef.current !== reloadKey;
    previousReloadKeyRef.current = reloadKey;

    setDiffContent(null);
    setDiffLoading(true);
    setDiffError(null);
    setImagePreview(null);

    if (readablePath && isPreviewableImagePath(readablePath)) {
      readImagePreviewBlob(readablePath, controller.signal)
        .then((result) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(result.blob);
          setImagePreview({ objectUrl, size: result.size, mimeType: result.mimeType });
        })
        .catch((err) => {
          if (cancelled || controller.signal.aborted) return;
          setDiffError(err instanceof Error ? err.message : t('rightSidebar.imageLoadFailed'));
        })
        .finally(() => {
          if (!cancelled) setDiffLoading(false);
        });
    } else {
      loadFileDiffCached(requestPath, rootPath ?? undefined, forceReload)
        .then((result) => {
          if (cancelled) return;
          setDiffContent(result.diff);
          setDiffError(result.error ?? null);
        })
        .catch((err) => {
          if (cancelled) return;
          setDiffContent(null);
          setDiffError(err instanceof Error ? err.message : 'Failed to load diff');
        })
        .finally(() => {
          if (!cancelled) setDiffLoading(false);
        });
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active, filePath, reloadKey, rootPath, t]);

  const files = useMemo(() => {
    if (!diffContent || diffContent.trim() === '') return [];
    return parseDiff(diffContent);
  }, [diffContent]);

  const totalChanges = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          if (change.type === 'insert') additions += 1;
          if (change.type === 'delete') deletions += 1;
        }
      }
    }
    return { additions, deletions };
  }, [files]);

  const fileStats = useMemo(() => {
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const file of files) {
      let additions = 0;
      let deletions = 0;
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          if (change.type === 'insert') additions += 1;
          if (change.type === 'delete') deletions += 1;
        }
      }
      stats.set(`${file.oldRevision}-${file.newRevision}-${file.newPath}`, { additions, deletions });
    }
    return stats;
  }, [files]);

  const titleParts = getPathParts(filePath, { name: t('diffViewer.workingTree'), dir: t('diffViewer.allUnstaged') });

  const insertWholeDiff = () => {
    if (!diffContent || !onInsertDiffReference) return;
    onInsertDiffReference(filePath ? `${titleParts.name} diff` : t('diffViewer.allDiffLabel'), formatDiffReference(diffContent));
  };

  const renderFileDiffs = (hideSingleFileHeader: boolean) => (
    <>
      {files.map((file) => {
        const key = `${file.oldRevision}-${file.newRevision}-${file.newPath}`;
        const stats = fileStats.get(key) ?? { additions: 0, deletions: 0 };
        const pathParts = getPathParts(file.newPath || file.oldPath, { name: 'unknown file', dir: '' });
        const displayPath = file.newPath || file.oldPath || 'unknown file';
        const showFileHeader = !hideSingleFileHeader || files.length > 1;
        const fileDiffText = [
          `diff --git a/${file.oldPath || displayPath} b/${file.newPath || displayPath}`,
          ...file.hunks.flatMap((hunk) => [hunk.content, ...hunk.changes.map((change) => change.content)]),
        ].join('\n');
        return (
        // Keep a stable file anchor on each parsed diff block. It is useful for
        // deep links/debugging and preserves the previous DOM contract even when
        // the mobile UI renders each file inline as an accordion body.
        <div
          key={key}
          data-diff-file-anchor={displayPath}
          className={embedded ? 'overflow-hidden bg-surface' : 'mt-3 overflow-hidden border border-border/20 bg-surface'}
        >
          {showFileHeader && (
            <div className="flex items-center justify-between gap-3 border-b border-border/15 bg-background-subtle px-2 py-1.5">
              <div className="min-w-0" title={file.newPath || file.oldPath}>
                <div className="truncate font-mono text-[11px] text-foreground">{pathParts.name}</div>
                {pathParts.dir && <div className="truncate font-mono text-[10px] text-muted-foreground/70">{pathParts.dir}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="text-[10px] font-medium text-[color:var(--diff-insert-strong)]">+{stats.additions}</span>
                <span className="text-[10px] font-medium text-[color:var(--diff-delete-strong)]">-{stats.deletions}</span>
                {onInsertDiffReference && files.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onInsertDiffReference(`${pathParts.name} diff`, formatDiffReference(fileDiffText))}
                    className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/20 active:scale-95"
                    title={t('diffViewer.insertFileDiff')}
                  >
                    引用
                  </button>
                )}
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {file.type}
                </span>
              </div>
            </div>
          )}
          {/* Scroll hint: only shown when wrap is off (otherwise it would
              lie) and only once per file per visit, dismissed by tap. The
              user still gets the visual cue without it nagging on every
              open. */}
          {showScrollHint && !wrap && <DiffScrollHint />}
          {/*
            `termdock-diff-scroll` opts this card into a CSS rule that
            sets `touch-action: pan-x` on the inner overflow element. That
            tells the browser the user wants horizontal panning on touch
            here, so it doesn't get hijacked by the parent vertical
            scroller's overscroll/pan-y chain.
            `termdock-diff-wrap` flips long lines to wrap mode instead.
          */}
          <div className={`overflow-x-auto termdock-diff-scroll ${wrap ? 'termdock-diff-wrap' : ''}`}>
            <Diff
              viewType="unified"
              diffType={file.type}
              hunks={file.hunks}
            >
              {(hunks) =>
                hunks.map((hunk, index) => {
                  const hunkDiffText = [hunk.content, ...hunk.changes.map((change) => change.content)].join('\n');
                  return (
                  <Fragment key={hunk.content}>
                    <Decoration>
                      <span className="diff-hunk-header flex min-w-0 items-center justify-between gap-3">
                        <span className="min-w-0 truncate">{hunk.content}</span>
                        {onInsertDiffReference && (
                          <button
                            type="button"
                            onClick={() => onInsertDiffReference(`${pathParts.name} hunk ${index + 1}`, formatDiffReference(hunkDiffText))}
                            className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/25 active:scale-95"
                            title={t('diffViewer.insertHunkDiff')}
                          >
                            引用hunk
                          </button>
                        )}
                      </span>
                    </Decoration>
                    <Hunk hunk={hunk} />
                  </Fragment>
                  );
                })
              }
            </Diff>
          </div>
        </div>
        );
      })}
    </>
  );

  if (diffLoading) {
    return embedded ? (
      <div className="flex items-center justify-center gap-2 bg-background-subtle py-6 text-xs text-muted-foreground">
        <RiLoader size={18} className="animate-spin" />
        <span>{t('diffViewer.loading')}</span>
      </div>
    ) : (
      <div className="mx-3 mt-3 flex items-center justify-center gap-2 border border-border/15 bg-background-subtle py-8 text-sm text-muted-foreground">
        <RiLoader size={20} className="animate-spin" />
        <span>{t('diffViewer.loading')}</span>
      </div>
    );
  }

  if (diffError) {
    return embedded ? (
      <div className="bg-destructive/5 px-3 py-3 text-xs text-destructive">
        {diffError}
      </div>
    ) : (
      <div className="mx-3 mt-3 border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">
        {diffError}
      </div>
    );
  }

  if (imagePreview) {
    const body = (
      <div className="bg-background-subtle p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span>{t('rightSidebar.imagePreviewHint')}</span>
          {imagePreview.size !== null && <span>{imagePreview.size.toLocaleString()} bytes</span>}
          <span>{imagePreview.mimeType}</span>
          {imagePreview.dimensions && <span>{imagePreview.dimensions.width} × {imagePreview.dimensions.height}</span>}
        </div>
        <div className="flex min-h-64 items-center justify-center">
          <img
            src={imagePreview.objectUrl}
            alt={titleParts.name}
            className="max-h-[70vh] max-w-full rounded border border-border/15 bg-surface object-contain shadow-sm"
            onLoad={(event) => {
              const img = event.currentTarget;
              setImagePreview((current) => current
                ? { ...current, dimensions: { width: img.naturalWidth, height: img.naturalHeight } }
                : current);
            }}
            onError={() => setDiffError(t('rightSidebar.imageLoadFailed'))}
          />
        </div>
      </div>
    );

    if (embedded) {
      return <div className="overflow-hidden bg-surface">{body}</div>;
    }

    return (
      <div className="termdock-diff px-3 py-2">
        <div className="border-b border-border/15 px-1 pb-2">
          <div className="truncate text-sm font-medium text-foreground" title={filePath ?? undefined}>{titleParts.name}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            {titleParts.dir && <span className="min-w-0 truncate">{titleParts.dir}</span>}
          </div>
        </div>
        <div className="mt-3 overflow-hidden border border-border/20 bg-surface">{body}</div>
      </div>
    );
  }

  if (files.length === 0) {
    return embedded ? (
      <div className="bg-background-subtle px-3 py-5 text-center text-xs text-muted-foreground">
        <RiGitCompare size={20} className="mx-auto mb-2 text-muted-foreground/80" />
        {filePath ? t('diffViewer.noFileChanges') : t('diffViewer.noUnstagedChanges')}
      </div>
    ) : (
      <div className="mx-3 mt-3 border border-border/15 bg-background-subtle px-4 py-8 text-center text-sm text-muted-foreground">
        <RiGitCompare size={24} className="mx-auto mb-2 text-muted-foreground/80" />
        {filePath ? t('diffViewer.noFileChanges') : t('diffViewer.noUnstagedChanges')}
      </div>
    );
  }

  if (embedded) {
    return (
      <div className="termdock-diff termdock-diff-card-mobile">
        {renderFileDiffs(true)}
      </div>
    );
  }

  return (
    <div className="termdock-diff px-3 py-2">
      <div className="border-b border-border/15 px-1 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground" title={filePath ?? undefined}>
              {titleParts.name}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
              {titleParts.dir && <span className="min-w-0 truncate">{titleParts.dir}</span>}
              <span>{files.length} file{files.length > 1 ? 's' : ''}</span>
              <span className="text-[color:var(--diff-insert-strong)]">+{totalChanges.additions}</span>
              <span className="text-[color:var(--diff-delete-strong)]">-{totalChanges.deletions}</span>
            </div>
          </div>
          {onInsertDiffReference && (
            <button
              type="button"
              onClick={insertWholeDiff}
              className="inline-flex h-8 shrink-0 items-center rounded-full bg-primary/15 px-3 text-[11px] font-semibold text-primary transition hover:bg-primary/25 active:scale-95"
              title={t('diffViewer.insertAllDiff')}
            >
              引用diff
            </button>
          )}
        </div>
      </div>
      {renderFileDiffs(false)}
    </div>
  );
}
