import { useEffect, useState, useRef } from 'react';
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
  eager?: boolean;
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
  onVisibleChange?: (visible: boolean) => void;
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
  eager = false,
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
  onVisibleChange,
  onClearAuditRecord,
  onContentReady,
}: DiffStreamItemProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(eager);
  const absolutePath = file.absolutePath || (repoRoot ? `${repoRoot}/${file.path}` : file.path);

  useEffect(() => {
    if (eager) {
      setVisible(true);
      return;
    }
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const root = findScrollableDiffRoot(node);
    const observer = new IntersectionObserver((entries) => {
      const isVisible = entries.some((entry) => entry.isIntersecting);
      setVisible((current) => current || isVisible);
      onVisibleChange?.(isVisible);
    }, {
      root,
      // Preload far beyond the viewport in BOTH directions so a neighbouring
      // file's diff is already loaded (final height) well before it reaches the
      // viewport. Items stay mounted once loaded, so each file grows exactly
      // once — on first approach. A large lead means that growth happens far
      // off-screen, never near the viewport, which is the only way to avoid the
      // reading position shifting on iOS (where momentum scrolling disables both
      // native and manual scroll anchoring). Large diffs need the extra lead.
      rootMargin: '3000px 0px 3000px 0px',
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [eager, onVisibleChange]);

  return (
    <div
      ref={containerRef}
      data-diff-stream-item={selectionPath}
      data-diff-selection-path={selectionPath}
      data-diff-file-path={file.path}
      data-diff-absolute-path={absolutePath}
      className={`scroll-mt-3 border-b border-border/15 last:border-b-0 ${selected ? 'bg-surface-elevated/35' : ''}`}
    >
      <div className={`sticky top-0 z-menu-panel flex min-w-0 items-center gap-2 border-b border-border/15 px-3 py-2 backdrop-blur ${
        selected ? 'bg-surface-elevated/95' : 'bg-surface/95'
      }`}>
        {renderBadge(file.status)}
        <div className="min-w-0 flex-1" title={absolutePath}>
          <div className="truncate text-xs font-semibold text-foreground">{displayName}</div>
          {displayDir && <div className="truncate text-[10px] text-muted-foreground">{displayDir}</div>}
        </div>
      </div>
      {visible ? (
        <DiffViewer
          active={activePane && visible}
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
          onContentReady={() => onContentReady?.(selectionPath)}
          onInsertDiffReference={onInsertDiffReference}
          onReferenceCopied={onReferenceCopied}
          insertedReferenceKey={insertedReferenceKey}
          copiedReferenceKey={copiedReferenceKey}
        />
      ) : (
        <div className="flex h-full items-center justify-center bg-surface px-3 py-6 text-center text-xs text-muted-foreground">
          {file.path}
        </div>
      )}
    </div>
  );
}

function findScrollableDiffRoot(node: HTMLElement): HTMLElement | null {
  let current = node.parentElement;
  while (current) {
    // Match the scroller by class alone. Do NOT also require it to be
    // *currently* scrollable: at mount the stream may not yet overflow (content
    // still loading), and if we returned null then the IntersectionObserver
    // would fall back to the viewport root and never fire for this item.
    if (current.classList.contains('termdock-diff-stream-scroller')) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}
