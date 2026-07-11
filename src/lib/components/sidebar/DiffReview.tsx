import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import type { Swiper as SwiperInstance } from 'swiper';
import type { ChangeAuditRecord, GitDiffOptions } from '../../terminal/api';
import { flattenDiffNavigatorTree, type DiffNavigatorFile, type DiffNavigatorGroup, type DiffFileNavigatorMode } from './DiffFileNavigator';
import { DiffReviewWorkspace } from './DiffReviewWorkspace';
import { DiffStreamItem, type DiffStreamFile } from './DiffStreamItem';
import type { DiffInlineMode, DiffViewType } from './DiffViewer';

// --- ChangeBadge (shared) ---

declare global {
  interface Window {
    __TERMDOCK_DIFF_REVIEW_LOGS?: Array<Record<string, unknown>>;
  }
}

const DIFF_REVIEW_DEBUG_STORAGE_KEY = 'termdock:debug:diff-review';

function isDiffReviewDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    // One-time enable via ?diff-anchor-log=1 (handy on a phone); persists in
    // localStorage so a normal PWA relaunch keeps logging until turned off with
    // ?diff-anchor-log=0.
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('diff-anchor-log');
    if (flag === '1') window.localStorage.setItem(DIFF_REVIEW_DEBUG_STORAGE_KEY, '1');
    else if (flag === '0') window.localStorage.removeItem(DIFF_REVIEW_DEBUG_STORAGE_KEY);
  } catch {
    // ignore storage/URL access issues
  }
  return window.localStorage.getItem(DIFF_REVIEW_DEBUG_STORAGE_KEY) === '1';
}

function logDiffReviewDebug(event: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const payload = {
    ts: Math.round(performance.now()),
    event,
    ...data,
  };
  // In-page ring buffer only when the debug flag is on (keeps console clean).
  if (isDiffReviewDebugEnabled()) {
    window.__TERMDOCK_DIFF_REVIEW_LOGS = [...(window.__TERMDOCK_DIFF_REVIEW_LOGS ?? []), payload].slice(-300);
    console.info('[DEBUG_DiffReview]', payload);
  }
  // Always ship to the server for this debugging phase (the debug flag does not
  // survive the Safari→PWA localStorage boundary on iOS, which is why earlier
  // device runs produced no logs). Prefixed with DIFF_VIEWER so the server
  // treats it as important and does not rate-limit/dedupe it.
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: 'info', message: `DIFF_VIEWER SCROLL_ANCHOR ${event}`, data: payload }),
    keepalive: true,
  }).catch(() => undefined);
}

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
  estimatedHeight?: number;
  auditRecords: ChangeAuditRecord[];
  /** Optional per-file override for the reference insertion callback. */
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
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
  mode: DiffFileNavigatorMode;
  onModeChange: (mode: DiffFileNavigatorMode) => void;
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

  // --- Containers ---
  listContainerClassName?: string;
  detailContainerClassName?: string;
  desktopSidePanel?: ReactNode;
  desktopListClassName?: string;

  // --- Scroll sync ---
  onDetailScroll?: (container: HTMLDivElement) => void;

  // --- Mobile ---
  externalSwiperRef?: { current: SwiperInstance | null };
  onMobileSlideChange?: (index: number) => void;
  slideToDetailOnMobile?: boolean;
  detailMounted?: boolean;
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
  listContainerClassName,
  detailContainerClassName,
  desktopSidePanel,
  desktopListClassName,
  onDetailScroll,
  externalSwiperRef,
  onMobileSlideChange,
  slideToDetailOnMobile,
  detailMounted = true,
}: DiffReviewProps) {
  const shouldRenderDetail = !mobile || detailMounted;
  const matchesSelectedKey = useMemo(() => {
    return (file: DiffReviewFile) => selectedKey === file.key
      || selectedKey === file.path
      || selectedKey === file.absolutePath;
  }, [selectedKey]);
  const allOrderedFiles = useMemo(() => {
    if (!shouldRenderDetail) return [];
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
  }, [files, groups, mode, shouldRenderDetail]);
  const selectedIndex = useMemo(() => {
    if (!shouldRenderDetail || !selectedKey) return -1;
    return allOrderedFiles.findIndex(matchesSelectedKey);
  }, [allOrderedFiles, matchesSelectedKey, selectedKey, shouldRenderDetail]);
  // Mobile detail uses the `virtua` virtualizer: it measures each item's real
  // height (ResizeObserver), caches sizes, and — crucially — compensates the
  // scroll position when off-screen items resize, with dedicated iOS WebKit
  // handling. This is the battle-tested solution to the "content jumps while
  // scrolling up as diffs load" problem that manual anchoring could not solve.
  const virtualizerRef = useRef<VirtualizerHandle | null>(null);
  const virtuaOffsetRef = useRef<number | null>(null);
  const detailScrollerRef = useRef<HTMLDivElement | null>(null);
  // Track which selection we've already scrolled to, so a scroll-driven
  // selection change (list highlight following the scroll) does not re-trigger
  // a jump to that file's top — only a genuine tap (new key) navigates.
  const scrolledSelectionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!mobile || !shouldRenderDetail) return;
    if (selectedIndex < 0 || !selectedKey) return;
    if (scrolledSelectionRef.current === selectedKey) return;
    scrolledSelectionRef.current = selectedKey;
    const raf = window.requestAnimationFrame(() => {
      const handle = virtualizerRef.current;
      if (!handle) return;
      // Only navigate when the selected item is OUTSIDE the current viewport —
      // i.e. a genuine tap on a file in the list. When scrolling makes the list
      // highlight follow along (selectedKey changes to a file already on
      // screen), scrolling to it again would yank the view down. Skip that.
      const itemTop = handle.getItemOffset(selectedIndex);
      const itemSize = handle.getItemSize(selectedIndex);
      const viewTop = handle.scrollOffset;
      const viewBottom = viewTop + handle.viewportSize;
      const alreadyVisible = itemTop < viewBottom && itemTop + itemSize > viewTop;
      logDiffReviewDebug('mobile_scroll_to_selected', { selectedKey, selectedIndex, alreadyVisible, itemTop: Math.round(itemTop), viewTop: Math.round(viewTop) });
      if (alreadyVisible) return;
      handle.scrollToIndex(selectedIndex, { align: 'start' });
      let refineAttempts = 0;
      const refine = () => {
        const scroller = detailScrollerRef.current;
        if (!scroller) return;
        const target = scroller.querySelector<HTMLElement>(`[data-diff-stream-item="${cssEscape(selectedKey)}"]`);
        if (!target) {
          if (refineAttempts++ < 6) window.requestAnimationFrame(refine);
          return;
        }
        const exactTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        if (Math.abs(exactTop - scroller.scrollTop) > 1) {
          scroller.scrollTop = exactTop;
          logDiffReviewDebug('mobile_scroll_to_selected_refine', { selectedKey, selectedIndex, exactTop: Math.round(exactTop) });
        }
      };
      window.requestAnimationFrame(refine);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [mobile, selectedIndex, selectedKey, shouldRenderDetail]);

  const handleDetailScroll = useCallback((container: HTMLDivElement) => {
    detailScrollerRef.current = container;
    if (!mobile) onDetailScroll?.(container);
  }, [mobile, onDetailScroll]);

  const renderStreamItem = useCallback((item: DiffReviewFile, options: { eager: boolean; lightweight: boolean }) => {
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
        eager={options.eager}
        lightweight={options.lightweight}
        estimatedHeight={item.estimatedHeight}
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
  }, [activePane, copiedReferenceKey, diffOptions, diffViewType, inlineMode, insertedReferenceKey, matchesSelectedKey, onClearAuditRecord, onInsertDiffReference, onReferenceCopied, reloadKey, renderStreamBadge, showScrollHint, wrap]);

  const detail = shouldRenderDetail ? (
    mobile ? (
      selectedIndex < 0 ? (
        <div className="bg-surface px-3 py-6 text-center text-xs text-muted-foreground" />
      ) : (
        <div
          ref={detailScrollerRef}
          className="termdock-diff-stream termdock-diff-stream-scroller h-full max-h-full min-h-0 overflow-y-auto overscroll-contain bg-surface"
          // virtua compensates scroll on item resize itself; disable native
          // anchoring so the two don't both act.
          style={{ overflowAnchor: 'none' }}
          data-sidebar-gesture-ignore
          onScroll={(event) => handleDetailScroll(event.currentTarget)}
        >
          <Virtualizer
            ref={virtualizerRef}
            scrollRef={detailScrollerRef}
            data={allOrderedFiles}
            // bufferSize is in PIXELS of extra render area beyond the viewport.
            bufferSize={400}
            // Height hint for unmeasured items. Diffs are tall; a realistic
            // hint keeps virtua's size estimate close to reality so the scroll
            // compensation when an item is finally measured stays small (a
            // wildly-off estimate is what caused the large jumps).
            itemSize={600}
            onScroll={(offset) => {
              const prev = virtuaOffsetRef.current;
              virtuaOffsetRef.current = offset;
              if (prev != null) {
                const d = offset - prev;
                if (Math.abs(d) > 120) logDiffReviewDebug('virtua_jump', { from: Math.round(prev), to: Math.round(offset), delta: Math.round(d) });
              }
            }}
          >
            {(item: DiffReviewFile) => (
              <div key={item.key} className="border-b border-border/15">
                {renderStreamItem(item, { eager: true, lightweight: true })}
              </div>
            )}
          </Virtualizer>
        </div>
      )
    ) : (
      <div className="termdock-diff-stream divide-y divide-border/15 bg-surface">
        {allOrderedFiles.map((item, index) => {
          const isSelected = matchesSelectedKey(item);
          const isEager = activePane || index < 3 || isSelected;
          return (
            <div key={item.key}>
              {renderStreamItem(item, { eager: isEager, lightweight: false })}
            </div>
          );
        })}
      </div>
    )
  ) : (
    <div className="bg-surface px-3 py-6 text-center text-xs text-muted-foreground" />
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
      mobileDetailOwnsScroll={mobile}
    />
  );
}

// --- Helpers ---

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function toStreamFile(file: DiffReviewFile): DiffStreamFile {
  return {
    path: file.path,
    absolutePath: file.absolutePath,
    status: file.status,
  };
}
