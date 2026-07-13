import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import type { Swiper as SwiperInstance } from 'swiper';
import type { ChangeAuditRecord, GitDiffOptions } from '../../terminal/api';
import { flattenDiffNavigatorTree, type DiffNavigatorFile, type DiffNavigatorGroup, type DiffFileNavigatorMode } from './DiffFileNavigator';
import { DiffReviewWorkspace } from './DiffReviewWorkspace';
import { DiffStreamItem, type DiffStreamFile } from './DiffStreamItem';
import type { DiffInlineMode, DiffViewType } from './DiffViewer';

// --- ChangeBadge (shared) ---

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
  const detailScrollerRef = useRef<HTMLDivElement | null>(null);

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
          data-sidebar-gesture-ignore
          onScroll={(event) => handleDetailScroll(event.currentTarget)}
        >
          <div className="termdock-diff-stream divide-y divide-border/15 bg-surface">
            {allOrderedFiles.map((item, index) => (
              <div key={item.key}>
                {renderStreamItem(item, {
                  eager: index === selectedIndex,
                  lightweight: true,
                })}
              </div>
            ))}
          </div>
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

function toStreamFile(file: DiffReviewFile): DiffStreamFile {
  return {
    path: file.path,
    absolutePath: file.absolutePath,
    status: file.status,
  };
}
