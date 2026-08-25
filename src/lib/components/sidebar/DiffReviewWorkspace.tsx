import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { List, ListTree, Sparkles, X } from 'lucide-react';
import type { Swiper as SwiperInstance } from 'swiper';
import {
  DiffFileNavigator,
  type DiffFileNavigatorMode,
  type DiffNavigatorFile,
  type DiffNavigatorGroup,
} from './DiffFileNavigator';
import { DiffReviewFrame } from './DiffReviewFrame';

export type DiffReviewMode = DiffFileNavigatorMode | 'ai';

export interface DiffReviewAiControls {
  slideToDetail: () => void;
  fullscreen: boolean;
  toggleFullscreen: () => void;
}

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
  renderDirectoryTrailing?: (directoryPath: string, group: DiffNavigatorGroup) => ReactNode;
  renderSubtitle?: (file: DiffNavigatorFile) => ReactNode;
  detail: ReactNode;
  mobile: boolean;
  backLabel: string;
  compact?: boolean;
  emptyContent?: ReactNode;
  listPrefix?: ReactNode;
  aiContent?: ReactNode | ((controls: DiffReviewAiControls) => ReactNode);
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
  renderDirectoryTrailing,
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
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  const modeToggle = <DiffReviewModeToggle mode={mode} onModeChange={onModeChange} showAi={Boolean(aiContent)} />;
  const fileNavigatorMode: DiffFileNavigatorMode = mode === 'tree' ? 'tree' : 'list';
  const listHeader = renderListHeader ? renderListHeader(modeToggle) : <div className="flex justify-end">{modeToggle}</div>;
  const hasFiles = groups.some((group) => group.files.length > 0);

  const workspace = (
    <DiffReviewFrame
      mobile={fullscreen ? false : mobile}
      backLabel={backLabel}
      externalSwiperRef={externalSwiperRef}
      onMobileSlideChange={onMobileSlideChange}
      desktopLayout={fullscreen ? 'split' : desktopLayout}
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
            typeof aiContent === 'function' ? aiContent({
              slideToDetail,
              fullscreen,
              toggleFullscreen: () => setFullscreen((current) => !current),
            }) : aiContent ?? emptyContent
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
              renderDirectoryTrailing={renderDirectoryTrailing}
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
        >
          {detail}
        </div>
      )}
    />
  );

  if (!fullscreen || typeof document === 'undefined') return workspace;
  return createPortal(
    <div className="fixed inset-0 z-modal-panel flex min-h-0 flex-col bg-surface text-foreground">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/15 bg-[var(--chrome-bg)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles size={15} className="shrink-0 text-primary" />
          <span className="truncate text-[12px] font-semibold">DAG Review</span>
          <span className="hidden text-[10px] text-muted-foreground sm:inline">Select a step to inspect its exact change</span>
        </div>
        <button
          type="button"
          onClick={() => setFullscreen(false)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground active:scale-95"
          title="Exit full-screen DAG review (Esc)"
          aria-label="Exit full-screen DAG review"
        >
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1">{workspace}</div>
    </div>,
    document.body,
  );
}
