import type { ReactNode } from 'react';
import { List, ListTree, Sparkles } from 'lucide-react';
import type { Swiper as SwiperInstance } from 'swiper';
import {
  DiffFileNavigator,
  type DiffFileNavigatorMode,
  type DiffNavigatorFile,
  type DiffNavigatorGroup,
} from './DiffFileNavigator';
import { DiffReviewFrame } from './DiffReviewFrame';

export type DiffReviewMode = DiffFileNavigatorMode | 'ai';

interface DiffReviewWorkspaceProps {
  groups: DiffNavigatorGroup[];
  mode: DiffReviewMode;
  onModeChange: (mode: DiffReviewMode) => void;
  selectedKey?: string | null;
  collapsedDirectoryKeys: Set<string>;
  onToggleDirectory: (key: string) => void;
  onSelectFile: (file: DiffNavigatorFile) => void;
  renderLeading: (file: DiffNavigatorFile) => ReactNode;
  renderTrailing?: (file: DiffNavigatorFile) => ReactNode;
  renderSubtitle?: (file: DiffNavigatorFile) => ReactNode;
  detail: ReactNode;
  mobile: boolean;
  backLabel: string;
  compact?: boolean;
  emptyContent?: ReactNode;
  listPrefix?: ReactNode;
  aiContent?: ReactNode | ((controls: { slideToDetail: () => void }) => ReactNode);
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
  detailOwnsScroll?: boolean;
}

export function DiffReviewModeToggle({
  mode,
  onModeChange,
  showAi = false,
}: {
  mode: DiffReviewMode;
  onModeChange: (mode: DiffReviewMode) => void;
  showAi?: boolean;
}) {
  return (
    <div className="inline-flex h-7 shrink-0 overflow-hidden rounded-full bg-surface-2 p-0.5">
      <button
        type="button"
        onClick={() => onModeChange('list')}
        aria-pressed={mode === 'list'}
        className={`inline-flex h-6 w-7 items-center justify-center rounded-full transition active:scale-95 ${
          mode === 'list'
            ? 'bg-surface-elevated text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <List size={13} />
      </button>
      <button
        type="button"
        onClick={() => onModeChange('tree')}
        aria-pressed={mode === 'tree'}
        className={`inline-flex h-6 w-7 items-center justify-center rounded-full transition active:scale-95 ${
          mode === 'tree'
            ? 'bg-surface-elevated text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <ListTree size={13} />
      </button>
      {showAi && (
        <button
          type="button"
          onClick={() => onModeChange('ai')}
          aria-pressed={mode === 'ai'}
          className={`inline-flex h-6 w-7 items-center justify-center rounded-full transition active:scale-95 ${
            mode === 'ai'
              ? 'bg-surface-elevated text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Sparkles size={13} />
        </button>
      )}
    </div>
  );
}

export function DiffReviewWorkspace({
  groups,
  mode,
  onModeChange,
  selectedKey,
  collapsedDirectoryKeys,
  onToggleDirectory,
  onSelectFile,
  renderLeading,
  renderTrailing,
  renderSubtitle,
  detail,
  mobile,
  backLabel,
  compact = false,
  emptyContent,
  listPrefix,
  aiContent,
  listContainerClassName = 'px-2 py-2',
  detailContainerClassName = 'termdock-native-select termdock-diff-stream-scroller min-h-0',
  renderListHeader,
  renderMobileDetailHeader,
  externalSwiperRef,
  onMobileSlideChange,
  slideToDetailOnMobile = true,
  desktopLayout = 'split',
  onDetailScroll,
  desktopSidePanel,
  desktopListClassName,
  detailOwnsScroll,
}: DiffReviewWorkspaceProps) {
  const modeToggle = <DiffReviewModeToggle mode={mode} onModeChange={onModeChange} showAi={Boolean(aiContent)} />;
  const fileNavigatorMode: DiffFileNavigatorMode = mode === 'tree' ? 'tree' : 'list';
  const listHeader = renderListHeader ? renderListHeader(modeToggle) : <div className="flex justify-end">{modeToggle}</div>;
  const hasFiles = groups.some((group) => group.files.length > 0);

  return (
    <DiffReviewFrame
      mobile={mobile}
      backLabel={backLabel}
      externalSwiperRef={externalSwiperRef}
      onMobileSlideChange={onMobileSlideChange}
      desktopLayout={desktopLayout}
      onDetailScroll={onDetailScroll}
      desktopSidePanel={desktopSidePanel}
      desktopListClassName={desktopListClassName}
      detailOwnsScroll={detailOwnsScroll}
      mobileListHeader={mobile ? listHeader : undefined}
      desktopListHeader={!mobile ? listHeader : undefined}
      mobileDetailHeader={renderMobileDetailHeader}
      list={({ slideToDetail }) => (
        <div className={listContainerClassName}>
          {mode === 'ai' ? (
            typeof aiContent === 'function' ? aiContent({ slideToDetail }) : aiContent ?? emptyContent
          ) : (
            <>
              {listPrefix}
              {hasFiles ? (
            <DiffFileNavigator
              groups={groups}
              selectedKey={selectedKey}
              mode={fileNavigatorMode}
              mobile={mobile}
              compact={compact}
              collapsedDirectoryKeys={collapsedDirectoryKeys}
              onToggleDirectory={onToggleDirectory}
              onSelectFile={(file) => {
                onSelectFile(file);
                if (mobile && slideToDetailOnMobile) window.requestAnimationFrame(slideToDetail);
              }}
              renderLeading={renderLeading}
              renderTrailing={renderTrailing}
              renderSubtitle={renderSubtitle}
            />
              ) : emptyContent}
            </>
          )}
        </div>
      )}
      detail={(
        <div
          className={detailOwnsScroll ? 'h-full min-h-0' : detailContainerClassName}
          data-sidebar-gesture-ignore
        >
          {detail}
        </div>
      )}
    />
  );
}
