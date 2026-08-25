import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Swiper as SwiperInstance } from 'swiper';
import type { ChangeAuditRecord, GitDiffOptions } from '../../terminal/api';
import { flattenDiffNavigatorTree, type DiffNavigatorFile, type DiffNavigatorGroup } from './DiffFileNavigator';
import { DiffReviewWorkspace, type DiffReviewAiControls, type DiffReviewMode } from './DiffReviewWorkspace';
import { DiffStreamItem, type DiffStreamFile } from './DiffStreamItem';
import { invalidateFileDiffCached, preloadPreparedFileDiff, type DiffHunkActionRequest, type DiffInlineMode, type DiffViewType } from './DiffViewer';
import { useSidebarStore } from '../../stores/useSidebarStore';

// --- ChangeBadge (shared) ---

// Bounded count of live DiffViewer instances. Must cover the number of cards
// visible at once (small files can stack several to a viewport) plus lookahead,
// otherwise a resting viewport can hold a skeleton that never gets a slot.
const MAX_RETAINED_DIFF_ITEMS = 8;
const DIFF_PRELOAD_RADIUS = 3;
const DIFF_PRELOAD_CONCURRENCY = 2;
// Skeleton slots are cheap (a header plus an estimated-height body), so the
// rendered window is generous: the viewport must never scroll past painted
// slots into bare canvas, even when a fling outruns a React commit.
const DIFF_CANVAS_OVERSCAN = 1_600;
// How much of a still-loading card peeks into the viewport when the scroll
// gate stops the user at it: header plus a slice of the loading cover.
const DIFF_SCROLL_GATE_PEEK = 120;
const DEFAULT_DIFF_ITEM_HEIGHT = 104;
const MAX_CACHED_DIFF_ITEM_HEIGHTS = 1_000;
const cachedDiffItemHeights = new Map<string, number>();

function cacheDiffItemHeight(key: string, height: number): void {
  cachedDiffItemHeights.delete(key);
  cachedDiffItemHeights.set(key, height);
  while (cachedDiffItemHeights.size > MAX_CACHED_DIFF_ITEM_HEIGHTS) {
    const oldestKey = cachedDiffItemHeights.keys().next().value;
    if (oldestKey === undefined) break;
    cachedDiffItemHeights.delete(oldestKey);
  }
}

interface DiffCanvasLayout {
  tops: number[];
  heights: number[];
  /** Bottom edge of the last item (estimated until measured). */
  bottom: number;
}

interface DiffCanvasViewport {
  top: number;
  height: number;
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
  auditRecords: ChangeAuditRecord[];
  /** Optional per-file override for the reference insertion callback. */
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
  /** Optional per-file override for the hunk git action callback. */
  onHunkGitAction?: (request: DiffHunkActionRequest) => Promise<void>;
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
  renderDirectoryTrailing?: (directoryPath: string, group: DiffNavigatorGroup) => ReactNode;
  renderSubtitle?: (file: DiffNavigatorFile) => ReactNode;

  // --- Render slots (stream side) ---
  renderStreamBadge: (status: string, file: DiffReviewFile) => ReactNode;

  // --- Diff references ---
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
  /** Hunk-level git actions; only pass for live worktree diffs. */
  onHunkGitAction?: (request: DiffHunkActionRequest) => Promise<void>;
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
  aiContent?: ReactNode | ((controls: DiffReviewAiControls) => ReactNode);

  // --- Containers ---
  listContainerClassName?: string;
  detailContainerClassName?: string;
  desktopSidePanel?: ReactNode;
  desktopListClassName?: string;

  // --- Scroll sync ---
  onDetailScroll?: (container: HTMLDivElement) => void;
  /** Saved native scrollTop to restore for this file set. */
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
  renderDirectoryTrailing,
  renderSubtitle,
  renderStreamBadge,
  onInsertDiffReference,
  onHunkGitAction,
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
  const sidebarRootPath = useSidebarStore((state) => state.rootPath);
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

  // --- Free-canvas virtualization ---
  // The canvas is one absolutely-positioned column spanning the whole list
  // (estimated heights until measured). There is no loading frontier: every
  // region is always scrollable and always paints at least a skeleton.
  // Mounting the expensive DiffViewer is the only scheduled work, and it
  // expands outward from the anchor card by distance. The single UX gate:
  // scrolling into a card that is still loading stops at a peek into its
  // loading cover until it is ready (skeletons never gate).
  const detailScrollerRef = useRef<HTMLDivElement | null>(null);
  const handledScrollRequestNonceRef = useRef<number | null>(null);
  const appliedInitialDetailScrollKeyRef = useRef<string | null>(null);
  const invalidatedReloadKeyRef = useRef(reloadKey);
  const lastDetailScrollTopRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const measuredItemHeightsRef = useRef<Map<string, number>>(new Map(cachedDiffItemHeights));
  // Viewport anchor used to keep the visible card pixel-stable when items
  // above it are (re)measured and every top below shifts.
  const scrollAnchorRef = useRef<{ key: string | null; top: number }>({ key: null, top: 0 });
  const mountedKeysRef = useRef<Set<string>>(new Set());
  const readyKeysRef = useRef<Set<string>>(new Set());
  const loadingKeyRef = useRef<string | null>(null);
  const pumpLoadQueueRef = useRef<() => void>(() => undefined);
  const orderedFileKeysRef = useRef<string[]>([]);
  const orderedFileIndexRef = useRef<Map<string, number>>(new Map());
  const canvasLayoutRef = useRef<DiffCanvasLayout>({ tops: [], heights: [], bottom: 0 });
  const [mountedKeys, setMountedKeys] = useState<Set<string>>(() => new Set());
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [canvasViewport, setCanvasViewport] = useState<DiffCanvasViewport>({ top: 0, height: 0 });
  const orderedFileKeys = useMemo(() => allOrderedFiles.map((file) => file.key), [allOrderedFiles]);
  const orderedFileKeysSignature = orderedFileKeys.join('');
  orderedFileKeysRef.current = orderedFileKeys;
  orderedFileIndexRef.current = new Map(orderedFileKeys.map((key, index) => [key, index]));
  const canvasLayout = useMemo<DiffCanvasLayout>(() => {
    const heights = orderedFileKeys.map((key) => measuredItemHeightsRef.current.get(key) ?? DEFAULT_DIFF_ITEM_HEIGHT);
    const tops = new Array<number>(heights.length);
    for (let index = 0; index < heights.length; index += 1) {
      tops[index] = index === 0 ? 0 : tops[index - 1] + heights[index - 1];
    }
    const bottom = heights.length > 0 ? tops[heights.length - 1] + heights[heights.length - 1] : 0;
    return { tops, heights, bottom };
  }, [canvasRevision, orderedFileKeysSignature]);
  canvasLayoutRef.current = canvasLayout;

  const scrollTargetKey = useMemo(() => {
    if (!scrollToKey) return null;
    return allOrderedFiles.find((file) => (
      scrollToKey === file.key
      || scrollToKey === file.path
      || scrollToKey === file.absolutePath
    ))?.key ?? null;
  }, [allOrderedFiles, scrollToKey]);
  const selectedTargetKey = useMemo(() => {
    if (!selectedKey) return null;
    return allOrderedFiles.find((file) => (
      selectedKey === file.key
      || selectedKey === file.path
      || selectedKey === file.absolutePath
    ))?.key ?? null;
  }, [allOrderedFiles, selectedKey]);

  const visibleAnchorIndex = useMemo(() => {
    const count = canvasLayout.tops.length;
    if (count === 0) return -1;
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (canvasLayout.tops[middle] <= canvasViewport.top + 1) low = middle + 1;
      else high = middle;
    }
    return Math.min(count - 1, Math.max(0, low - 1));
  }, [canvasLayout.tops, canvasViewport.top]);

  // Warm the prepared-diff cache around the anchor so mounts complete fast.
  // Symmetric by design: loading expands outward from the current position.
  useEffect(() => {
    if (!activePane || visibleAnchorIndex < 0) return;
    const indices = [visibleAnchorIndex];
    for (let distance = 1; distance <= DIFF_PRELOAD_RADIUS; distance += 1) {
      indices.push(visibleAnchorIndex + distance);
      indices.push(visibleAnchorIndex - distance);
    }
    const queue = indices
      .filter((index, position) => (
        index >= 0
        && index < allOrderedFiles.length
        && indices.indexOf(index) === position
      ))
      .map((index) => allOrderedFiles[index])
      .filter((file) => file.diffOverride === undefined && Boolean(file.repoRoot ?? sidebarRootPath));
    let cancelled = false;
    void (async () => {
      for (let index = 0; index < queue.length && !cancelled; index += DIFF_PRELOAD_CONCURRENCY) {
        const batch = queue.slice(index, index + DIFF_PRELOAD_CONCURRENCY);
        await Promise.all(batch.map((file) => {
          const cwd = file.repoRoot ?? sidebarRootPath;
          const requestPath = toDiffRequestPath(file.path, cwd);
          return preloadPreparedFileDiff(
            requestPath,
            cwd ?? undefined,
            inlineMode ?? 'words',
            diffOptions,
          ).catch(() => undefined);
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePane, allOrderedFiles, diffOptions, inlineMode, sidebarRootPath, visibleAnchorIndex]);

  const replaceMountedKeys = useCallback((next: Set<string>) => {
    mountedKeysRef.current = next;
    setMountedKeys(next);
  }, []);

  // Region identification: skeleton slots cover the viewport plus a fixed
  // pixel overscan on both sides.
  const renderedIndices = useMemo(() => {
    const start = canvasViewport.top - DIFF_CANVAS_OVERSCAN;
    const end = canvasViewport.top + canvasViewport.height + DIFF_CANVAS_OVERSCAN;
    const indexSet = new Set<number>();
    let low = 0;
    let high = canvasLayout.tops.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (canvasLayout.tops[middle] <= start) low = middle + 1;
      else high = middle;
    }
    const firstCandidate = Math.max(0, low - 1);
    for (let index = firstCandidate; index < canvasLayout.tops.length; index += 1) {
      const top = canvasLayout.tops[index];
      if (top > end) break;
      const bottom = top + canvasLayout.heights[index];
      if (bottom >= start && top <= end) indexSet.add(index);
    }
    // Keep the immediate neighbours rendered even when the current diff is
    // taller than the pixel overscan; they provide measured heights and a
    // seamless boundary.
    for (let index = visibleAnchorIndex - 1; index <= visibleAnchorIndex + 1; index += 1) {
      if (index >= 0 && index < canvasLayout.tops.length) indexSet.add(index);
    }
    return Array.from(indexSet).sort((left, right) => left - right);
  }, [canvasLayout, canvasViewport, visibleAnchorIndex]);

  // Mount cards strictly outward from the anchor card, one at a time:
  // anchor±1, anchor±2, ... (the card below wins ties). The candidate ring is
  // derived from the anchor index alone — deliberately NOT from the rendered
  // skeleton window, whose commits can lag a fast entry scroll. Serial (one
  // card in flight) and capped: when MAX_RETAINED_DIFF_ITEMS cards are
  // mounted, the farthest one is recycled — but only for a strictly closer
  // candidate, so the mounted set converges to the anchor's neighbourhood.
  const pumpLoadQueue = useCallback(() => {
    if (loadingKeyRef.current) return;
    const keys = orderedFileKeysRef.current;
    if (keys.length === 0) return;
    const anchorKey = scrollAnchorRef.current.key;
    const anchorIndex = Math.min(
      keys.length - 1,
      (anchorKey !== null ? orderedFileIndexRef.current.get(anchorKey) : undefined)
        ?? Math.max(0, visibleAnchorIndex),
    );
    const distanceOf = (key: string) => Math.abs((orderedFileIndexRef.current.get(key) ?? 0) - anchorIndex);
    const candidates: string[] = [];
    if (!mountedKeysRef.current.has(keys[anchorIndex])) candidates.push(keys[anchorIndex]);
    for (let distance = 1; distance <= MAX_RETAINED_DIFF_ITEMS; distance += 1) {
      const below = anchorIndex + distance;
      const above = anchorIndex - distance;
      if (below < keys.length && !mountedKeysRef.current.has(keys[below])) candidates.push(keys[below]);
      if (above >= 0 && !mountedKeysRef.current.has(keys[above])) candidates.push(keys[above]);
    }
    const nextKey = candidates[0];
    if (!nextKey) return;
    if (mountedKeysRef.current.size >= MAX_RETAINED_DIFF_ITEMS) {
      const nextDistance = distanceOf(nextKey);
      const removable = Array.from(mountedKeysRef.current)
        .filter((key) => key !== loadingKeyRef.current)
        .sort((left, right) => distanceOf(right) - distanceOf(left))[0];
      if (!removable || distanceOf(removable) <= nextDistance) return;
      const next = new Set(mountedKeysRef.current);
      next.delete(removable);
      readyKeysRef.current.delete(removable);
      replaceMountedKeys(next);
    }
    loadingKeyRef.current = nextKey;
    replaceMountedKeys(new Set(mountedKeysRef.current).add(nextKey));
  }, [replaceMountedKeys, visibleAnchorIndex]);
  pumpLoadQueueRef.current = pumpLoadQueue;

  const prioritizeLoad = useCallback((key: string) => {
    if (mountedKeysRef.current.has(key)) return;
    const currentLoading = loadingKeyRef.current;
    if (currentLoading && currentLoading !== key) {
      const next = new Set(mountedKeysRef.current);
      next.delete(currentLoading);
      readyKeysRef.current.delete(currentLoading);
      replaceMountedKeys(next);
      loadingKeyRef.current = null;
    }
    loadingKeyRef.current = key;
    replaceMountedKeys(new Set(mountedKeysRef.current).add(key));
  }, [replaceMountedKeys]);

  const handleItemContentReady = useCallback((key: string) => {
    if (!mountedKeysRef.current.has(key)) return;
    readyKeysRef.current.add(key);
    if (loadingKeyRef.current === key) loadingKeyRef.current = null;
    window.requestAnimationFrame(() => pumpLoadQueueRef.current());
  }, []);

  const handleItemHeightChange = useCallback((key: string, previousHeight: number, nextHeight: number) => {
    if (Math.abs(nextHeight - previousHeight) < 1) return;
    const recordedHeight = measuredItemHeightsRef.current.get(key);
    if (recordedHeight !== undefined && Math.abs(recordedHeight - nextHeight) < 1) return;
    measuredItemHeightsRef.current.set(key, nextHeight);
    cacheDiffItemHeight(key, nextHeight);
    setCanvasRevision((revision) => revision + 1);
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

  useLayoutEffect(() => {
    const container = detailScrollerRef.current;
    if (!container) return;
    const measure = () => {
      const nextHeight = Math.max(0, Math.ceil(container.clientHeight));
      if (nextHeight === 0) return;
      const top = container.scrollTop;
      setCanvasViewport((current) => (
        current.height === nextHeight && current.top === top
          ? current
          : { top, height: nextHeight }
      ));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [mobile]);

  useEffect(() => {
    if (selectedTargetKey) prioritizeLoad(selectedTargetKey);
  }, [prioritizeLoad, selectedTargetKey]);

  // Keep the mount pipeline fed whenever the rendered window moves.
  useEffect(() => {
    const validKeys = new Set(orderedFileKeysRef.current);
    for (const key of Array.from(measuredItemHeightsRef.current.keys())) {
      if (!validKeys.has(key)) measuredItemHeightsRef.current.delete(key);
    }
    for (const key of Array.from(mountedKeysRef.current)) {
      if (!validKeys.has(key)) {
        const next = new Set(mountedKeysRef.current);
        next.delete(key);
        readyKeysRef.current.delete(key);
        replaceMountedKeys(next);
      }
    }
    // Only a disappearing file releases the in-flight slot here; a card that
    // merely left the skeleton window still finishes loading, so a stale
    // window commit can never open the serial gate for a second mount.
    if (loadingKeyRef.current && !validKeys.has(loadingKeyRef.current)) {
      loadingKeyRef.current = null;
    }
    if (allOrderedFiles.length === 0) {
      loadingKeyRef.current = null;
      readyKeysRef.current.clear();
      replaceMountedKeys(new Set());
      return;
    }
    pumpLoadQueue();
  }, [allOrderedFiles.length, orderedFileKeysSignature, pumpLoadQueue, renderedIndices, replaceMountedKeys]);

  const handleDetailScroll = useCallback((container: HTMLDivElement) => {
    detailScrollerRef.current = container;
    const previousTop = lastDetailScrollTopRef.current;
    let top = container.scrollTop;
    const delta = top - previousTop;
    // Loading gate: a card that is mounted but not content-ready yet blocks
    // the leading edge — scrolling down stops at a peek into its loading
    // cover, scrolling up at a peek from its bottom. Only gates AHEAD of the
    // previous position apply, so the clamp can never drag the user backwards
    // (e.g. the entry card must not gate the entry scroll itself). Assigning
    // scrollTop here also cancels native fling momentum, which is the point.
    if (delta !== 0) {
      const layout = canvasLayoutRef.current;
      const viewportHeight = container.clientHeight;
      let gatedTop = top;
      for (const key of Array.from(mountedKeysRef.current)) {
        if (readyKeysRef.current.has(key)) continue;
        const index = orderedFileIndexRef.current.get(key);
        if (index === undefined) continue;
        const cardTop = layout.tops[index] ?? 0;
        if (delta > 0) {
          const gate = cardTop + DIFF_SCROLL_GATE_PEEK - viewportHeight;
          if (gate >= previousTop - 1 && gatedTop > gate) gatedTop = Math.max(0, gate);
        } else {
          const cardBottom = cardTop + (layout.heights[index] ?? DEFAULT_DIFF_ITEM_HEIGHT);
          const gate = cardBottom - DIFF_SCROLL_GATE_PEEK;
          if (gate <= previousTop + 1 && gatedTop < gate) gatedTop = gate;
        }
      }
      if (gatedTop !== top) {
        container.scrollTop = gatedTop;
        top = gatedTop;
      }
    }
    lastDetailScrollTopRef.current = top;
    if (Math.abs(top - previousTop) >= DIFF_CANVAS_OVERSCAN) {
      // A jump bigger than the rendered window's runway (scrollbar thumb
      // drags, trackpad flicks on a cold cache) would paint bare canvas for a
      // frame if the window update waited for the next scheduled render.
      flushSync(() => {
        setCanvasViewport({ top, height: container.clientHeight });
      });
    } else if (scrollFrameRef.current === null) {
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        const active = detailScrollerRef.current;
        if (active) setCanvasViewport({ top: active.scrollTop, height: active.clientHeight });
      });
    }
    onDetailScroll?.(container);
  }, [onDetailScroll]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  // Anchor compensation: when (re)measurement shifts the anchor card's top,
  // carry the scroll position along by exactly that delta. Changes below the
  // anchor never touch the scroll position. This only ever applies a delta
  // to the live scrollTop — it never restores an absolute position, so an
  // in-flight user scroll is never eaten.
  useLayoutEffect(() => {
    const container = detailScrollerRef.current;
    if (!container) return;
    const anchor = scrollAnchorRef.current;
    if (anchor.key === null) return;
    const anchorIndex = orderedFileIndexRef.current.get(anchor.key);
    if (anchorIndex === undefined) return;
    const delta = (canvasLayout.tops[anchorIndex] ?? anchor.top) - anchor.top;
    if (Math.abs(delta) < 1) return;
    const nextTop = container.scrollTop + delta;
    lastDetailScrollTopRef.current = nextTop;
    setCanvasViewport((current) => ({ top: nextTop, height: current.height }));
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: nextTop, behavior: 'instant' });
    } else {
      container.scrollTop = nextTop;
    }
  }, [canvasLayout]);

  // Recapture the anchor on every commit (after the compensation above).
  // Keep the current anchor card while it is still visible — notably the
  // focused card sits at the bottom edge after an end-clamped entry scroll,
  // and it must stay the anchor while the cards around it settle, or the
  // viewport drifts away from it. Once it scrolls out of view, the anchor
  // moves to the topmost visible card.
  useLayoutEffect(() => {
    const keys = orderedFileKeysRef.current;
    const tops = canvasLayout.tops;
    if (keys.length === 0) {
      scrollAnchorRef.current = { key: null, top: 0 };
      return;
    }
    const viewTop = lastDetailScrollTopRef.current;
    const viewBottom = viewTop + (detailScrollerRef.current?.clientHeight ?? canvasViewport.height);
    const current = scrollAnchorRef.current;
    if (current.key !== null) {
      const currentIndex = orderedFileIndexRef.current.get(current.key);
      if (currentIndex !== undefined) {
        const top = tops[currentIndex] ?? 0;
        const bottom = top + (canvasLayout.heights[currentIndex] ?? DEFAULT_DIFF_ITEM_HEIGHT);
        if (bottom > viewTop && top < viewBottom) {
          scrollAnchorRef.current = { key: current.key, top };
          return;
        }
      }
    }
    let low = 0;
    let high = tops.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tops[middle] <= viewTop + 1) low = middle + 1;
      else high = middle;
    }
    const index = Math.min(tops.length - 1, Math.max(0, low - 1));
    scrollAnchorRef.current = { key: keys[index] ?? null, top: tops[index] ?? 0 };
  });

  // Explicit scroll-to-file requests land the target top-aligned.
  useLayoutEffect(() => {
    if (!scrollTargetKey) return;
    if (handledScrollRequestNonceRef.current === scrollToKeyNonce) return;
    const targetIndex = orderedFileIndexRef.current.get(scrollTargetKey);
    if (targetIndex === undefined) return;
    // Mount the clicked card first, even if the scroller is not in the DOM
    // yet (Swiper mounts the detail lazily); only the scroll itself waits.
    prioritizeLoad(scrollTargetKey);
    scrollAnchorRef.current = { key: scrollTargetKey, top: canvasLayout.tops[targetIndex] ?? 0 };
    const container = detailScrollerRef.current;
    if (!container) return;
    // Consume the nonce only once the scroll is actually applied; an early
    // commit without the scroller must not swallow the request.
    handledScrollRequestNonceRef.current = scrollToKeyNonce;
    const top = canvasLayout.tops[targetIndex] ?? 0;
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top, behavior: 'instant' });
    } else {
      container.scrollTop = top;
    }
    // Read back the applied position: near the list end the browser clamps
    // the requested top, and the scroll bookkeeping must track where the
    // viewport ACTUALLY landed.
    const appliedTop = container.scrollTop;
    lastDetailScrollTopRef.current = appliedTop;
    setCanvasViewport({ top: appliedTop, height: container.clientHeight });
  }, [canvasLayout, canvasViewport.height, prioritizeLoad, scrollTargetKey, scrollToKeyNonce]);

  // Restore a previously saved native scroll position for this file set.
  useLayoutEffect(() => {
    if (initialDetailScrollTop === undefined) return;
    if (scrollTargetKey) return;
    const restoreKey = orderedFileKeysSignature;
    if (appliedInitialDetailScrollKeyRef.current === restoreKey) return;
    const container = detailScrollerRef.current;
    if (!container) return;
    appliedInitialDetailScrollKeyRef.current = restoreKey;
    const maxTop = Math.max(0, canvasLayout.bottom - container.clientHeight);
    const top = Math.min(Math.max(0, initialDetailScrollTop), maxTop);
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top, behavior: 'instant' });
    } else {
      container.scrollTop = top;
    }
    const appliedTop = container.scrollTop;
    lastDetailScrollTopRef.current = appliedTop;
    setCanvasViewport({ top: appliedTop, height: container.clientHeight });
  }, [canvasLayout.bottom, initialDetailScrollTop, orderedFileKeysSignature, scrollTargetKey]);

  const renderStreamItem = useCallback((item: DiffReviewFile, estimatedHeight: number) => {
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
        visible={mountedKeys.has(item.key)}
        estimatedHeight={estimatedHeight}
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
        onHunkGitAction={item.onHunkGitAction ?? onHunkGitAction}
        onReferenceCopied={onReferenceCopied}
        insertedReferenceKey={insertedReferenceKey}
        copiedReferenceKey={copiedReferenceKey}
        onClearAuditRecord={onClearAuditRecord}
        onContentReady={handleItemContentReady}
        onHeightChange={handleItemHeightChange}
      />
    );
  }, [activePane, copiedReferenceKey, diffOptions, diffViewType, handleItemContentReady, handleItemHeightChange, inlineMode, insertedReferenceKey, matchesSelectedKey, mountedKeys, onClearAuditRecord, onHunkGitAction, onInsertDiffReference, onReferenceCopied, reloadKey, renderStreamBadge, showScrollHint, wrap]);

  const detailBody = (
    <div
      data-diff-stream-content
      data-diff-stream-canvas
      className="termdock-diff-stream relative overflow-clip bg-surface will-change-transform"
      style={{ height: Math.max(canvasViewport.height, canvasLayout.bottom) }}
    >
      {renderedIndices.map((index) => {
        const item = allOrderedFiles[index];
        if (!item) return null;
        return (
          <div
            key={item.key}
            data-diff-canvas-slot={item.key}
            className="absolute inset-x-0"
            style={{ top: canvasLayout.tops[index] }}
          >
            {renderStreamItem(item, canvasLayout.heights[index])}
          </div>
        );
      })}
    </div>
  );

  const detail = (
    <div
      ref={detailScrollerRef}
      className="termdock-diff-stream termdock-diff-stream-scroller h-full max-h-full min-h-0 overflow-y-auto overscroll-contain bg-surface [overflow-anchor:none]"
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
      renderDirectoryTrailing={renderDirectoryTrailing}
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
