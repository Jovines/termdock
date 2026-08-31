import { useCallback, useLayoutEffect, useState, useRef } from 'react';
import type { ChangeAuditRecord, GitChangedFile, GitDiffOptions } from '../../terminal/api';
import { DiffViewer, type DiffHunkActionRequest, type DiffInlineMode, type DiffViewerPreparedDiff, type DiffViewType } from './DiffViewer';

// Give ResizeObserver a few frames to publish the first real height before the
// next neighbour mounts. Keeping this short is important: this queue is the
// user's background runway, not a loading animation.
const DIFF_HEIGHT_SETTLE_MS = 96;
// Approximate height of the sticky file header; used to stretch the loading
// cover so it fills the slot's estimated height instead of leaving bare canvas.
const DIFF_HEADER_ESTIMATE = 44;

export interface DiffStreamFile {
  path: string;
  absolutePath?: string | null;
  status: string;
}

interface DiffStreamItemProps {
  file: DiffStreamFile;
  repoRoot: string | null;
  selectionPath: string;
  displayName: string;
  displayDir?: string | null;
  selected: boolean;
  activePane: boolean;
  visible: boolean;
  reusableContent?: boolean;
  estimatedHeight?: number;
  lightweight?: boolean;
  wrap: boolean;
  showScrollHint: boolean;
  viewType?: DiffViewType;
  inlineMode?: DiffInlineMode;
  diffOptions?: GitDiffOptions;
  reloadKey?: number;
  auditRecords: ChangeAuditRecord[];
  diffOverride?: string | null;
  preparedDiff?: DiffViewerPreparedDiff | null;
  renderBadge: (status: string) => React.ReactNode;
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
  onHunkGitAction?: (request: DiffHunkActionRequest) => Promise<void>;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  onClearAuditRecord?: (id: string) => void;
  onContentReady?: (selectionPath: string) => void;
  onHeightChange?: (selectionPath: string, previousHeight: number, nextHeight: number) => void;
}

export function DiffStreamItem({
  file,
  repoRoot,
  selectionPath,
  displayName,
  displayDir,
  selected,
  activePane,
  visible,
  reusableContent = false,
  estimatedHeight,
  lightweight = false,
  wrap,
  showScrollHint,
  viewType,
  inlineMode,
  diffOptions,
  reloadKey = 0,
  auditRecords,
  diffOverride,
  preparedDiff,
  renderBadge,
  onInsertDiffReference,
  onHunkGitAction,
  onReferenceCopied,
  insertedReferenceKey,
  copiedReferenceKey,
  onClearAuditRecord,
  onContentReady,
  onHeightChange,
}: DiffStreamItemProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [measuredBodyHeight, setMeasuredBodyHeight] = useState<number | null>(null);
  const measuredBodyHeightRef = useRef(64);
  const measuredItemHeightRef = useRef(estimatedHeight ?? 104);
  const pendingCommitHeightRef = useRef<number | null>(null);
  const lastIntrinsicHeightRef = useRef<number | null>(null);
  const viewerReadyRef = useRef(false);
  const contentReadyRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  const absolutePath = file.absolutePath || (repoRoot ? `${repoRoot}/${file.path}` : file.path);

  const commitContentReady = useCallback(() => {
    if (contentReadyRef.current) return;
    contentReadyRef.current = true;
    setContentReady(true);
    onContentReady?.(selectionPath);
  }, [onContentReady, selectionPath]);

  useLayoutEffect(() => {
    viewerReadyRef.current = false;
    contentReadyRef.current = false;
    pendingCommitHeightRef.current = null;
    lastIntrinsicHeightRef.current = null;
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setViewerReady(false);
    setContentReady(false);
    return () => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, [diffOverride, preparedDiff, reloadKey, reusableContent, visible]);

  // Keep the old slot height until the virtual canvas has accepted the final
  // measurement. Releasing it in a layout effect makes the canvas update and
  // the content reveal land in the same paint instead of visibly growing over
  // several parsing/ResizeObserver frames.
  useLayoutEffect(() => {
    const pendingHeight = pendingCommitHeightRef.current;
    if (!viewerReady || pendingHeight === null) return;
    if (Math.abs((estimatedHeight ?? 104) - pendingHeight) >= 1) return;
    pendingCommitHeightRef.current = null;
    commitContentReady();
  }, [commitContentReady, estimatedHeight, viewerReady]);

  useLayoutEffect(() => {
    if (!visible || !viewerReady) return;
    const body = bodyRef.current;
    if (!body) return;

    const recordHeight = () => {
      if (!viewerReadyRef.current || contentReadyRef.current) return;
      const nextBodyHeight = Math.ceil(Math.max(
        body.getBoundingClientRect().height,
        body.scrollHeight,
      ));
      const previousHeight = measuredBodyHeightRef.current;
      if (nextBodyHeight > 0 && previousHeight !== nextBodyHeight) {
        measuredBodyHeightRef.current = nextBodyHeight;
        setMeasuredBodyHeight(nextBodyHeight);
      }
      const item = containerRef.current;
      if (!item) return;
      const headerHeight = headerRef.current?.getBoundingClientRect().height ?? DIFF_HEADER_ESTIMATE;
      const nextItemHeight = Math.ceil(Math.max(
        item.scrollHeight,
        headerHeight + nextBodyHeight + 1,
      ));
      if (nextItemHeight <= 0 || lastIntrinsicHeightRef.current === nextItemHeight) return;
      lastIntrinsicHeightRef.current = nextItemHeight;
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        if (!viewerReadyRef.current || contentReadyRef.current) return;
        const settledHeight = lastIntrinsicHeightRef.current;
        if (settledHeight === null) return;
        const previousItemHeight = measuredItemHeightRef.current;
        pendingCommitHeightRef.current = settledHeight;
        if (Math.abs(previousItemHeight - settledHeight) < 1 || !onHeightChange) {
          measuredItemHeightRef.current = settledHeight;
          pendingCommitHeightRef.current = null;
          commitContentReady();
          return;
        }
        measuredItemHeightRef.current = settledHeight;
        onHeightChange(selectionPath, previousItemHeight, settledHeight);
      }, DIFF_HEIGHT_SETTLE_MS);
    };
    recordHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(recordHeight);
    observer.observe(body);
    return () => observer.disconnect();
  }, [commitContentReady, onHeightChange, selectionPath, viewerReady, visible]);

  const holdingMeasuredContent = visible && !contentReady;

  return (
    <div
      ref={containerRef}
      data-diff-stream-item={selectionPath}
      data-diff-selection-path={selectionPath}
      data-diff-file-path={file.path}
      data-diff-absolute-path={absolutePath}
      className={`scroll-mt-3 border-b border-border/15 last:border-b-0 ${
        holdingMeasuredContent || !visible ? 'overflow-hidden' : ''
      } ${selected ? 'bg-surface-elevated/35' : ''}`}
      style={visible
        ? (holdingMeasuredContent ? { height: estimatedHeight ?? 104 } : undefined)
        : { height: estimatedHeight ?? 104 }}
    >
      <div ref={headerRef} data-diff-stream-header className={`sticky top-0 z-10 flex min-w-0 items-center gap-2 border-b border-border/15 px-3 py-2 backdrop-blur ${
        selected ? 'bg-surface-elevated/95' : 'bg-surface/95'
      }`}>
        {renderBadge(file.status)}
        <div className="min-w-0 flex-1" title={absolutePath}>
          <div className="truncate text-xs font-semibold text-foreground">{displayName}</div>
          {displayDir && <div className="truncate text-[10px] text-muted-foreground">{displayDir}</div>}
        </div>
      </div>
      <div
        ref={bodyRef}
        className="relative"
        data-diff-stream-body
        style={visible
          ? { minHeight: contentReady ? 64 : Math.max(measuredBodyHeight ?? 64, (estimatedHeight ?? 104) - DIFF_HEADER_ESTIMATE) }
          : { height: Math.max(measuredBodyHeight ?? 64, (estimatedHeight ?? 104) - DIFF_HEADER_ESTIMATE) }}
      >
        {visible ? (
          <DiffViewer
            active={activePane}
            repoRoot={repoRoot}
            filePath={file.path}
            referenceFilePath={absolutePath}
            changedFile={file as GitChangedFile}
            wrap={wrap}
            showScrollHint={showScrollHint}
            viewType={viewType}
            inlineMode={inlineMode}
            diffOptions={diffOptions}
            reloadKey={reloadKey}
            embedded
            lightweight={lightweight}
            auditRecords={auditRecords}
            diffOverride={diffOverride}
            preparedDiff={preparedDiff}
            onClearAuditRecord={onClearAuditRecord}
            onContentReady={() => {
              if (reusableContent) {
                viewerReadyRef.current = true;
                setViewerReady(true);
                commitContentReady();
                return;
              }
              if (!viewerReadyRef.current) {
                viewerReadyRef.current = true;
                setViewerReady(true);
              }
            }}
            onInsertDiffReference={onInsertDiffReference}
            onHunkGitAction={onHunkGitAction}
            onReferenceCopied={onReferenceCopied}
            insertedReferenceKey={insertedReferenceKey}
            copiedReferenceKey={copiedReferenceKey}
          />
        ) : (
          <div className="flex h-full min-h-16 items-center justify-center bg-surface px-3 py-4 text-center text-xs text-muted-foreground">
            {file.path}
          </div>
        )}
        {visible && viewerReady && !contentReady && (
          <div data-diff-measuring-overlay className="absolute inset-0 z-20 bg-surface" />
        )}
      </div>
    </div>
  );
}
