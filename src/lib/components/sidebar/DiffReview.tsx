import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Swiper as SwiperInstance } from 'swiper';
import { getGitBlobContent, type ChangeAuditRecord, type GitDiffOptions } from '../../terminal/api';
import { flattenDiffNavigatorTree, type DiffNavigatorFile, type DiffNavigatorGroup } from './DiffFileNavigator';
import { DiffReviewWorkspace, type DiffReviewMode } from './DiffReviewWorkspace';
import { DiffStreamItem, type DiffStreamFile } from './DiffStreamItem';
import {
  formatDiffLimitMessage,
  isDiffTooLargeToRender,
  loadVisibleFileDiff,
  refreshFileDiffCached,
  type DiffInlineMode,
  type DiffViewerPreparedDiff,
  type DiffViewType,
} from './DiffViewer';
import { parseDiffInWorker } from './diffWorkerClient';

// --- ChangeBadge (shared) ---

const PROGRAMMATIC_DETAIL_SCROLL_SYNC_SUPPRESS_MS = 160;

export const CHANGE_BADGE_STYLES: Record<string, { label: string; className: string; title: string }> = {
  added: { label: 'A', className: 'text-[color:var(--diff-insert-strong)]', title: 'Added' },
  modified: { label: 'M', className: 'text-[color:var(--diff-hunk-accent)]', title: 'Modified' },
  deleted: { label: 'D', className: 'text-[color:var(--diff-delete-strong)]', title: 'Deleted' },
  renamed: { label: 'R', className: 'text-muted-foreground', title: 'Renamed' },
  copied: { label: 'C', className: 'text-[color:var(--diff-insert-strong)]', title: 'Copied' },
  untracked: { label: 'U', className: 'text-[color:var(--diff-insert-strong)]', title: 'Untracked (new file)' },
  conflicted: { label: '!', className: 'text-destructive', title: 'Conflicted' },
  unknown: { label: '?', className: 'text-muted-foreground', title: 'Unknown' },
};

export function ChangeBadge({ status }: { status: string }) {
  const style = CHANGE_BADGE_STYLES[status] ?? { label: '?', className: 'text-muted-foreground', title: status };
  return (
    <span className={`w-4 shrink-0 text-center text-[10px] font-mono font-bold ${style.className}`} title={style.title}>
      {style.label}
    </span>
  );
}

// --- Unified data model ---

export interface DiffReviewFile {
  key: string;
  path: string;
  absolutePath?: string | null;
  status: string;
  repoRoot: string | null;
  displayName: string;
  displayDir?: string | null;
  diffOverride?: string | null;
  auditRecords: ChangeAuditRecord[];
  /** Optional per-file override for the reference insertion callback. */
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
}

interface PreparedDiffEntry extends DiffViewerPreparedDiff {
  key: string;
}

interface PreparedDiffSnapshot {
  key: string;
  files: DiffReviewFile[];
  preparedDiffs: Map<string, PreparedDiffEntry>;
}

// --- Props ---

export interface DiffReviewProps {
  // --- Data ---
  files: DiffReviewFile[];
  groups: DiffNavigatorGroup[];

  // --- Selection ---
  selectedKey?: string | null;
  onSelectFile: (file: DiffNavigatorFile) => void;

  // --- Navigation mode ---
  mode: DiffReviewMode;
  onModeChange: (mode: DiffReviewMode) => void;
  collapsedDirectoryKeys: Set<string>;
  onToggleDirectory: (key: string) => void;

  // --- Render slots (navigator side) ---
  renderLeading: (file: DiffNavigatorFile) => ReactNode;
  renderTrailing?: (file: DiffNavigatorFile) => ReactNode;
  renderSubtitle?: (file: DiffNavigatorFile) => ReactNode;

  // --- Render slots (stream side) ---
  renderStreamBadge: (status: string, file: DiffReviewFile) => ReactNode;

  // --- Diff references ---
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  onClearAuditRecord?: (id: string) => void;

  // --- Layout ---
  mobile: boolean;
  backLabel: string;
  compact?: boolean;
  desktopLayout?: 'split' | 'stacked';
  wrap: boolean;
  showScrollHint: boolean;
  diffViewType?: DiffViewType;
  inlineMode?: DiffInlineMode;
  diffOptions?: GitDiffOptions;
  activePane: boolean;
  reloadKey?: number;

  // --- Header / empty state ---
  renderListHeader?: (modeToggle: ReactNode) => ReactNode;
  renderMobileDetailHeader?: ReactNode | ((controls: { slideToList: () => void; slideToDetail: () => void }) => ReactNode);
  emptyContent?: ReactNode;
  listPrefix?: ReactNode;
  aiContent?: ReactNode | ((controls: { slideToDetail: () => void }) => ReactNode);

  // --- Containers ---
  listContainerClassName?: string;
  detailContainerClassName?: string;
  desktopSidePanel?: ReactNode;
  desktopListClassName?: string;

  // --- Scroll sync ---
  onDetailScroll?: (container: HTMLDivElement) => void;
  initialDetailScrollTop?: number;
  scrollToKey?: string | null;
  scrollToKeyNonce?: number;

  // --- Mobile ---
  externalSwiperRef?: { current: SwiperInstance | null };
  onMobileSlideChange?: (index: number) => void;
  slideToDetailOnMobile?: boolean;
}

// --- Component ---

export function DiffReview({
  files,
  groups,
  selectedKey,
  onSelectFile,
  mode,
  onModeChange,
  collapsedDirectoryKeys,
  onToggleDirectory,
  renderLeading,
  renderTrailing,
  renderSubtitle,
  renderStreamBadge,
  onInsertDiffReference,
  onReferenceCopied,
  insertedReferenceKey,
  copiedReferenceKey,
  onClearAuditRecord,
  mobile,
  backLabel,
  compact,
  desktopLayout,
  wrap,
  showScrollHint,
  diffViewType,
  inlineMode,
  diffOptions,
  activePane,
  reloadKey = 0,
  renderListHeader,
  renderMobileDetailHeader,
  emptyContent,
  listPrefix,
  aiContent,
  listContainerClassName,
  detailContainerClassName,
  desktopSidePanel,
  desktopListClassName,
  onDetailScroll,
  initialDetailScrollTop,
  scrollToKey,
  scrollToKeyNonce = 0,
  externalSwiperRef,
  onMobileSlideChange,
  slideToDetailOnMobile,
}: DiffReviewProps) {
  const matchesSelectedKey = useMemo(() => {
    return (file: DiffReviewFile) => selectedKey === file.key
      || selectedKey === file.path
      || selectedKey === file.absolutePath;
  }, [selectedKey]);
  const allOrderedFiles = useMemo(() => {
    const byKey = new Map<string, DiffReviewFile>();
    for (const file of files) {
      byKey.set(file.key, file);
      if (file.path) byKey.set(file.path, file);
      if (file.absolutePath) byKey.set(file.absolutePath, file);
    }
    const ordered: DiffReviewFile[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      const navigatorFiles = mode === 'tree' ? flattenDiffNavigatorTree(group.files) : group.files;
      for (const navigatorFile of navigatorFiles) {
        const file = byKey.get(navigatorFile.key);
        if (!file || seen.has(file.key)) continue;
        ordered.push(file);
        seen.add(file.key);
      }
    }
    for (const file of files) {
      if (seen.has(file.key)) continue;
      ordered.push(file);
    }
    return ordered;
  }, [files, groups, mode]);
  const detailScrollerRef = useRef<HTMLDivElement | null>(null);
  const diffCacheRefreshSeqRef = useRef(0);
  const handledScrollRequestNonceRef = useRef<number | null>(null);
  const appliedInitialDetailScrollKeyRef = useRef<string | null>(null);
  const suppressDetailScrollSyncUntilRef = useRef(0);
  const [detailSnapshot, setDetailSnapshot] = useState<PreparedDiffSnapshot | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [cacheRefreshNonce, setCacheRefreshNonce] = useState(0);
  const stableDiffOptions = useMemo(() => diffOptions ? {
    algorithm: diffOptions.algorithm,
    whitespace: diffOptions.whitespace,
  } : undefined, [diffOptions?.algorithm, diffOptions?.whitespace]);

  const orderedFileRequestKey = allOrderedFiles
    .map((file) => [
      file.key,
      file.path,
      file.status,
      file.repoRoot ?? '',
      file.diffOverride ?? '',
    ].join('\u0001'))
    .join('\u0002');

  const detailPrepareKey = useMemo(() => {
    return allOrderedFiles
      .map((file) => [
        file.key,
        file.path,
        file.status,
        file.repoRoot ?? '',
        file.diffOverride ?? '',
        diffOptions?.algorithm ?? 'default',
        diffOptions?.whitespace ?? 'default',
        inlineMode ?? 'words',
        cacheRefreshNonce,
      ].join('\u0001'))
      .join('\u0002');
  }, [allOrderedFiles, cacheRefreshNonce, diffOptions?.algorithm, diffOptions?.whitespace, inlineMode]);

  useEffect(() => {
    setDetailSnapshot(null);
    setPrepareError(null);

    if (allOrderedFiles.length === 0) {
      setDetailSnapshot({
        key: detailPrepareKey,
        files: [],
        preparedDiffs: new Map(),
      });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const prepareOne = async (file: DiffReviewFile): Promise<PreparedDiffEntry> => {
      const gitRoot = file.repoRoot;
      const requestPath = toDiffRequestPath(file.path, gitRoot);
      try {
        const rawDiff = file.diffOverride !== undefined
          ? { path: file.path, diff: file.diffOverride ?? '', error: undefined, tooLarge: false }
          : await loadVisibleFileDiff(requestPath, gitRoot ?? undefined, controller.signal, false, undefined, undefined, undefined, stableDiffOptions);
        const notice = file.diffOverride !== undefined ? null : formatDiffLimitMessage(rawDiff);
        const tooLargeToRender = isDiffTooLargeToRender(rawDiff.diff);
        const diffContent = rawDiff.tooLarge || tooLargeToRender ? '' : rawDiff.diff;
        if (!diffContent || diffContent.trim() === '') {
          return {
            key: file.key,
            diffContent,
            diffNotice: tooLargeToRender ? 'Diff has too many lines to preview safely.' : notice,
            diffError: rawDiff.error ?? null,
            files: [],
            tokens: new Map(),
          };
        }
        const oldSource = await loadOldSourceForPreparedDiff(file, controller.signal);
        const parsed = await parseDiffInWorker(diffContent, inlineMode ?? 'words', oldSource ?? undefined);
        return {
          key: file.key,
          diffContent,
          diffNotice: tooLargeToRender ? 'Diff has too many lines to preview safely.' : notice,
          diffError: rawDiff.error ?? null,
          files: parsed.files,
          tokens: parsed.tokens,
        };
      } catch (error) {
        if (controller.signal.aborted || isPreparedDiffAbort(error)) {
          throw error;
        }
        return {
          key: file.key,
          diffContent: null,
          diffNotice: null,
          diffError: error instanceof Error ? error.message : String(error),
          files: [],
          tokens: new Map(),
        };
      }
    };

    Promise.all(allOrderedFiles.map(prepareOne))
      .then((entries) => {
        if (cancelled) return;
        setDetailSnapshot({
          key: detailPrepareKey,
          files: allOrderedFiles,
          preparedDiffs: new Map(entries.map((entry) => [entry.key, entry])),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setPrepareError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (cancelled) return;
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [detailPrepareKey]);

  useEffect(() => {
    if (reloadKey === 0 || allOrderedFiles.length === 0) return;
    const refreshSeq = diffCacheRefreshSeqRef.current + 1;
    diffCacheRefreshSeqRef.current = refreshSeq;
    const refreshes = allOrderedFiles
      .filter((file) => file.diffOverride === undefined)
      .map((file) => {
        const gitRoot = file.repoRoot;
        const requestPath = toDiffRequestPath(file.path, gitRoot);
        return refreshFileDiffCached(requestPath, gitRoot ?? undefined, stableDiffOptions);
      });
    if (refreshes.length === 0) return;
    void Promise.allSettled(refreshes).then(() => {
      if (diffCacheRefreshSeqRef.current !== refreshSeq) return;
      setCacheRefreshNonce((value) => value + 1);
    });
  }, [orderedFileRequestKey, reloadKey, stableDiffOptions]);

  const handleDetailScroll = useCallback((container: HTMLDivElement) => {
    detailScrollerRef.current = container;
    if (performance.now() < suppressDetailScrollSyncUntilRef.current) return;
    onDetailScroll?.(container);
  }, [onDetailScroll]);

  const currentSnapshot = detailSnapshot?.key === detailPrepareKey ? detailSnapshot : null;
  const renderedFiles = currentSnapshot?.files ?? [];
  const renderedPreparedDiffs = currentSnapshot?.preparedDiffs ?? null;

  useEffect(() => {
    if (!scrollToKey) return;
    if (handledScrollRequestNonceRef.current === scrollToKeyNonce) return;
    const target = renderedFiles.find((file) => (
      scrollToKey === file.key
      || scrollToKey === file.path
      || scrollToKey === file.absolutePath
    ));
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      const container = detailScrollerRef.current;
      if (!container) return;
      const item = container.querySelector<HTMLElement>(`[data-diff-stream-item="${CSS.escape(target.key)}"]`);
      if (!item) return;
      handledScrollRequestNonceRef.current = scrollToKeyNonce;
      const containerRect = container.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      if (itemRect.top >= containerRect.top && itemRect.top < containerRect.bottom) return;
      const top = itemRect.top - containerRect.top + container.scrollTop;
      suppressDetailScrollSyncUntilRef.current = performance.now() + PROGRAMMATIC_DETAIL_SCROLL_SYNC_SUPPRESS_MS;
      container.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renderedFiles, scrollToKey, scrollToKeyNonce]);

  useEffect(() => {
    if (initialDetailScrollTop === undefined) return;
    const restoreKey = `${currentSnapshot?.key ?? detailPrepareKey}\u0000${selectedKey ?? ''}`;
    if (appliedInitialDetailScrollKeyRef.current === restoreKey) return;
    const container = detailScrollerRef.current;
    if (!container) return;
    const top = Math.max(0, initialDetailScrollTop);
    const frame = window.requestAnimationFrame(() => {
      appliedInitialDetailScrollKeyRef.current = restoreKey;
      suppressDetailScrollSyncUntilRef.current = performance.now() + PROGRAMMATIC_DETAIL_SCROLL_SYNC_SUPPRESS_MS;
      container.scrollTo({ top, behavior: 'instant' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentSnapshot?.key, detailPrepareKey, initialDetailScrollTop]);

  const renderStreamItem = useCallback((item: DiffReviewFile, preparedDiff: DiffViewerPreparedDiff) => {
    const isSelected = matchesSelectedKey(item);
    return (
      <DiffStreamItem
        file={toStreamFile(item)}
        repoRoot={item.repoRoot}
        selectionPath={item.key}
        displayName={item.displayName}
        displayDir={item.displayDir}
        selected={isSelected}
        activePane={activePane}
        eager
        lightweight={false}
        wrap={wrap}
        showScrollHint={showScrollHint}
        viewType={diffViewType}
        inlineMode={inlineMode}
        diffOptions={diffOptions}
        reloadKey={reloadKey}
        auditRecords={item.auditRecords}
        diffOverride={item.diffOverride}
        preparedDiff={preparedDiff}
        renderBadge={(status) => renderStreamBadge(status, item)}
        onInsertDiffReference={item.onInsertDiffReference ?? onInsertDiffReference}
        onReferenceCopied={onReferenceCopied}
        insertedReferenceKey={insertedReferenceKey}
        copiedReferenceKey={copiedReferenceKey}
        onClearAuditRecord={onClearAuditRecord}
      />
    );
  }, [activePane, copiedReferenceKey, diffOptions, diffViewType, inlineMode, insertedReferenceKey, matchesSelectedKey, onClearAuditRecord, onInsertDiffReference, onReferenceCopied, reloadKey, renderStreamBadge, showScrollHint, wrap]);

  const detailBody = prepareError ? (
    <div className="flex h-full items-center justify-center bg-surface px-4 py-8 text-center text-xs text-destructive">
      {prepareError}
    </div>
  ) : !currentSnapshot ? (
    <div className="flex h-full items-center justify-center bg-surface px-4 py-8 text-center text-xs text-muted-foreground">
      正在准备完整 diff，完成后列表会一次性显示…
    </div>
  ) : (
    <div className="termdock-diff-stream divide-y divide-border/15 bg-surface">
      {renderedFiles.map((item) => (
        <div key={item.key}>
          {renderStreamItem(item, renderedPreparedDiffs?.get(item.key) ?? buildMissingPreparedDiff())}
        </div>
      ))}
    </div>
  );

  const detail = mobile ? (
    <div
      ref={detailScrollerRef}
      className="termdock-diff-stream termdock-diff-stream-scroller h-full max-h-full min-h-0 overflow-y-auto overscroll-contain bg-surface"
      data-sidebar-gesture-ignore
      onScroll={(event) => handleDetailScroll(event.currentTarget)}
    >
      {detailBody}
    </div>
  ) : (
    <div
      ref={detailScrollerRef}
      className="termdock-diff-stream termdock-diff-stream-scroller h-full max-h-full min-h-0 overflow-y-auto overscroll-contain bg-surface"
      onScroll={(event) => handleDetailScroll(event.currentTarget)}
    >
      {detailBody}
    </div>
  );

  return (
    <DiffReviewWorkspace
      groups={groups}
      mode={mode}
      onModeChange={onModeChange}
      selectedKey={selectedKey}
      collapsedDirectoryKeys={collapsedDirectoryKeys}
      onToggleDirectory={onToggleDirectory}
      onSelectFile={onSelectFile}
      renderLeading={renderLeading}
      renderTrailing={renderTrailing}
      renderSubtitle={renderSubtitle}
      detail={detail}
      mobile={mobile}
      backLabel={backLabel}
      compact={compact}
      emptyContent={emptyContent}
      listPrefix={listPrefix}
      aiContent={aiContent}
      listContainerClassName={listContainerClassName}
      detailContainerClassName={detailContainerClassName}
      renderListHeader={renderListHeader}
      renderMobileDetailHeader={renderMobileDetailHeader}
      externalSwiperRef={externalSwiperRef}
      onMobileSlideChange={onMobileSlideChange}
      slideToDetailOnMobile={slideToDetailOnMobile}
      desktopLayout={desktopLayout}
      onDetailScroll={handleDetailScroll}
      desktopSidePanel={desktopSidePanel}
      desktopListClassName={desktopListClassName}
      detailOwnsScroll
    />
  );
}

// --- Helpers ---

function toStreamFile(file: DiffReviewFile): DiffStreamFile {
  return {
    path: file.path,
    absolutePath: file.absolutePath,
    status: file.status,
  };
}

function toDiffRequestPath(path: string | null | undefined, rootPath: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return rootPath && path.startsWith(`${rootPath}/`)
    ? path.slice(rootPath.length + 1)
    : path;
}

async function loadOldSourceForPreparedDiff(file: DiffReviewFile, signal: AbortSignal): Promise<string | null> {
  const gitRoot = file.repoRoot;
  if (!gitRoot || !file.path || file.diffOverride !== undefined || file.status === 'added' || file.status === 'untracked') {
    return null;
  }
  try {
    const requestPath = toDiffRequestPath(file.path, gitRoot);
    if (!requestPath) return null;
    const result = await getGitBlobContent(requestPath, gitRoot, 'HEAD', signal, 'ref');
    return result.truncated || result.error ? null : result.content;
  } catch {
    return null;
  }
}

function buildMissingPreparedDiff(): DiffViewerPreparedDiff {
  return {
    diffContent: null,
    diffNotice: null,
    diffError: null,
    files: [],
    tokens: new Map(),
  };
}

function isPreparedDiffAbort(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('signal is aborted');
}
