import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Swiper as SwiperInstance } from 'swiper';
import type { ChangeAuditRecord, GitDiffOptions } from '../../terminal/api';
import { flattenDiffNavigatorTree, type DiffNavigatorFile, type DiffNavigatorGroup } from './DiffFileNavigator';
import { DiffReviewWorkspace, type DiffReviewMode } from './DiffReviewWorkspace';
import { DiffStreamItem, type DiffStreamFile } from './DiffStreamItem';
import { invalidateFileDiffCached, preloadPreparedFileDiff, type DiffInlineMode, type DiffViewType } from './DiffViewer';
import { useSidebarStore } from '../../stores/useSidebarStore';

// --- ChangeBadge (shared) ---

const MAX_RETAINED_DIFF_ITEMS = 3;
const DESKTOP_PRELOAD_RADIUS = 3;
const DIFF_PRELOAD_CONCURRENCY = 2;
const DIFF_CANVAS_PADDING = 1_000_000;
const DIFF_CANVAS_IDLE_OVERSCAN = 480;
const DIFF_CANVAS_MEDIUM_AHEAD = 960;
const DIFF_CANVAS_FAST_AHEAD = 1_800;
const DIFF_SCROLL_IDLE_MS = 100;
const DIFF_SCROLL_MEDIUM_VELOCITY = 0.35;
const DIFF_SCROLL_FAST_VELOCITY = 1.2;
const DIFF_LOADING_FRONTIER_PEEK = 36;
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
  minScrollTop: number;
  maxScrollTop: number;
}

interface DiffCanvasViewport {
  top: number;
  height: number;
}

type DiffScrollPace = 'idle' | 'slow' | 'medium' | 'fast';

interface DiffScrollMotion {
  direction: 'up' | 'down';
  pace: DiffScrollPace;
}

interface DiffLoadingFrontier {
  minScrollTop: number;
  maxScrollTop: number;
  previousKey: string | null;
  nextKey: string | null;
}

interface DiffBoundaryLoadRequest {
  direction: 'up' | 'down';
  key: string;
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
  const detailScrollerRef = useRef<HTMLDivElement | null>(null);
  const canvasElementRef = useRef<HTMLDivElement | null>(null);
  const handledScrollRequestNonceRef = useRef<number | null>(null);
  const appliedInitialDetailScrollKeyRef = useRef<string | null>(null);
  const pendingCanvasScrollTopRef = useRef<number | null>(null);
  const expectedProgrammaticScrollTopRef = useRef<number | null>(null);
  const nativeCanvasStartRef = useRef(DIFF_CANVAS_PADDING);
  const invalidatedReloadKeyRef = useRef(reloadKey);
  const lastDetailScrollTopRef = useRef(DIFF_CANVAS_PADDING);
  const lastDetailScrollTimeRef = useRef(0);
  const smoothedScrollVelocityRef = useRef(0);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const elasticResetTimerRef = useRef<number | null>(null);
  const elasticOffsetRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  const scrollDirectionRef = useRef<'up' | 'down'>('down');
  const scrollPaceRef = useRef<DiffScrollPace>('idle');
  const loadingPriorityKeyRef = useRef<string | null>(null);
  const pumpLoadQueueRef = useRef<() => void>(() => undefined);
  const loadingFrontierRef = useRef<DiffLoadingFrontier>({
    minScrollTop: DIFF_CANVAS_PADDING,
    maxScrollTop: DIFF_CANVAS_PADDING,
    previousKey: null,
    nextKey: null,
  });
  const measuredItemHeightsRef = useRef<Map<string, number>>(new Map(cachedDiffItemHeights));
  const canvasCandidateKeysRef = useRef<Set<string>>(new Set());
  const mountedKeysRef = useRef<Set<string>>(new Set());
  const stableMountedKeysRef = useRef<Set<string>>(new Set());
  const readyKeysRef = useRef<Set<string>>(new Set());
  const loadingKeyRef = useRef<string | null>(null);
  const orderedFileKeysRef = useRef<string[]>([]);
  const orderedFileIndexRef = useRef<Map<string, number>>(new Map());
  const [mountedKeys, setMountedKeys] = useState<Set<string>>(() => new Set());
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [readinessRevision, setReadinessRevision] = useState(0);
  const [canvasOrigin, setCanvasOrigin] = useState({ index: 0, top: DIFF_CANVAS_PADDING });
  const [canvasViewport, setCanvasViewport] = useState<DiffCanvasViewport>({ top: DIFF_CANVAS_PADDING, height: 0 });
  const [scrollMotion, setScrollMotion] = useState<DiffScrollMotion>({ direction: 'down', pace: 'idle' });
  const [boundaryLoadRequest, setBoundaryLoadRequest] = useState<DiffBoundaryLoadRequest | null>(null);
  const orderedFileKeys = useMemo(() => allOrderedFiles.map((file) => file.key), [allOrderedFiles]);
  const orderedFileKeysSignature = orderedFileKeys.join('\u0001');
  orderedFileKeysRef.current = orderedFileKeys;
  orderedFileIndexRef.current = new Map(orderedFileKeys.map((key, index) => [key, index]));
  const canvasLayout = useMemo<DiffCanvasLayout>(() => {
    const heights = orderedFileKeys.map((key) => measuredItemHeightsRef.current.get(key) ?? DEFAULT_DIFF_ITEM_HEIGHT);
    const tops = new Array<number>(heights.length);
    const originIndex = Math.min(Math.max(0, canvasOrigin.index), Math.max(0, heights.length - 1));
    if (heights.length > 0) {
      tops[originIndex] = canvasOrigin.top;
      for (let index = originIndex - 1; index >= 0; index -= 1) {
        tops[index] = tops[index + 1] - heights[index];
      }
      for (let index = originIndex + 1; index < heights.length; index += 1) {
        tops[index] = tops[index - 1] + heights[index - 1];
      }
    }
    const firstTop = heights.length > 0 ? tops[0] : 0;
    const lastTop = heights.length > 0 ? tops[heights.length - 1] : 0;
    const finalBottom = heights.length > 0 ? lastTop + heights[heights.length - 1] : 0;
    const maxScrollTop = heights.length > 0
      ? Math.max(firstTop, lastTop, finalBottom - canvasViewport.height)
      : 0;
    return {
      tops,
      heights,
      minScrollTop: firstTop,
      maxScrollTop,
    };
  }, [canvasOrigin, canvasRevision, canvasViewport.height, orderedFileKeysSignature]);

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
  const loadingFrontier = useMemo<DiffLoadingFrontier>(() => {
    const count = orderedFileKeys.length;
    if (count === 0) {
      return { minScrollTop: 0, maxScrollTop: 0, previousKey: null, nextKey: null };
    }

    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (canvasLayout.tops[middle] <= canvasViewport.top + 1) low = middle + 1;
      else high = middle;
    }
    let seedIndex = Math.min(count - 1, Math.max(0, low - 1));
    if (!stableMountedKeysRef.current.has(orderedFileKeys[seedIndex])) {
      const readyIndices = Array.from(stableMountedKeysRef.current)
        .map((key) => orderedFileIndexRef.current.get(key))
        .filter((index): index is number => index !== undefined);
      if (readyIndices.length > 0) {
        readyIndices.sort((left, right) => Math.abs(left - seedIndex) - Math.abs(right - seedIndex));
        seedIndex = readyIndices[0];
      } else {
        seedIndex = Math.min(count - 1, Math.max(0, canvasOrigin.index));
      }
    }

    let startIndex = seedIndex;
    let endIndex = seedIndex;
    if (stableMountedKeysRef.current.has(orderedFileKeys[seedIndex])) {
      while (startIndex > 0 && stableMountedKeysRef.current.has(orderedFileKeys[startIndex - 1])) startIndex -= 1;
      while (endIndex < count - 1 && stableMountedKeysRef.current.has(orderedFileKeys[endIndex + 1])) endIndex += 1;
    }

    const previousKey = startIndex > 0 ? orderedFileKeys[startIndex - 1] : null;
    const nextKey = endIndex < count - 1 ? orderedFileKeys[endIndex + 1] : null;
    const minScrollTop = previousKey
      ? Math.max(canvasLayout.minScrollTop, canvasLayout.tops[startIndex] - DIFF_LOADING_FRONTIER_PEEK)
      : canvasLayout.minScrollTop;
    const nextFrontierTop = nextKey ? canvasLayout.tops[endIndex + 1] : null;
    const maxScrollTop = nextFrontierTop === null
      ? canvasLayout.maxScrollTop
      : Math.min(
          canvasLayout.maxScrollTop,
          Math.max(canvasLayout.tops[startIndex], nextFrontierTop - canvasViewport.height + DIFF_LOADING_FRONTIER_PEEK),
        );
    return { minScrollTop, maxScrollTop, previousKey, nextKey };
  }, [
    canvasLayout.maxScrollTop,
    canvasLayout.minScrollTop,
    canvasLayout.tops,
    canvasOrigin.index,
    canvasViewport.height,
    canvasViewport.top,
    orderedFileKeys,
    readinessRevision,
  ]);
  loadingFrontierRef.current = loadingFrontier;

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

  useEffect(() => {
    if (!activePane || mobile || visibleAnchorIndex < 0) return;
    const directionStep = scrollMotion.direction === 'down' ? 1 : -1;
    const indices = [visibleAnchorIndex];
    for (let distance = 1; distance <= DESKTOP_PRELOAD_RADIUS; distance += 1) {
      indices.push(visibleAnchorIndex + directionStep * distance);
      indices.push(visibleAnchorIndex - directionStep * distance);
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
  }, [activePane, allOrderedFiles, diffOptions, inlineMode, mobile, scrollMotion.direction, sidebarRootPath, visibleAnchorIndex]);

  const replaceMountedKeys = useCallback((next: Set<string>) => {
    mountedKeysRef.current = next;
    setMountedKeys(next);
  }, []);

  const pumpLoadQueue = useCallback(() => {
    const priorityKey = loadingPriorityKeyRef.current;
    if (scrollPaceRef.current === 'fast' && !priorityKey) return;
    if (loadingKeyRef.current) return;
    if (priorityKey && !mountedKeysRef.current.has(priorityKey) && mountedKeysRef.current.size >= MAX_RETAINED_DIFF_ITEMS) {
      const priorityIndex = orderedFileIndexRef.current.get(priorityKey);
      const removable = Array.from(mountedKeysRef.current)
        .filter((key) => key !== loadingKeyRef.current)
        .sort((left, right) => {
          const leftDistance = Math.abs((orderedFileIndexRef.current.get(left) ?? 0) - (priorityIndex ?? 0));
          const rightDistance = Math.abs((orderedFileIndexRef.current.get(right) ?? 0) - (priorityIndex ?? 0));
          return rightDistance - leftDistance;
        })[0];
      if (removable) {
        const next = new Set(mountedKeysRef.current);
        next.delete(removable);
        replaceMountedKeys(next);
      }
    }
    if (mountedKeysRef.current.size >= MAX_RETAINED_DIFF_ITEMS) return;
    const candidateSet = new Set(canvasCandidateKeysRef.current);
    if (priorityKey && orderedFileIndexRef.current.has(priorityKey)) candidateSet.add(priorityKey);
    const candidates = Array.from(candidateSet).filter((key) => !mountedKeysRef.current.has(key));
    if (candidates.length === 0) return;
    const viewportCenter = canvasViewport.top + canvasViewport.height / 2;
    const viewportStart = canvasViewport.top;
    const viewportEnd = canvasViewport.top + canvasViewport.height;
    const direction = scrollDirectionRef.current;
    candidates.sort((left, right) => {
      if (left === priorityKey) return -1;
      if (right === priorityKey) return 1;
      const leftIndex = orderedFileIndexRef.current.get(left) ?? 0;
      const rightIndex = orderedFileIndexRef.current.get(right) ?? 0;
      const leftTop = canvasLayout.tops[leftIndex] ?? 0;
      const rightTop = canvasLayout.tops[rightIndex] ?? 0;
      const leftBottom = leftTop + (canvasLayout.heights[leftIndex] ?? DEFAULT_DIFF_ITEM_HEIGHT);
      const rightBottom = rightTop + (canvasLayout.heights[rightIndex] ?? DEFAULT_DIFF_ITEM_HEIGHT);
      const leftInViewport = leftBottom >= viewportStart && leftTop <= viewportEnd;
      const rightInViewport = rightBottom >= viewportStart && rightTop <= viewportEnd;
      if (leftInViewport !== rightInViewport) return leftInViewport ? -1 : 1;
      const leftAhead = direction === 'down' ? leftTop > viewportEnd : leftBottom < viewportStart;
      const rightAhead = direction === 'down' ? rightTop > viewportEnd : rightBottom < viewportStart;
      if (leftAhead !== rightAhead) return leftAhead ? -1 : 1;
      const distance = Math.abs(leftTop - viewportCenter) - Math.abs(rightTop - viewportCenter);
      if (distance !== 0) return distance;
      return direction === 'up' ? rightTop - leftTop : leftTop - rightTop;
    });
    const nextKey = candidates[0];
    if (!nextKey) return;
    stableMountedKeysRef.current.delete(nextKey);
    loadingKeyRef.current = nextKey;
    replaceMountedKeys(new Set(mountedKeysRef.current).add(nextKey));
  }, [canvasLayout.heights, canvasLayout.tops, canvasViewport.height, canvasViewport.top, replaceMountedKeys]);
  pumpLoadQueueRef.current = pumpLoadQueue;

  const prioritizeLoad = useCallback((key: string) => {
    // Scroll-driven selection sync frequently points at the file that is
    // already mounted under the viewport. It must not cancel an adjacent
    // background mount; otherwise every slow scroll aborts the next file and
    // only restarts it after the user hits the loading frontier.
    if (mountedKeysRef.current.has(key)) return;
    const currentLoading = loadingKeyRef.current;
    if (currentLoading && currentLoading !== key && !stableMountedKeysRef.current.has(currentLoading)) {
      const next = new Set(mountedKeysRef.current);
      next.delete(currentLoading);
      stableMountedKeysRef.current.delete(currentLoading);
      setReadinessRevision((revision) => revision + 1);
      replaceMountedKeys(next);
      loadingKeyRef.current = null;
    }
    stableMountedKeysRef.current.delete(key);
    loadingKeyRef.current = key;
    replaceMountedKeys(new Set(mountedKeysRef.current).add(key));
  }, [replaceMountedKeys]);

  const focusLoad = useCallback((key: string) => {
    const wasReady = mountedKeysRef.current.has(key) && stableMountedKeysRef.current.has(key);
    stableMountedKeysRef.current = wasReady ? new Set([key]) : new Set();
    setReadinessRevision((revision) => revision + 1);
    loadingKeyRef.current = wasReady ? null : key;
    replaceMountedKeys(new Set([key]));
  }, [replaceMountedKeys]);

  const handleItemContentReady = useCallback((key: string) => {
    if (!mountedKeysRef.current.has(key)) return;
    readyKeysRef.current.add(key);
    stableMountedKeysRef.current.add(key);
    setReadinessRevision((revision) => revision + 1);
    if (loadingKeyRef.current === key) loadingKeyRef.current = null;
    if (loadingPriorityKeyRef.current === key) loadingPriorityKeyRef.current = null;
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
      const logicalTop = container.scrollTop + nativeCanvasStartRef.current;
      setCanvasViewport((current) => (
        current.height === nextHeight && current.top === logicalTop
          ? current
          : { top: logicalTop, height: nextHeight }
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

  const renderedIndices = useMemo(() => {
    const ahead = scrollMotion.pace === 'fast'
      ? DIFF_CANVAS_FAST_AHEAD
      : scrollMotion.pace === 'medium'
        ? DIFF_CANVAS_MEDIUM_AHEAD
        : DIFF_CANVAS_IDLE_OVERSCAN;
    const behind = scrollMotion.pace === 'fast'
      ? 120
      : scrollMotion.pace === 'medium'
        ? 240
        : DIFF_CANVAS_IDLE_OVERSCAN;
    const start = canvasViewport.top - (scrollMotion.direction === 'up' ? ahead : behind);
    const end = canvasViewport.top + canvasViewport.height + (scrollMotion.direction === 'down' ? ahead : behind);
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
    // Keep the immediate neighbours mounted even when the current diff is
    // taller than the pixel overscan. Data for ±3 is warmed separately; these
    // two DOM neighbours provide measured heights and a seamless boundary.
    for (let index = visibleAnchorIndex - 1; index <= visibleAnchorIndex + 1; index += 1) {
      if (index >= 0 && index < canvasLayout.tops.length) indexSet.add(index);
    }
    return Array.from(indexSet).sort((left, right) => left - right);
  }, [canvasLayout.heights, canvasLayout.tops, canvasViewport.height, canvasViewport.top, scrollMotion, visibleAnchorIndex]);

  useEffect(() => {
    const validKeys = new Set(orderedFileKeysRef.current);
    for (const key of Array.from(measuredItemHeightsRef.current.keys())) {
      if (!validKeys.has(key)) measuredItemHeightsRef.current.delete(key);
    }
    const candidateKeys = new Set(renderedIndices.map((index) => orderedFileKeysRef.current[index]).filter(Boolean));
    canvasCandidateKeysRef.current = candidateKeys;
    const retainedMounted = new Set(
      Array.from(mountedKeysRef.current).filter((key) => validKeys.has(key) && candidateKeys.has(key)),
    );
    if (retainedMounted.size !== mountedKeysRef.current.size) {
      let readinessChanged = false;
      for (const key of mountedKeysRef.current) {
        if (!retainedMounted.has(key) && stableMountedKeysRef.current.delete(key)) readinessChanged = true;
      }
      if (readinessChanged) setReadinessRevision((revision) => revision + 1);
      replaceMountedKeys(retainedMounted);
    }
    readyKeysRef.current = new Set(Array.from(readyKeysRef.current).filter((key) => validKeys.has(key)));
    stableMountedKeysRef.current = new Set(
      Array.from(stableMountedKeysRef.current).filter((key) => validKeys.has(key) && retainedMounted.has(key)),
    );
    if (loadingKeyRef.current && (!validKeys.has(loadingKeyRef.current) || !candidateKeys.has(loadingKeyRef.current))) {
      loadingKeyRef.current = null;
    }
    if (allOrderedFiles.length === 0) {
      canvasCandidateKeysRef.current.clear();
      readyKeysRef.current.clear();
      stableMountedKeysRef.current.clear();
      loadingKeyRef.current = null;
      replaceMountedKeys(new Set());
      return;
    }
    pumpLoadQueue();
  }, [allOrderedFiles.length, orderedFileKeysSignature, pumpLoadQueue, renderedIndices, replaceMountedKeys]);

  const requestBoundaryLoad = useCallback((direction: 'up' | 'down') => {
    const frontier = loadingFrontierRef.current;
    const key = direction === 'up' ? frontier.previousKey : frontier.nextKey;
    if (!key) return;
    loadingPriorityKeyRef.current = key;
    canvasCandidateKeysRef.current.add(key);
    scrollDirectionRef.current = direction;
    scrollPaceRef.current = 'idle';
    smoothedScrollVelocityRef.current = 0;
    setScrollMotion({ direction, pace: 'idle' });
    setBoundaryLoadRequest((current) => (
      current?.direction === direction && current.key === key ? current : { direction, key }
    ));
    window.requestAnimationFrame(() => pumpLoadQueueRef.current());
  }, []);

  useEffect(() => {
    if (!boundaryLoadRequest) return;
    const frontierKey = boundaryLoadRequest.direction === 'up'
      ? loadingFrontier.previousKey
      : loadingFrontier.nextKey;
    if (stableMountedKeysRef.current.has(boundaryLoadRequest.key) || frontierKey !== boundaryLoadRequest.key) {
      setBoundaryLoadRequest(null);
    }
  }, [boundaryLoadRequest, loadingFrontier, readinessRevision]);

  const handleDetailScroll = useCallback((container: HTMLDivElement) => {
    detailScrollerRef.current = container;
    const nativeTop = container.scrollTop;
    const logicalTop = nativeTop + nativeCanvasStartRef.current;
    const expectedTop = expectedProgrammaticScrollTopRef.current;
    if (expectedTop !== null && Math.abs(expectedTop - nativeTop) < 1) {
      expectedProgrammaticScrollTopRef.current = null;
      lastDetailScrollTopRef.current = logicalTop;
      lastDetailScrollTimeRef.current = performance.now();
      smoothedScrollVelocityRef.current = 0;
      scrollPaceRef.current = 'idle';
      setScrollMotion((current) => current.pace === 'idle' ? current : { ...current, pace: 'idle' });
      setCanvasViewport({ top: logicalTop, height: container.clientHeight });
      onDetailScroll?.(container);
      return;
    }

    const now = performance.now();
    const delta = logicalTop - lastDetailScrollTopRef.current;
    const elapsed = lastDetailScrollTimeRef.current > 0 ? Math.max(1, now - lastDetailScrollTimeRef.current) : 16;
    const direction = delta < 0 ? 'up' : delta > 0 ? 'down' : scrollDirectionRef.current;
    const nativeMax = Math.max(0, container.scrollHeight - container.clientHeight);
    if (delta < 0 && nativeTop <= 0.75) requestBoundaryLoad('up');
    if (delta > 0 && nativeTop >= nativeMax - 0.75) requestBoundaryLoad('down');
    const instantVelocity = Math.abs(delta) / elapsed;
    const velocity = smoothedScrollVelocityRef.current * 0.65 + instantVelocity * 0.35;
    const pace: DiffScrollPace = velocity >= DIFF_SCROLL_FAST_VELOCITY
      ? 'fast'
      : velocity >= DIFF_SCROLL_MEDIUM_VELOCITY
        ? 'medium'
        : 'slow';

    scrollDirectionRef.current = direction;
    scrollPaceRef.current = pace;
    smoothedScrollVelocityRef.current = velocity;
    lastDetailScrollTopRef.current = logicalTop;
    lastDetailScrollTimeRef.current = now;
    setScrollMotion((current) => (
      current.direction === direction && current.pace === pace ? current : { direction, pace }
    ));
    setCanvasViewport({ top: logicalTop, height: container.clientHeight });

    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null;
      smoothedScrollVelocityRef.current = 0;
      scrollPaceRef.current = 'idle';
      setScrollMotion((current) => current.pace === 'idle' ? current : { ...current, pace: 'idle' });
      const activeContainer = detailScrollerRef.current;
      if (activeContainer) {
        const nativeMax = Math.max(0, activeContainer.scrollHeight - activeContainer.clientHeight);
        if (scrollDirectionRef.current === 'up' && activeContainer.scrollTop <= 0.75) requestBoundaryLoad('up');
        if (scrollDirectionRef.current === 'down' && activeContainer.scrollTop >= nativeMax - 0.75) {
          requestBoundaryLoad('down');
        }
        setCanvasViewport({
          top: activeContainer.scrollTop + nativeCanvasStartRef.current,
          height: activeContainer.clientHeight,
        });
      }
    }, DIFF_SCROLL_IDLE_MS);
    onDetailScroll?.(container);
  }, [onDetailScroll, requestBoundaryLoad]);

  useEffect(() => () => {
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
  }, []);

  useEffect(() => {
    const container = detailScrollerRef.current;
    if (!container) return;
    const setElasticOffset = (offset: number, animate: boolean) => {
      const canvas = canvasElementRef.current;
      elasticOffsetRef.current = offset;
      if (!canvas) return;
      canvas.style.transition = animate ? 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
      canvas.style.transform = `translate3d(0, ${offset}px, 0)`;
      if (elasticResetTimerRef.current !== null) window.clearTimeout(elasticResetTimerRef.current);
      if (animate) {
        elasticResetTimerRef.current = window.setTimeout(() => {
          elasticResetTimerRef.current = null;
          const activeCanvas = canvasElementRef.current;
          if (activeCanvas) activeCanvas.style.transition = 'none';
        }, 200);
      }
    };
    const releaseElasticOffset = () => {
      if (Math.abs(elasticOffsetRef.current) < 0.5) return;
      setElasticOffset(0, true);
    };
    const handleWheel = (event: WheelEvent) => {
      const nativeMax = Math.max(0, container.scrollHeight - container.clientHeight);
      const pushingPastTop = event.deltaY < 0 && container.scrollTop <= 0.75;
      const pushingPastBottom = event.deltaY > 0 && container.scrollTop >= nativeMax - 0.75;
      if (!pushingPastTop && !pushingPastBottom) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      requestBoundaryLoad(pushingPastTop ? 'up' : 'down');
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (elasticResetTimerRef.current !== null) {
        window.clearTimeout(elasticResetTimerRef.current);
        elasticResetTimerRef.current = null;
      }
      if (Math.abs(elasticOffsetRef.current) >= 0.5) setElasticOffset(0, false);
      touchYRef.current = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY;
      const previousY = touchYRef.current;
      if (currentY === undefined || previousY === null) return;
      touchYRef.current = currentY;
      const deltaY = previousY - currentY;
      const nativeMax = Math.max(0, container.scrollHeight - container.clientHeight);
      const pushingPastTop = deltaY < 0 && container.scrollTop <= 0.75;
      const pushingPastBottom = deltaY > 0 && container.scrollTop >= nativeMax - 0.75;
      const fingerDelta = currentY - previousY;
      if (pushingPastTop || pushingPastBottom) {
        const direction = pushingPastTop ? 1 : -1;
        const currentMagnitude = Math.abs(elasticOffsetRef.current);
        const outwardDistance = pushingPastTop ? Math.max(0, fingerDelta) : Math.max(0, -fingerDelta);
        const resistance = Math.max(0.08, 0.34 * (1 - currentMagnitude / 24));
        const nextMagnitude = Math.min(24, currentMagnitude + outwardDistance * resistance);
        setElasticOffset(direction * nextMagnitude, false);
      } else if (Math.abs(elasticOffsetRef.current) >= 0.5) {
        const nextOffset = elasticOffsetRef.current + fingerDelta * 0.7;
        const crossedZero = Math.sign(nextOffset) !== Math.sign(elasticOffsetRef.current);
        setElasticOffset(crossedZero ? 0 : nextOffset, false);
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        return;
      } else {
        return;
      }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      requestBoundaryLoad(pushingPastTop ? 'up' : 'down');
    };
    const handleTouchEnd = () => {
      touchYRef.current = null;
      releaseElasticOffset();
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
      if (elasticResetTimerRef.current !== null) {
        window.clearTimeout(elasticResetTimerRef.current);
        elasticResetTimerRef.current = null;
      }
    };
  }, [requestBoundaryLoad]);

  useEffect(() => {
    if (!scrollTargetKey) return;
    if (handledScrollRequestNonceRef.current === scrollToKeyNonce) return;
    handledScrollRequestNonceRef.current = scrollToKeyNonce;
    const targetIndex = orderedFileIndexRef.current.get(scrollTargetKey);
    if (targetIndex === undefined) return;
    let top = DIFF_CANVAS_PADDING;
    for (let index = 0; index < targetIndex; index += 1) {
      top += measuredItemHeightsRef.current.get(orderedFileKeysRef.current[index]) ?? DEFAULT_DIFF_ITEM_HEIGHT;
    }
    const nextOrigin = { index: targetIndex, top };
    setCanvasOrigin(nextOrigin);
    pendingCanvasScrollTopRef.current = top;
    setCanvasViewport((current) => ({ top, height: current.height }));
    focusLoad(scrollTargetKey);
  }, [focusLoad, scrollTargetKey, scrollToKeyNonce]);

  useLayoutEffect(() => {
    const container = detailScrollerRef.current;
    if (!container) return;
    const requestedLogicalTop = pendingCanvasScrollTopRef.current ?? lastDetailScrollTopRef.current;
    pendingCanvasScrollTopRef.current = null;
    const logicalTop = Math.min(
      loadingFrontier.maxScrollTop,
      Math.max(loadingFrontier.minScrollTop, requestedLogicalTop),
    );
    const nativeTop = logicalTop - loadingFrontier.minScrollTop;
    nativeCanvasStartRef.current = loadingFrontier.minScrollTop;
    lastDetailScrollTopRef.current = logicalTop;
    lastDetailScrollTimeRef.current = performance.now();
    setCanvasViewport((current) => (
      current.top === logicalTop && current.height === container.clientHeight
        ? current
        : { top: logicalTop, height: container.clientHeight }
    ));
    if (Math.abs(container.scrollTop - nativeTop) < 1) return;
    expectedProgrammaticScrollTopRef.current = nativeTop;
    container.scrollTo({ top: nativeTop, behavior: 'instant' });
  }, [canvasOrigin, loadingFrontier.maxScrollTop, loadingFrontier.minScrollTop]);

  useLayoutEffect(() => {
    if (initialDetailScrollTop === undefined) return;
    if (scrollTargetKey) return;
    const restoreKey = orderedFileKeysSignature;
    if (appliedInitialDetailScrollKeyRef.current === restoreKey) return;
    const container = detailScrollerRef.current;
    if (!container) return;
    const nativeSpan = Math.max(0, loadingFrontier.maxScrollTop - loadingFrontier.minScrollTop);
    const requestedNativeTop = initialDetailScrollTop >= loadingFrontier.minScrollTop
      ? initialDetailScrollTop - loadingFrontier.minScrollTop
      : initialDetailScrollTop;
    const nativeTop = Math.min(nativeSpan, Math.max(0, requestedNativeTop));
    const logicalTop = nativeTop + loadingFrontier.minScrollTop;
    const frame = window.requestAnimationFrame(() => {
      appliedInitialDetailScrollKeyRef.current = restoreKey;
      nativeCanvasStartRef.current = loadingFrontier.minScrollTop;
      lastDetailScrollTopRef.current = logicalTop;
      lastDetailScrollTimeRef.current = performance.now();
      expectedProgrammaticScrollTopRef.current = nativeTop;
      setCanvasViewport({ top: logicalTop, height: container.clientHeight });
      container.scrollTo({ top: nativeTop, behavior: 'instant' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialDetailScrollTop, loadingFrontier.maxScrollTop, loadingFrontier.minScrollTop, orderedFileKeysSignature, scrollTargetKey]);

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
        onReferenceCopied={onReferenceCopied}
        insertedReferenceKey={insertedReferenceKey}
        copiedReferenceKey={copiedReferenceKey}
        onClearAuditRecord={onClearAuditRecord}
        onContentReady={handleItemContentReady}
        onHeightChange={handleItemHeightChange}
      />
    );
  }, [activePane, copiedReferenceKey, diffOptions, diffViewType, handleItemContentReady, handleItemHeightChange, inlineMode, insertedReferenceKey, matchesSelectedKey, mountedKeys, onClearAuditRecord, onInsertDiffReference, onReferenceCopied, reloadKey, renderStreamBadge, showScrollHint, wrap]);

  const detailBody = (
    <div
      ref={canvasElementRef}
      data-diff-stream-content
      data-diff-stream-canvas
      className="termdock-diff-stream relative overflow-clip bg-surface will-change-transform"
      style={{
        height: Math.max(
          canvasViewport.height,
          loadingFrontier.maxScrollTop - loadingFrontier.minScrollTop + canvasViewport.height,
        ),
      }}
    >
      {renderedIndices.map((index) => {
        const item = allOrderedFiles[index];
        if (!item) return null;
        const concealUntilStable = item.key !== selectedTargetKey
          && !stableMountedKeysRef.current.has(item.key);
        return (
          <div
            key={item.key}
            data-diff-canvas-slot={item.key}
            className={`absolute inset-x-0 ${concealUntilStable ? 'invisible' : ''}`}
            style={{ top: canvasLayout.tops[index] - loadingFrontier.minScrollTop }}
          >
            {renderStreamItem(item, canvasLayout.heights[index])}
          </div>
        );
      })}
      {boundaryLoadRequest?.direction === 'up' && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-x-0 z-20 flex h-9 items-center justify-center gap-2 border-b border-border/20 bg-surface/95 text-[11px] text-muted-foreground backdrop-blur"
          style={{ top: 0 }}
        >
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          正在加载上一个文件…
        </div>
      )}
      {boundaryLoadRequest?.direction === 'down' && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-x-0 z-20 flex h-9 items-center justify-center gap-2 border-t border-border/20 bg-surface/95 text-[11px] text-muted-foreground backdrop-blur"
          style={{
            top: loadingFrontier.maxScrollTop
              - loadingFrontier.minScrollTop
              + canvasViewport.height
              - DIFF_LOADING_FRONTIER_PEEK,
          }}
        >
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          正在加载下一个文件…
        </div>
      )}
    </div>
  );

  const detail = mobile ? (
    <div
      ref={detailScrollerRef}
      className="termdock-diff-stream termdock-diff-stream-scroller h-full max-h-full min-h-0 overflow-y-auto overscroll-contain bg-surface [overflow-anchor:none]"
      onScroll={(event) => handleDetailScroll(event.currentTarget)}
    >
      {detailBody}
    </div>
  ) : (
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
