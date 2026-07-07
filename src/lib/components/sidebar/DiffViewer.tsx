import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitCompare as RiGitCompare, Loader2 as RiLoader, MoveHorizontal as RiMoveHorizontal } from 'lucide-react';
import { parseDiff, Diff, Hunk, Decoration, tokenize, type HunkData, type HunkTokens } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { cancelIoSlot, getFileDiff, isPreviewableImagePath, readImagePreviewBlob, type FileDiffResponse, type GitChangedFile } from '../../terminal/api';
import { useI18n } from '../../i18n';
import { loadRefractor, resolveLanguage, MAX_HIGHLIGHT_BYTES, MAX_HIGHLIGHT_LINE_LENGTH, type RefractorLike } from '../../utils/syntaxHighlight';
import { useReferenceLongPressCopy } from './referenceLongPress';

const MAX_DIFF_CACHE_ENTRIES = 24;
const MAX_RENDER_DIFF_LINES = 8_000;

type DiffLoadResult = FileDiffResponse;

const diffResultCache = new Map<string, DiffLoadResult>();
const diffPromiseCache = new Map<string, Promise<DiffLoadResult>>();
const diffCacheVersions = new Map<string, number>();
const diffPreloadControllers = new Map<string, AbortController>();
let diffViewerLogSeq = 0;
let diffLoadingSeq = 0;
let diffTraceSeq = 0;

function logDiffViewerEvent(event: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    level: 'info',
    message: `DIFF_VIEWER ${event}`,
    data: {
      seq: ++diffViewerLogSeq,
      ts: Date.now(),
      ...data,
    },
  });
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}

function logDiffLoadingEvent(event: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    level: event === 'still_active' ? 'warn' : 'info',
    message: `DIFF_LOADING ${event}`,
    data: {
      ts: Date.now(),
      ...data,
    },
  });
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}

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

function cancelPreloadDiff(key: string): void {
  const controller = diffPreloadControllers.get(key);
  if (!controller) return;
  diffPreloadControllers.delete(key);
  controller.abort();
}

function requestFileDiffCached(key: string, filePath: string | undefined, cwd: string | undefined, version: number, traceId?: string): Promise<DiffLoadResult> {
  const pending = diffPromiseCache.get(key);
  if (pending) {
    logDiffViewerEvent('preload_reuse_pending', { traceId, key, filePath, cwd });
    return pending;
  }

  const controller = new AbortController();
  diffPreloadControllers.set(key, controller);
  logDiffViewerEvent('preload_start', { traceId, key, filePath, cwd, version });
  const promise = getFileDiff(filePath, undefined, cwd, controller.signal, 'preload_diff', traceId)
    .then((result) => {
      logDiffViewerEvent('preload_result', { traceId, key, filePath, cwd, bytes: result.diff?.length ?? 0, error: result.error ?? null, tooLarge: Boolean(result.tooLarge) });
      return (diffCacheVersions.get(key) ?? 0) === version ? rememberDiffResult(key, result) : result;
    })
    .catch((error) => {
      logDiffViewerEvent('preload_error', { traceId, key, filePath, cwd, error: error instanceof Error ? error.message : String(error) });
      throw error;
    })
    .finally(() => {
      if (diffPromiseCache.get(key) === promise) diffPromiseCache.delete(key);
      if (diffPreloadControllers.get(key) === controller) diffPreloadControllers.delete(key);
    });
  diffPromiseCache.set(key, promise);
  return promise;
}

function getCachedDiffResult(filePath: string | undefined, cwd: string | undefined): DiffLoadResult | undefined {
  return diffResultCache.get(buildDiffCacheKey(filePath, cwd));
}

function loadFileDiffCached(filePath: string | undefined, cwd: string | undefined, force = false): Promise<DiffLoadResult> {
  const key = buildDiffCacheKey(filePath, cwd);
  if (force) {
    cancelPreloadDiff(key);
    diffResultCache.delete(key);
    diffPromiseCache.delete(key);
    diffCacheVersions.set(key, (diffCacheVersions.get(key) ?? 0) + 1);
  }
  const version = diffCacheVersions.get(key) ?? 0;

  const cached = diffResultCache.get(key);
  if (cached) return Promise.resolve(cached);

  return requestFileDiffCached(key, filePath, cwd, version);
}

function loadVisibleFileDiff(filePath: string | undefined, cwd: string | undefined, signal: AbortSignal, force = false, traceId?: string, interactionId?: string | null, requestSlotId?: string | null): Promise<DiffLoadResult> {
  const key = buildDiffCacheKey(filePath, cwd);
  if (force) {
    cancelPreloadDiff(key);
    diffResultCache.delete(key);
    diffPromiseCache.delete(key);
    diffCacheVersions.set(key, (diffCacheVersions.get(key) ?? 0) + 1);
  }
  const cached = diffResultCache.get(key);
  if (cached && !force) {
    logDiffViewerEvent('visible_cache_hit', { traceId, key, filePath, cwd, bytes: cached.diff?.length ?? 0, error: cached.error ?? null });
    return Promise.resolve(cached);
  }
  const version = diffCacheVersions.get(key) ?? 0;
  const pending = diffPromiseCache.get(key);
  if (pending && !force && !diffPreloadControllers.has(key)) {
    logDiffViewerEvent('visible_reuse_pending', { traceId, key, filePath, cwd });
    return pending;
  }
  cancelPreloadDiff(key);
  logDiffViewerEvent('visible_start', { interactionId, requestSlotId, traceId, key, filePath, cwd, force, version, replacedPreload: Boolean(pending), pendingExists: Boolean(pending), cacheSize: diffResultCache.size, promiseSize: diffPromiseCache.size });
  const promise = getFileDiff(filePath, undefined, cwd, signal, 'view_diff', traceId, interactionId ?? undefined, requestSlotId ?? undefined)
    .then((result) => {
      logDiffViewerEvent('visible_result', { interactionId, requestSlotId, traceId, key, filePath, cwd, bytes: result.diff?.length ?? 0, error: result.error ?? null, tooLarge: Boolean(result.tooLarge), truncated: Boolean(result.truncated) });
      return (diffCacheVersions.get(key) ?? 0) === version ? rememberDiffResult(key, result) : result;
    })
    .catch((error) => {
      logDiffViewerEvent('visible_error', { interactionId, requestSlotId, traceId, key, filePath, cwd, error: error instanceof Error ? error.message : String(error), aborted: signal.aborted, abortReason: signal.aborted ? String(signal.reason ?? '') : undefined });
      throw error;
    })
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

export function preloadSidebarDiff(rootPath: string | null | undefined, filePath: string | null, options: { force?: boolean; repoRoot?: string | null } = {}): void {
  const cwd = options.repoRoot ?? rootPath;
  if (!cwd || !filePath) return;
  const requestPath = toDiffRequestPath(filePath, cwd);
  void loadFileDiffCached(requestPath, cwd, options.force).catch(() => {
    // Preload is best-effort; DiffViewer will surface errors when it becomes visible.
  });
}

interface DiffViewerProps {
  filePath: string | null;
  repoRoot?: string | null;
  interactionId?: string | null;
  requestSlotId?: string | null;
  changedFile?: GitChangedFile | null;
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
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

function shouldPreferImagePreview(readablePath: string | null, changedFile: Pick<GitChangedFile, 'status'> | null | undefined): boolean {
  if (!readablePath || !isPreviewableImagePath(readablePath)) return false;
  // Deleted files no longer exist on disk, so blob preview would 404 and hide
  // the useful Git deletion diff. Renames/copies are also better represented as
  // Git metadata first; otherwise the image preview loses the old -> new path.
  return changedFile?.status !== 'deleted' && changedFile?.status !== 'renamed' && changedFile?.status !== 'copied';
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function formatDiffLimitMessage(result: DiffLoadResult): string | null {
  if (result.tooLarge) {
    const size = formatBytes(result.size);
    const max = formatBytes(result.maxBytes);
    return `Diff is too large${size ? ` (${size}` : ''}${max ? `${size ? ', ' : ' ('}limit ${max}` : ''}${size || max ? ')' : ''}.`;
  }
  if (result.skippedFiles && result.skippedFiles.length > 0) {
    const first = result.skippedFiles[0];
    const size = formatBytes(first.size);
    const suffix = result.skippedFiles.length > 1 ? ` and ${result.skippedFiles.length - 1} more file(s)` : '';
    return `Skipped large untracked file ${first.path}${size ? ` (${size})` : ''}${suffix}.`;
  }
  return null;
}

function isDiffTooLargeToRender(diffText: string | null): boolean {
  if (!diffText) return false;
  let lines = 1;
  for (let i = 0; i < diffText.length; i += 1) {
    if (diffText.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > MAX_RENDER_DIFF_LINES) return true;
    }
  }
  return false;
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

export function DiffViewer({ filePath, repoRoot, interactionId, requestSlotId, changedFile, onInsertDiffReference, onReferenceCopied, insertedReferenceKey, copiedReferenceKey, wrap = false, showScrollHint = false, reloadKey = 0, embedded = false, active = true }: DiffViewerProps) {
  const { t } = useI18n();
  // Each viewer owns its request state. This is important for the mobile
  // accordion: multiple files can stay expanded without fighting over one
  // global diff slot in the sidebar store.
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffNotice, setDiffNotice] = useState<string | null>(null);
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
  const getReferenceLongPressHandlers = useReferenceLongPressCopy(onReferenceCopied);
  const changedFileRepoRoot = changedFile?.repoRoot ?? null;
  const changedFileStatus = changedFile?.status ?? null;

  useEffect(() => {
    if (!active) {
      setDiffLoading(false);
      logDiffViewerEvent('effect_skip_inactive', { interactionId, requestSlotId, filePath, repoRoot, changedFileRepoRoot, rootPath });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    const path = filePath;
    const gitRoot = changedFileRepoRoot ?? repoRoot ?? (path?.startsWith('/') ? null : rootPath);
    const loadingId = ++diffLoadingSeq;
    const traceId = `diff-${Date.now().toString(36)}-${(++diffTraceSeq).toString(36)}`;
    let loadingEnded = false;
    const startedAt = performance.now();

    const endLoading = (reason: string, extra: Record<string, unknown> = {}) => {
      if (loadingEnded) return;
      loadingEnded = true;
      logDiffLoadingEvent('end', {
        loadingId,
        interactionId,
        requestSlotId,
        traceId,
        reason,
        durationMs: Math.round(performance.now() - startedAt),
        filePath: path,
        gitRoot,
        ...extra,
      });
    };

    const requestPath = toDiffRequestPath(path, gitRoot);
    const readablePath = path && gitRoot && !path.startsWith('/') ? `${gitRoot}/${path}` : path;
    const forceReload = previousReloadKeyRef.current !== reloadKey;
    previousReloadKeyRef.current = reloadKey;

    if (path && !gitRoot) {
      logDiffViewerEvent('effect_wait_for_repo_root', { interactionId, requestSlotId, traceId, filePath: path, repoRoot, changedFileRepoRoot, rootPath });
      setDiffContent(null);
      setDiffNotice(null);
      setDiffError(null);
      setImagePreview(null);
      setDiffLoading(false);
      endLoading('waiting_for_repo_root');
      return;
    }

    const cachedDiff = !forceReload ? getCachedDiffResult(requestPath, gitRoot ?? undefined) : undefined;
    logDiffLoadingEvent('start', {
      loadingId,
      interactionId,
      requestSlotId,
      traceId,
      filePath: path,
      requestPath,
      gitRoot,
      readablePath,
      forceReload,
      hasCachedDiff: Boolean(cachedDiff),
      embedded,
      active,
    });
    const watchdog = window.setTimeout(() => {
      if (loadingEnded || cancelled) return;
      logDiffLoadingEvent('still_active', {
        loadingId,
        interactionId,
        requestSlotId,
        traceId,
        filePath: path,
        requestPath,
        gitRoot,
        durationMs: Math.round(performance.now() - startedAt),
        hasCachedDiff: Boolean(cachedDiff),
        controllerAborted: controller.signal.aborted,
        abortReason: controller.signal.aborted ? String(controller.signal.reason ?? '') : undefined,
        cacheSize: diffResultCache.size,
        promiseSize: diffPromiseCache.size,
      });
    }, 3_000);
    const longWatchdog = window.setTimeout(() => {
      if (loadingEnded || cancelled) return;
      logDiffLoadingEvent('still_active_long', {
        loadingId,
        interactionId,
        requestSlotId,
        traceId,
        filePath: path,
        requestPath,
        gitRoot,
        durationMs: Math.round(performance.now() - startedAt),
        hasCachedDiff: Boolean(cachedDiff),
        controllerAborted: controller.signal.aborted,
        abortReason: controller.signal.aborted ? String(controller.signal.reason ?? '') : undefined,
        cacheSize: diffResultCache.size,
        promiseSize: diffPromiseCache.size,
      });
      setDiffError('Diff response is taking too long to finish in the browser. Try selecting the file again.');
      setDiffLoading(false);
      endLoading('client_watchdog_timeout');
    }, 10_000);
    logDiffViewerEvent('effect_start', {
      interactionId,
      requestSlotId,
      traceId,
      loadingId,
      filePath: path,
      requestPath,
      gitRoot,
      readablePath,
      forceReload,
      hasCachedDiff: Boolean(cachedDiff),
      cachedBytes: cachedDiff?.diff?.length ?? 0,
    });
    setDiffContent(cachedDiff?.diff ?? null);
    setDiffNotice(cachedDiff ? formatDiffLimitMessage(cachedDiff) : null);
    setDiffLoading(!cachedDiff);
    setDiffError(cachedDiff?.error ?? null);
    setImagePreview(null);

    const loadTextDiff = () => (
      loadVisibleFileDiff(requestPath, gitRoot ?? undefined, controller.signal, forceReload, traceId, interactionId, requestSlotId)
        .then((result) => {
          if (cancelled) return;
          const notice = formatDiffLimitMessage(result);
          const tooLargeToRender = isDiffTooLargeToRender(result.diff);
          setDiffNotice(tooLargeToRender ? 'Diff has too many lines to preview safely.' : notice);
          setDiffContent(result.tooLarge || tooLargeToRender ? '' : result.diff);
          setDiffError(result.error ?? null);
          logDiffViewerEvent('state_set_result', {
            interactionId,
            requestSlotId,
            traceId,
            loadingId,
            filePath: path,
            requestPath,
            gitRoot,
            bytes: result.diff?.length ?? 0,
            tooLargeToRender,
            resultTooLarge: Boolean(result.tooLarge),
            error: result.error ?? null,
          });
        })
        .catch((err) => {
          if (cancelled || isAbortError(err)) return;
          const message = err instanceof Error ? err.message : 'Failed to load diff';
          if (cachedDiff?.diff) {
            setDiffNotice(message);
            setDiffError(null);
          } else {
            setDiffContent(null);
            setDiffNotice(null);
            setDiffError(message);
          }
          logDiffViewerEvent('state_set_error', { interactionId, requestSlotId, traceId, filePath: path, requestPath, gitRoot, error: message, hadCachedDiff: Boolean(cachedDiff?.diff) });
        })
        .finally(() => {
          if (!cancelled) setDiffLoading(false);
          endLoading(cancelled ? 'cancelled_finally' : 'finally');
          logDiffViewerEvent('load_text_finally', { interactionId, requestSlotId, traceId, loadingId, filePath: path, requestPath, gitRoot, cancelled });
        })
    );

    if (cachedDiff && !forceReload) {
      setDiffLoading(false);
      endLoading('cache_hit');
    } else if (shouldPreferImagePreview(readablePath, changedFileStatus ? { status: changedFileStatus } : null)) {
      readImagePreviewBlob(readablePath as string, controller.signal, 'view_diff_image', requestSlotId ? `${requestSlotId}:image` : undefined)
        .then((result) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(result.blob);
          setImagePreview({ objectUrl, size: result.size, mimeType: result.mimeType });
          endLoading('image_preview_loaded', { bytes: result.size, mimeType: result.mimeType });
        })
        .catch(() => {
          if (cancelled || controller.signal.aborted) return;
          // A changed image may have been removed or moved after the file list
          // was loaded. Fall back to Git diff instead of surfacing a preview
          // error, so deleted/renamed binary files still explain what changed.
          return loadTextDiff();
        })
        .finally(() => {
          if (!cancelled) setDiffLoading(false);
          if (cancelled) endLoading('image_cancelled_finally');
        });
    } else {
      loadTextDiff();
    }

    return () => {
      cancelled = true;
      controller.abort();
      cancelIoSlot(requestSlotId);
      window.clearTimeout(watchdog);
      window.clearTimeout(longWatchdog);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      endLoading('cleanup');
      logDiffViewerEvent('effect_cleanup', {
        interactionId,
        requestSlotId,
        traceId,
        loadingId,
        filePath: path,
        requestPath,
        gitRoot,
        loadingEnded,
        signalAborted: controller.signal.aborted,
        abortReason: controller.signal.aborted ? String(controller.signal.reason ?? '') : undefined,
        cacheSize: diffResultCache.size,
        promiseSize: diffPromiseCache.size,
      });
    };
  }, [active, changedFileRepoRoot, changedFileStatus, filePath, interactionId, reloadKey, repoRoot, requestSlotId, rootPath]);

  const files = useMemo(() => {
    if (!diffContent || diffContent.trim() === '') return [];
    const startedAt = performance.now();
    try {
      const parsed = parseDiff(diffContent);
      logDiffViewerEvent('parse_done', { filePath, bytes: diffContent.length, files: parsed.length, durationMs: Math.round(performance.now() - startedAt) });
      return parsed;
    } catch (error) {
      logDiffViewerEvent('parse_error', { filePath, bytes: diffContent.length, durationMs: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, [diffContent]);

  // Lazily-loaded refractor singleton, shared with the file preview. Loading is
  // deferred until a diff actually renders so it never weighs on first paint.
  const [refractor, setRefractor] = useState<RefractorLike | null>(null);
  useEffect(() => {
    if (files.length === 0 || refractor) return;
    let cancelled = false;
    loadRefractor()
      .then((mod) => { if (!cancelled) setRefractor(mod); })
      .catch(() => { /* highlight is best-effort; fall back to plain diff */ });
    return () => { cancelled = true; };
  }, [files.length, refractor]);

  // Per-file syntax tokens keyed by the same identity used to render each file.
  // Computed only when refractor is ready and the file is a known, reasonably
  // sized text language — large/binary diffs stay plain to protect the main thread.
  const fileTokens = useMemo(() => {
    const map = new Map<string, HunkTokens>();
    if (!refractor) return map;
    const startedAt = performance.now();
    for (const file of files) {
      if (file.hunks.length === 0) continue;
      const language = resolveLanguage(file.newPath || file.oldPath);
      if (!language || !refractor.registered(language)) continue;
      let bytes = 0;
      let tooLong = false;
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          bytes += change.content.length + 1;
          if (change.content.length > MAX_HIGHLIGHT_LINE_LENGTH) tooLong = true;
        }
      }
      if (tooLong || bytes > MAX_HIGHLIGHT_BYTES) continue;
      try {
        const tokens = tokenize(file.hunks as HunkData[], { highlight: true, refractor, language });
        map.set(`${file.oldRevision}-${file.newRevision}-${file.newPath}`, tokens);
      } catch {
        // A single bad file shouldn't break the whole diff view.
      }
    }
    logDiffViewerEvent('tokenize_done', { filePath, files: files.length, tokenized: map.size, durationMs: Math.round(performance.now() - startedAt) });
    return map;
  }, [files, refractor]);


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
  const wholeDiffReferenceKey = `diff:whole:${filePath ?? 'all'}`;

  const insertWholeDiff = useCallback(() => {
    if (!diffContent || !onInsertDiffReference) return;
    onInsertDiffReference(filePath ? `${titleParts.name} diff` : t('diffViewer.allDiffLabel'), formatDiffReference(diffContent), wholeDiffReferenceKey);
  }, [diffContent, filePath, onInsertDiffReference, t, titleParts.name, wholeDiffReferenceKey]);

  const renderFileDiffs = (hideSingleFileHeader: boolean) => (
    <>
      {files.map((file) => {
        const key = `${file.oldRevision}-${file.newRevision}-${file.newPath}`;
        const stats = fileStats.get(key) ?? { additions: 0, deletions: 0 };
        const pathParts = getPathParts(file.newPath || file.oldPath, { name: 'unknown file', dir: '' });
        const displayPath = file.newPath || file.oldPath || 'unknown file';
        const showFileHeader = !hideSingleFileHeader || files.length > 1;
        const fileDiffReferenceText = [
          `diff --git a/${file.oldPath || displayPath} b/${file.newPath || displayPath}`,
          ...file.hunks.flatMap((hunk) => [hunk.content, ...hunk.changes.map((change) => change.content)]),
        ].join('\n');
        const fileDiffText = formatDiffReference(fileDiffReferenceText);
        const fileDiffReferenceKey = `diff:file:${displayPath}`;
        const fileDiffReferenceActive = insertedReferenceKey === fileDiffReferenceKey || copiedReferenceKey === fileDiffReferenceKey;
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
            <div className="flex items-center justify-between gap-3 border-b border-border/15 bg-surface-2 px-2 py-1.5">
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
                    onClick={() => onInsertDiffReference(`${pathParts.name} diff`, fileDiffText, fileDiffReferenceKey)}
                    {...getReferenceLongPressHandlers(fileDiffText, fileDiffReferenceKey)}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold active:scale-95 ${fileDiffReferenceActive ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary hover:bg-primary/20'}`}
                    title={t('diffViewer.insertFileDiff')}
                  >
                    {copiedReferenceKey === fileDiffReferenceKey ? t('rightSidebar.copied') : insertedReferenceKey === fileDiffReferenceKey ? t('rightSidebar.inserted') : t('diffViewer.insertFileShort')}
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
          {showScrollHint && !wrap && file.hunks.length > 0 && <DiffScrollHint />}
          {/*
            `termdock-diff-scroll` opts this card into a CSS rule that
            sets `touch-action: pan-x` on the inner overflow element. That
            tells the browser the user wants horizontal panning on touch
            here, so it doesn't get hijacked by the parent vertical
            scroller's overscroll/pan-y chain.
            `termdock-diff-wrap` flips long lines to wrap mode instead.
          */}
          {file.hunks.length === 0 ? (
            <div className="bg-surface-2 px-3 py-5 text-center text-xs text-muted-foreground">
              <RiGitCompare size={18} className="mx-auto mb-2 text-muted-foreground/80" />
              {t('diffViewer.binaryOrEmpty')}
            </div>
          ) : (
            <div className={`termdock-native-select overflow-x-auto termdock-diff-scroll ${wrap ? 'termdock-diff-wrap' : ''}`} data-sidebar-gesture-ignore>
              <Diff
                viewType="unified"
                diffType={file.type}
                hunks={file.hunks}
                tokens={fileTokens.get(key)}
              >
                {(hunks) =>
                  hunks.map((hunk, index) => {
                    const hunkDiffText = formatDiffReference([
                      `diff --git a/${file.oldPath || displayPath} b/${file.newPath || displayPath}`,
                      hunk.content,
                      ...hunk.changes.map((change) => change.content),
                    ].join('\n'));
                    const hunkReferenceKey = `diff:hunk:${displayPath}:${index}`;
                    const hunkReferenceActive = insertedReferenceKey === hunkReferenceKey || copiedReferenceKey === hunkReferenceKey;
                    return (
                    <Fragment key={hunk.content}>
                      <Decoration>
                        <span className="diff-hunk-header flex min-w-0 flex-wrap items-center gap-2">
                          {onInsertDiffReference && (
                            <button
                              type="button"
                              onClick={() => onInsertDiffReference(`${pathParts.name} hunk ${index + 1}`, hunkDiffText, hunkReferenceKey)}
                              {...getReferenceLongPressHandlers(hunkDiffText, hunkReferenceKey)}
                              className={`inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[10px] font-semibold active:scale-95 ${hunkReferenceActive ? 'bg-surface-elevated text-foreground' : 'bg-primary/15 text-primary hover:bg-primary/25'}`}
                              title={t('diffViewer.insertHunkDiff')}
                            >
                              {copiedReferenceKey === hunkReferenceKey ? t('rightSidebar.copied') : insertedReferenceKey === hunkReferenceKey ? t('rightSidebar.inserted') : t('diffViewer.insertHunkShort')}
                            </button>
                          )}
                          <span className="min-w-0 flex-1 truncate">{hunk.content}</span>
                        </span>
                      </Decoration>
                      <Hunk hunk={hunk} />
                    </Fragment>
                    );
                  })
                }
              </Diff>
            </div>
          )}
        </div>
        );
      })}
    </>
  );

  if (diffLoading) {
    return embedded ? (
      <div className="flex items-center justify-center gap-2 bg-surface-2 py-6 text-xs text-muted-foreground">
        <RiLoader size={18} className="animate-spin" />
        <span>{t('diffViewer.loading')}</span>
      </div>
    ) : (
      <div className="mx-3 mt-3 flex items-center justify-center gap-2 border border-border/15 bg-surface-2 py-8 text-sm text-muted-foreground">
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

  if (diffNotice && !diffContent) {
    return embedded ? (
      <div className="bg-[rgb(var(--warning-rgb)_/_0.12)] px-3 py-3 text-xs text-[color:var(--warning)]">
        {diffNotice}
      </div>
    ) : (
      <div className="mx-3 mt-3 border border-[rgb(var(--warning-rgb)_/_0.24)] bg-[rgb(var(--warning-rgb)_/_0.12)] px-4 py-4 text-sm text-[color:var(--warning)]">
        {diffNotice}
      </div>
    );
  }

  if (imagePreview) {
    const body = (
      <div className="bg-surface p-3">
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
      return <div className="termdock-native-select overflow-hidden bg-surface">{getReferenceLongPressHandlers.popoverNode}{body}</div>;
    }

    return (
      <div className="termdock-diff px-3 py-2">
        {getReferenceLongPressHandlers.popoverNode}
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

  const diffNoticeBanner = diffNotice ? (
    <div className="mb-2 border border-[rgb(var(--warning-rgb)_/_0.24)] bg-[rgb(var(--warning-rgb)_/_0.12)] px-3 py-2 text-xs text-[color:var(--warning)]">
      {diffNotice}
    </div>
  ) : null;

  if (files.length === 0) {
    return embedded ? (
      <div className="bg-surface-2 px-3 py-5 text-center text-xs text-muted-foreground">
        <RiGitCompare size={20} className="mx-auto mb-2 text-muted-foreground/80" />
        {filePath ? t('diffViewer.noFileChanges') : t('diffViewer.noUnstagedChanges')}
      </div>
    ) : (
      <div className="mx-3 mt-3 border border-border/15 bg-surface-2 px-4 py-8 text-center text-sm text-muted-foreground">
        <RiGitCompare size={24} className="mx-auto mb-2 text-muted-foreground/80" />
        {filePath ? t('diffViewer.noFileChanges') : t('diffViewer.noUnstagedChanges')}
      </div>
    );
  }

  if (embedded) {
    return (
      <div className="termdock-diff termdock-native-select termdock-diff-card-mobile overflow-hidden rounded-b-xl">
        {getReferenceLongPressHandlers.popoverNode}
        {diffNoticeBanner}
        {renderFileDiffs(true)}
      </div>
    );
  }

  const wholeDiffReferenceActive = insertedReferenceKey === wholeDiffReferenceKey || copiedReferenceKey === wholeDiffReferenceKey;

  return (
    <div className="termdock-diff termdock-native-select px-3 py-2">
      {getReferenceLongPressHandlers.popoverNode}
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
              {...getReferenceLongPressHandlers(formatDiffReference(diffContent ?? ''), wholeDiffReferenceKey)}
              className={`inline-flex h-8 shrink-0 items-center rounded-full px-3 text-[11px] font-semibold transition active:scale-95 ${wholeDiffReferenceActive ? 'bg-surface-elevated text-foreground' : 'bg-primary/15 text-primary hover:bg-primary/25'}`}
              title={t('diffViewer.insertAllDiff')}
            >
              {copiedReferenceKey === wholeDiffReferenceKey ? t('rightSidebar.copied') : insertedReferenceKey === wholeDiffReferenceKey ? t('rightSidebar.inserted') : t('diffViewer.insertAllShort')}
            </button>
          )}
        </div>
      </div>
      {diffNoticeBanner}
      {renderFileDiffs(false)}
    </div>
  );
}
