import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Swiper as SwiperInstance } from 'swiper';
import type { ChangeAuditRecord, GitDiffOptions } from '../../terminal/api';
import { flattenDiffNavigatorTree, type DiffNavigatorFile, type DiffNavigatorGroup } from './DiffFileNavigator';
import { DiffReviewWorkspace, type DiffReviewMode } from './DiffReviewWorkspace';
import { DiffStreamItem, type DiffStreamFile } from './DiffStreamItem';
import { invalidateFileDiffCached, type DiffInlineMode, type DiffViewType } from './DiffViewer';

// --- ChangeBadge (shared) ---

const PROGRAMMATIC_DETAIL_SCROLL_SYNC_SUPPRESS_MS = 160;
const CLICK_ANCHOR_CORRECTION_MS = 12_000;

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

export interface DiffStreamScrollRequest {
  key: string | null;
  nonce: number;
}

export function nextDiffStreamScrollRequest(current: DiffStreamScrollRequest, path: string | null): DiffStreamScrollRequest {
  return path ? { key: path, nonce: current.nonce + 1 } : current;
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
  const handledScrollRequestNonceRef = useRef<number | null>(null);
  const appliedInitialDetailScrollKeyRef = useRef<string | null>(null);
  const suppressDetailScrollSyncUntilRef = useRef(0);
  const anchorCorrectionFrameRef = useRef<number | null>(null);
  const anchorLockRef = useRef<{ key: string; nonce: number; expiresAt: number } | null>(null);
  const invalidatedReloadKeyRef = useRef(reloadKey);
  const [nearViewportKeys, setNearViewportKeys] = useState<Set<string>>(() => new Set());
  const orderedFileKeys = useMemo(() => allOrderedFiles.map((file) => file.key), [allOrderedFiles]);
  const orderedFileKeysSignature = orderedFileKeys.join('\u0001');

  const scrollTargetKey = useMemo(() => {
    if (!scrollToKey) return null;
    return allOrderedFiles.find((file) => (
      scrollToKey === file.key
      || scrollToKey === file.path
      || scrollToKey === file.absolutePath
    ))?.key ?? null;
  }, [allOrderedFiles, scrollToKey]);

  const cancelAnchorCorrection = useCallback(() => {
    anchorLockRef.current = null;
    if (anchorCorrectionFrameRef.current !== null) {
      window.cancelAnimationFrame(anchorCorrectionFrameRef.current);
      anchorCorrectionFrameRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    if (invalidatedReloadKeyRef.current === reloadKey) return;
    invalidatedReloadKeyRef.current = reloadKey;
    for (const file of allOrderedFiles) {
      if (file.diffOverride !== undefined) continue;
      const requestPath = toDiffRequestPath(file.path, file.repoRoot);
      invalidateFileDiffCached(requestPath, file.repoRoot ?? undefined, diffOptions);
    }
  }, [allOrderedFiles, diffOptions, reloadKey]);

  useEffect(() => {
    const container = detailScrollerRef.current;
    if (!container || allOrderedFiles.length === 0) {
      setNearViewportKeys(new Set());
      return;
    }
    const items = Array.from(container.querySelectorAll<HTMLElement>('[data-diff-stream-item]'));
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewportKeys(new Set(orderedFileKeys));
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      setNearViewportKeys((current) => {
        let next: Set<string> | null = null;
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.diffStreamItem;
          if (!key) continue;
          const hasKey = current.has(key);
          if (entry.isIntersecting === hasKey) continue;
          next ??= new Set(current);
          if (entry.isIntersecting) next.add(key);
          else next.delete(key);
        }
        return next ?? current;
      });
    }, {
      root: container,
      // Git IO and worker parsing begin before an item reaches the viewport,
      // while distant diff DOM is released and replaced by a measured spacer.
      rootMargin: '1400px 0px 1400px 0px',
    });
    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, [orderedFileKeysSignature]);

  const handleDetailScroll = useCallback((container: HTMLDivElement) => {
    detailScrollerRef.current = container;
    if (performance.now() < suppressDetailScrollSyncUntilRef.current) return;
    cancelAnchorCorrection();
    onDetailScroll?.(container);
  }, [cancelAnchorCorrection, onDetailScroll]);

  useEffect(() => {
    if (!scrollTargetKey) return;
    if (handledScrollRequestNonceRef.current === scrollToKeyNonce) return;
    let observer: ResizeObserver | null = null;
    let disposed = false;

    const alignTarget = () => {
      anchorCorrectionFrameRef.current = null;
      const lock = anchorLockRef.current;
      if (disposed || !lock || lock.nonce !== scrollToKeyNonce || performance.now() > lock.expiresAt) return;
      const container = detailScrollerRef.current;
      if (!container) return;
      const item = container.querySelector<HTMLElement>(`[data-diff-stream-item="${CSS.escape(lock.key)}"]`);
      if (!item) return;
      const containerRect = container.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const top = itemRect.top - containerRect.top + container.scrollTop;
      if (Math.abs(top - container.scrollTop) < 1) return;
      suppressDetailScrollSyncUntilRef.current = performance.now() + PROGRAMMATIC_DETAIL_SCROLL_SYNC_SUPPRESS_MS;
      container.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    };
    const scheduleAlignment = () => {
      if (anchorCorrectionFrameRef.current !== null) return;
      anchorCorrectionFrameRef.current = window.requestAnimationFrame(alignTarget);
    };

    anchorLockRef.current = {
      key: scrollTargetKey,
      nonce: scrollToKeyNonce,
      expiresAt: performance.now() + CLICK_ANCHOR_CORRECTION_MS,
    };
    handledScrollRequestNonceRef.current = scrollToKeyNonce;
    scheduleAlignment();

    const container = detailScrollerRef.current;
    if (container && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(scheduleAlignment);
      container.querySelectorAll<HTMLElement>('[data-diff-stream-item]').forEach((item) => observer?.observe(item));
    }
    return () => {
      disposed = true;
      observer?.disconnect();
      if (anchorLockRef.current?.nonce === scrollToKeyNonce) cancelAnchorCorrection();
    };
  }, [cancelAnchorCorrection, scrollTargetKey, scrollToKeyNonce]);

  useEffect(() => {
    if (initialDetailScrollTop === undefined) return;
    const restoreKey = `${allOrderedFiles.map((file) => file.key).join('\u0001')}\u0000${selectedKey ?? ''}`;
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
  }, [allOrderedFiles, initialDetailScrollTop, selectedKey]);

  const renderStreamItem = useCallback((item: DiffReviewFile) => {
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
        visible={isSelected || nearViewportKeys.has(item.key)}
        lightweight={false}
        wrap={wrap}
        showScrollHint={showScrollHint}
        viewType={diffViewType}
        inlineMode={inlineMode}
        diffOptions={diffOptions}
        reloadKey={reloadKey}
        auditRecords={item.auditRecords}
        diffOverride={item.diffOverride}
        renderBadge={(status) => renderStreamBadge(status, item)}
        onInsertDiffReference={item.onInsertDiffReference ?? onInsertDiffReference}
        onReferenceCopied={onReferenceCopied}
        insertedReferenceKey={insertedReferenceKey}
        copiedReferenceKey={copiedReferenceKey}
        onClearAuditRecord={onClearAuditRecord}
      />
    );
  }, [activePane, copiedReferenceKey, diffOptions, diffViewType, inlineMode, insertedReferenceKey, matchesSelectedKey, nearViewportKeys, onClearAuditRecord, onInsertDiffReference, onReferenceCopied, reloadKey, renderStreamBadge, showScrollHint, wrap]);

  const detailBody = (
    <div data-diff-stream-content className="termdock-diff-stream divide-y divide-border/15 bg-surface">
      {allOrderedFiles.map((item) => (
        <div key={item.key}>
          {renderStreamItem(item)}
        </div>
      ))}
    </div>
  );

  const detail = mobile ? (
    <div
      ref={detailScrollerRef}
      className="termdock-diff-stream termdock-diff-stream-scroller h-full max-h-full min-h-0 overflow-y-auto overscroll-contain bg-surface [overflow-anchor:none]"
      onScroll={(event) => handleDetailScroll(event.currentTarget)}
      onPointerDown={cancelAnchorCorrection}
      onTouchStart={cancelAnchorCorrection}
      onWheel={cancelAnchorCorrection}
    >
      {detailBody}
    </div>
  ) : (
    <div
      ref={detailScrollerRef}
      className="termdock-diff-stream termdock-diff-stream-scroller h-full max-h-full min-h-0 overflow-y-auto overscroll-contain bg-surface [overflow-anchor:none]"
      onScroll={(event) => handleDetailScroll(event.currentTarget)}
      onPointerDown={cancelAnchorCorrection}
      onTouchStart={cancelAnchorCorrection}
      onWheel={cancelAnchorCorrection}
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
