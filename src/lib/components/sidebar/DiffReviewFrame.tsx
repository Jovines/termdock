import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';
import { ArrowLeft as RiArrowLeft } from 'lucide-react';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';

interface DiffReviewFrameProps {
  list: ReactNode | ((controls: { slideToDetail: () => void }) => ReactNode);
  detail: ReactNode;
  mobile: boolean;
  mobileListHeader?: ReactNode;
  mobileDetailHeader?: ReactNode | ((controls: { slideToList: () => void; slideToDetail: () => void }) => ReactNode);
  desktopListHeader?: ReactNode;
  backLabel: string;
  onMobileSlideChange?: (index: number) => void;
  externalSwiperRef?: { current: SwiperInstance | null };
  desktopLayout?: 'split' | 'stacked';
  onDetailScroll?: (container: HTMLDivElement) => void;
  desktopSidePanel?: ReactNode;
  desktopListClassName?: string;
  mobileDetailOwnsScroll?: boolean;
}

export function DiffReviewFrame({
  list,
  detail,
  mobile,
  mobileListHeader,
  mobileDetailHeader,
  desktopListHeader,
  backLabel,
  onMobileSlideChange,
  externalSwiperRef,
  desktopLayout = 'split',
  onDetailScroll,
  desktopSidePanel,
  desktopListClassName,
  mobileDetailOwnsScroll = false,
}: DiffReviewFrameProps) {
  const swiperRef = useRef<SwiperInstance | null>(null);
  const [mobileSlideIndex, setMobileSlideIndex] = useState(0);
  const syncMobileSwiperTouch = useCallback((instance: SwiperInstance, index: number) => {
    instance.allowTouchMove = index === 0;
  }, []);

  if (mobile) {
    const slideToDetail = () => {
      const swiper = swiperRef.current;
      if (!swiper) return;
      syncMobileSwiperTouch(swiper, 1);
      swiper.slideTo(1);
    };
    const slideToList = () => {
      const swiper = swiperRef.current;
      if (!swiper) return;
      syncMobileSwiperTouch(swiper, 0);
      swiper.slideTo(0);
    };
    const listContent = typeof list === 'function' ? list({ slideToDetail }) : list;
    const detailHeader = typeof mobileDetailHeader === 'function'
      ? mobileDetailHeader({ slideToList, slideToDetail })
      : mobileDetailHeader;
    return (
      <Swiper
        className="h-full min-h-0 w-full"
        slidesPerView={1}
        resistanceRatio={0.45}
        allowTouchMove={mobileSlideIndex === 0}
        touchStartPreventDefault={false}
        onSwiper={(instance) => {
          swiperRef.current = instance;
          syncMobileSwiperTouch(instance, mobileSlideIndex);
          if (externalSwiperRef) externalSwiperRef.current = instance;
        }}
        onSlideChange={(instance) => {
          const nextIndex = instance.activeIndex;
          setMobileSlideIndex(nextIndex);
          syncMobileSwiperTouch(instance, nextIndex);
          onMobileSlideChange?.(nextIndex);
        }}
      >
        <SwiperSlide className="h-full min-h-0">
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {mobileListHeader && (
              <div className="shrink-0 border-b border-border/15 px-3 py-2">
                {mobileListHeader}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {listContent}
            </div>
          </div>
        </SwiperSlide>
        <SwiperSlide className="h-full min-h-0" data-sidebar-gesture-ignore>
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface" data-sidebar-gesture-ignore>
            <div className="shrink-0 border-b border-border/15 px-3 py-2">
              {detailHeader ?? (
                <button
                  type="button"
                  onClick={slideToList}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-xs font-semibold text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                >
                  <RiArrowLeft size={14} />
                  {backLabel}
                </button>
              )}
            </div>
            <div
              className={mobileDetailOwnsScroll
                ? 'min-h-0 flex-1 overflow-hidden'
                : 'termdock-diff-stream-scroller min-h-0 flex-1 overflow-y-auto overscroll-contain'}
              data-sidebar-gesture-ignore
              onScroll={mobileDetailOwnsScroll ? undefined : (event) => onDetailScroll?.(event.currentTarget)}
            >
              {detail}
            </div>
          </div>
        </SwiperSlide>
      </Swiper>
    );
  }

  const desktopList = typeof list === 'function' ? list({ slideToDetail: () => undefined }) : list;

  if (desktopLayout === 'stacked') {
    return (
      <div
        className="termdock-native-select termdock-diff-stream-scroller min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[calc(env(safe-area-inset-bottom)+4.5rem)]"
        onScroll={(event) => onDetailScroll?.(event.currentTarget)}
      >
        {desktopListHeader && (
          <div className="sticky top-0 z-10 border-b border-border/15 bg-surface px-2 py-2">
            {desktopListHeader}
          </div>
        )}
        {desktopList}
        <div className="mt-3 overflow-hidden rounded-xl border border-border/15 bg-surface">
          {detail}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {desktopSidePanel}
      <div className={desktopListClassName ?? "w-[240px] min-w-[180px] shrink-0 overflow-y-auto overscroll-contain border-r border-border/15 bg-surface"}>
        {desktopListHeader && (
          <div className="sticky top-0 z-10 border-b border-border/15 bg-surface px-2 py-2">
            {desktopListHeader}
          </div>
        )}
        {desktopList}
      </div>
      <div
        className="termdock-diff-stream-scroller min-w-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => onDetailScroll?.(event.currentTarget)}
      >
        {detail}
      </div>
    </div>
  );
}
