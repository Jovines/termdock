import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import type { ChangeAuditRecord, GitChangedFile, GitDiffOptions } from '../../terminal/api';
import { DiffViewer, type DiffInlineMode, type DiffViewerPreparedDiff, type DiffViewType } from './DiffViewer';

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
}: DiffStreamItemProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [measuredBodyHeight, setMeasuredBodyHeight] = useState<number | null>(null);
  const [contentReady, setContentReady] = useState(false);
  const absolutePath = file.absolutePath || (repoRoot ? `${repoRoot}/${file.path}` : file.path);

  useEffect(() => {
    setContentReady(false);
  }, [visible, reloadKey]);

  useLayoutEffect(() => {
    if (!visible) return;
    const body = bodyRef.current;
    if (!body) return;

    const recordHeight = () => {
      const nextHeight = Math.ceil(body.getBoundingClientRect().height);
      if (nextHeight > 0) {
        setMeasuredBodyHeight((current) => current === nextHeight ? current : nextHeight);
      }
    };
    recordHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(recordHeight);
    observer.observe(body);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div
      ref={containerRef}
      data-diff-stream-item={selectionPath}
      data-diff-selection-path={selectionPath}
      data-diff-file-path={file.path}
      data-diff-absolute-path={absolutePath}
      className={`scroll-mt-3 border-b border-border/15 last:border-b-0 ${selected ? 'bg-surface-elevated/35' : ''}`}
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
              setContentReady(true);
              onContentReady?.(selectionPath);
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
