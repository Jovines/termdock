import type { ReactNode } from 'react';
import type { Swiper as SwiperInstance } from 'swiper';
import type { ChangeAuditRecord } from '../../terminal/api';
import type { DiffNavigatorFile, DiffNavigatorGroup, DiffFileNavigatorMode } from './DiffFileNavigator';
import { DiffReviewWorkspace } from './DiffReviewWorkspace';
import { DiffStreamItem, type DiffStreamFile } from './DiffStreamItem';

export interface ChangeDiffReviewStreamItem {
  key: string;
  file: DiffStreamFile;
  repoRoot: string | null;
  selectionPath: string;
  displayName: string;
  displayDir?: string | null;
  selected: boolean;
  eager?: boolean;
  diffOverride?: string | null;
  auditRecords: ChangeAuditRecord[];
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
}

export interface ChangeDiffReviewProps {
  groups: DiffNavigatorGroup[];
  mode: DiffFileNavigatorMode;
  onModeChange: (mode: DiffFileNavigatorMode) => void;
  selectedKey?: string | null;
  collapsedDirectoryKeys: Set<string>;
  onToggleDirectory: (key: string) => void;
  onSelectFile: (file: DiffNavigatorFile) => void;
  renderLeading: (file: DiffNavigatorFile) => ReactNode;
  renderTrailing?: (file: DiffNavigatorFile) => ReactNode;
  renderSubtitle?: (file: DiffNavigatorFile) => ReactNode;
  streamItems: ChangeDiffReviewStreamItem[];
  activePane: boolean;
  wrap: boolean;
  showScrollHint: boolean;
  reloadKey?: number;
  renderStreamBadge: (status: string, item: ChangeDiffReviewStreamItem) => ReactNode;
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  mobile: boolean;
  backLabel: string;
  compact?: boolean;
  emptyContent?: ReactNode;
  listPrefix?: ReactNode;
  listContainerClassName?: string;
  detailContainerClassName?: string;
  renderListHeader?: (modeToggle: ReactNode) => ReactNode;
  renderMobileDetailHeader?: ReactNode | ((controls: { slideToList: () => void; slideToDetail: () => void }) => ReactNode);
  externalSwiperRef?: { current: SwiperInstance | null };
  onMobileSlideChange?: (index: number) => void;
  slideToDetailOnMobile?: boolean;
  desktopLayout?: 'split' | 'stacked';
  onDetailScroll?: (container: HTMLDivElement) => void;
  desktopSidePanel?: ReactNode;
  desktopListClassName?: string;
}

export function ChangeDiffReview(props: ChangeDiffReviewProps) {
  const {
    streamItems,
    activePane,
    wrap,
    showScrollHint,
    reloadKey = 0,
    renderStreamBadge,
    onInsertDiffReference,
    onReferenceCopied,
    insertedReferenceKey,
    copiedReferenceKey,
    ...workspaceProps
  } = props;
  const detail = (
    <div className="termdock-diff-stream divide-y divide-border/15 bg-surface">
      {streamItems.map((item) => (
        <DiffStreamItem
          key={item.key}
          file={item.file}
          repoRoot={item.repoRoot}
          selectionPath={item.selectionPath}
          displayName={item.displayName}
          displayDir={item.displayDir}
          selected={item.selected}
          activePane={activePane}
          eager={item.eager}
          wrap={wrap}
          showScrollHint={showScrollHint}
          reloadKey={reloadKey}
          auditRecords={item.auditRecords}
          diffOverride={item.diffOverride}
          renderBadge={(status) => renderStreamBadge(status, item)}
          onInsertDiffReference={item.onInsertDiffReference ?? onInsertDiffReference}
          onReferenceCopied={onReferenceCopied}
          insertedReferenceKey={insertedReferenceKey}
          copiedReferenceKey={copiedReferenceKey}
        />
      ))}
    </div>
  );
  return <DiffReviewWorkspace {...workspaceProps} detail={detail} />;
}
