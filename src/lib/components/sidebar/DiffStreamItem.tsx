import { useCallback, useEffect, useLayoutEffect, useState, useRef } from 'react';
import type { ChangeAuditRecord, GitChangedFile, GitDiffOptions } from '../../terminal/api';
import { DiffViewer, type DiffInlineMode, type DiffViewerPreparedDiff, type DiffViewType } from './DiffViewer';

const DIFF_HEIGHT_SETTLE_MS = 120;

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
  onReferenceCopied,
  insertedReferenceKey,
  copiedReferenceKey,
  onClearAuditRecord,
  onContentReady,
  onHeightChange,
}: DiffStreamItemProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [measuredBodyHeight, setMeasuredBodyHeight] = useState<number | null>(null);
  const measuredBodyHeightRef = useRef(64);
  const measuredItemHeightRef = useRef(estimatedHeight ?? 104);
  const viewerReadyRef = useRef(false);
  const settledNotifiedRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const [contentReady, setContentReady] = useState(false);
  const absolutePath = file.absolutePath || (repoRoot ? `${repoRoot}/${file.path}` : file.path);

  const scheduleSettledNotification = useCallback(() => {
    if (!viewerReadyRef.current || settledNotifiedRef.current) return;
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      if (!viewerReadyRef.current || settledNotifiedRef.current) return;
      settledNotifiedRef.current = true;
      onContentReady?.(selectionPath);
    }, DIFF_HEIGHT_SETTLE_MS);
  }, [onContentReady, selectionPath]);

  useEffect(() => {
    viewerReadyRef.current = false;
    settledNotifiedRef.current = false;
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setContentReady(false);
    return () => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, [visible, reloadKey]);

  useLayoutEffect(() => {
    if (!visible) return;
    const body = bodyRef.current;
    if (!body) return;

    const recordHeight = () => {
      const nextHeight = Math.ceil(body.getBoundingClientRect().height);
      const previousHeight = measuredBodyHeightRef.current;
      if (nextHeight > 0 && previousHeight !== nextHeight) {
        measuredBodyHeightRef.current = nextHeight;
        setMeasuredBodyHeight(nextHeight);
        scheduleSettledNotification();
      }
      const item = containerRef.current;
      if (!item) return;
      const nextItemHeight = Math.ceil(item.getBoundingClientRect().height);
      const previousItemHeight = measuredItemHeightRef.current;
      if (nextItemHeight <= 0 || previousItemHeight === nextItemHeight) return;
      measuredItemHeightRef.current = nextItemHeight;
      onHeightChange?.(selectionPath, previousItemHeight, nextItemHeight);
    };
    recordHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(recordHeight);
    observer.observe(body);
    return () => observer.disconnect();
  }, [onHeightChange, scheduleSettledNotification, selectionPath, visible]);

  return (
    <div
      ref={containerRef}
      data-diff-stream-item={selectionPath}
      data-diff-selection-path={selectionPath}
      data-diff-file-path={file.path}
      data-diff-absolute-path={absolutePath}
      className={`scroll-mt-3 border-b border-border/15 last:border-b-0 ${
        visible ? '' : 'overflow-hidden'
      } ${selected ? 'bg-surface-elevated/35' : ''}`}
      style={visible
        ? { minHeight: contentReady ? undefined : estimatedHeight }
        : { height: estimatedHeight ?? 104 }}
    >
      <div className={`sticky top-0 z-10 flex min-w-0 items-center gap-2 border-b border-border/15 px-3 py-2 backdrop-blur ${
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
          ? { minHeight: contentReady ? 64 : measuredBodyHeight ?? 64, contentVisibility: 'auto' }
          : { height: measuredBodyHeight ?? 64 }}
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
              if (!viewerReadyRef.current) {
                viewerReadyRef.current = true;
                settledNotifiedRef.current = false;
              }
              setContentReady(true);
              scheduleSettledNotification();
            }}
            onInsertDiffReference={onInsertDiffReference}
            onReferenceCopied={onReferenceCopied}
            insertedReferenceKey={insertedReferenceKey}
            copiedReferenceKey={copiedReferenceKey}
          />
        ) : (
          <div className="flex h-full min-h-16 items-center justify-center bg-surface px-3 py-4 text-center text-xs text-muted-foreground">
            {file.path}
          </div>
        )}
      </div>
    </div>
  );
}
