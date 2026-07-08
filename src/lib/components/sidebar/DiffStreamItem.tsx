import { useEffect, useState, useRef } from 'react';
import type { ChangeAuditRecord, GitChangedFile } from '../../terminal/api';
import { DiffViewer } from './DiffViewer';

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
  wrap: boolean;
  showScrollHint: boolean;
  reloadKey?: number;
  auditRecords: ChangeAuditRecord[];
  diffOverride?: string | null;
  renderBadge: (status: string) => React.ReactNode;
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  onVisibleChange?: (visible: boolean) => void;
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
  wrap,
  showScrollHint,
  reloadKey = 0,
  auditRecords,
  diffOverride,
  renderBadge,
  onInsertDiffReference,
  onReferenceCopied,
  insertedReferenceKey,
  copiedReferenceKey,
  onVisibleChange,
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
    const observer = new IntersectionObserver((entries) => {
      const isVisible = entries.some((entry) => entry.isIntersecting);
      setVisible((current) => current || isVisible);
      onVisibleChange?.(isVisible);
    }, { root: null, rootMargin: '720px 0px' });
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
          changedFile={file as GitChangedFile}
          wrap={wrap}
          showScrollHint={showScrollHint}
          reloadKey={reloadKey}
          embedded
          auditRecords={auditRecords}
          diffOverride={diffOverride}
          onInsertDiffReference={onInsertDiffReference}
          onReferenceCopied={onReferenceCopied}
          insertedReferenceKey={insertedReferenceKey}
          copiedReferenceKey={copiedReferenceKey}
        />
      ) : (
        <div className="bg-surface px-3 py-6 text-center text-xs text-muted-foreground">
          {file.path}
        </div>
      )}
    </div>
  );
}
