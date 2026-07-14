import type { PointerEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft as RiArrowLeft } from 'lucide-react';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';
import { flushCacheThrottled, readCache, writeCache, writeCacheThrottled } from '../../utils/localStorageCache';

const DESKTOP_LIST_WIDTH_STORAGE_KEY = 'termdock:diff-review:list-width:v1';
const DESKTOP_LIST_WIDTH_WRITE_MS = 120;
const DEFAULT_DESKTOP_LIST_WIDTH_PX = 320;
const MIN_DESKTOP_LIST_WIDTH_PX = 220;
const MAX_DESKTOP_LIST_WIDTH_PX = 560;

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
  detailOwnsScroll?: boolean;
}

function isStoredWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampDesktopListWidth(width: number, frameWidth: number): number {
  const maxByFrame = Math.max(MIN_DESKTOP_LIST_WIDTH_PX, frameWidth - 360);
  const max = Math.min(MAX_DESKTOP_LIST_WIDTH_PX, maxByFrame);
  return Math.min(max, Math.max(MIN_DESKTOP_LIST_WIDTH_PX, width));
}

function readDesktopListWidth(): number {
  return readCache(DESKTOP_LIST_WIDTH_STORAGE_KEY, isStoredWidth) ?? DEFAULT_DESKTOP_LIST_WIDTH_PX;
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
  detailOwnsScroll = false,
}: DiffReviewFrameProps) {
  const swiperRef = useRef<SwiperInstance | null>(null);
  const desktopFrameRef = useRef<HTMLDivElement | null>(null);
  const desktopResizeRef = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null);
  const [desktopListWidthPx, setDesktopListWidthPx] = useState(readDesktopListWidth);
  const syncMobileSwiperTouch = useCallback((instance: SwiperInstance) => {
    instance.allowTouchMove = true;
  }, []);

  useEffect(() => {
    if (mobile || desktopLayout !== 'split') return;
    const frame = desktopFrameRef.current;
    if (!frame) return;
    setDesktopListWidthPx((width) => clampDesktopListWidth(width, frame.clientWidth));
  }, [desktopLayout, mobile]);

  const startDesktopListResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (mobile || desktopLayout !== 'split') return;
    event.preventDefault();
    desktopResizeRef.current = {
      startX: event.clientX,
      startWidth: desktopListWidthPx,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [desktopLayout, desktopListWidthPx, mobile]);

  const handleDesktopListResizeMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const resize = desktopResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const frameWidth = desktopFrameRef.current?.clientWidth ?? window.innerWidth;
    const nextWidth = clampDesktopListWidth(resize.startWidth + event.clientX - resize.startX, frameWidth);
    setDesktopListWidthPx(nextWidth);
    writeCacheThrottled(DESKTOP_LIST_WIDTH_STORAGE_KEY, nextWidth, DESKTOP_LIST_WIDTH_WRITE_MS);
  }, []);

  const stopDesktopListResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const resize = desktopResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    desktopResizeRef.current = null;
    flushCacheThrottled(DESKTOP_LIST_WIDTH_STORAGE_KEY);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released if the browser cancelled drag.
    }
  }, []);

  if (mobile) {
    const slideToDetail = () => {
      const swiper = swiperRef.current;
      if (!swiper) return;
      syncMobileSwiperTouch(swiper);
      swiper.slideTo(1);
    };
    const slideToList = () => {
      const swiper = swiperRef.current;
      if (!swiper) return;
      syncMobileSwiperTouch(swiper);
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
        noSwiping
        noSwipingClass="swiper-no-swiping"
        noSwipingSelector=".swiper-no-swiping"
        allowTouchMove
        touchStartPreventDefault={false}
        onSwiper={(instance) => {
          swiperRef.current = instance;
          syncMobileSwiperTouch(instance);
          if (externalSwiperRef) externalSwiperRef.current = instance;
        }}
        onSlideChange={(instance) => {
          const nextIndex = instance.activeIndex;
          syncMobileSwiperTouch(instance);
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
              className={detailOwnsScroll
                ? 'min-h-0 flex-1 overflow-hidden'
                : 'termdock-diff-stream-scroller min-h-0 flex-1 overflow-y-auto overscroll-contain'}
              data-sidebar-gesture-ignore
              onScroll={detailOwnsScroll ? undefined : (event) => onDetailScroll?.(event.currentTarget)}
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
    if (detailOwnsScroll) {
      return (
        <div className="termdock-native-select min-h-0 flex-1 overflow-hidden px-2 pb-[calc(env(safe-area-inset-bottom)+4.5rem)]">
          {desktopListHeader && (
            <div className="sticky top-0 z-10 border-b border-border/15 bg-surface px-2 py-2">
              {desktopListHeader}
            </div>
          )}
          {desktopList}
          <div className="mt-3 h-[calc(100%-3rem)] min-h-0 overflow-hidden rounded-xl border border-border/15 bg-surface">
            {detail}
          </div>
        </div>
      );
    }
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
    <div ref={desktopFrameRef} className="flex h-full min-h-0 overflow-hidden">
      {desktopSidePanel}
      <div
        className={desktopListClassName ?? "shrink-0 overflow-y-auto overscroll-contain border-r border-border/15 bg-surface"}
        style={{ width: desktopListWidthPx }}
      >
        {desktopListHeader && (
          <div className="sticky top-0 z-10 border-b border-border/15 bg-surface px-2 py-2">
            {desktopListHeader}
          </div>
        )}
        {desktopList}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize diff navigation"
        title="Resize diff navigation"
        className="group relative z-10 w-2 shrink-0 cursor-col-resize touch-none border-r border-border/15 bg-surface"
        onPointerDown={startDesktopListResize}
        onPointerMove={handleDesktopListResizeMove}
        onPointerUp={stopDesktopListResize}
        onPointerCancel={stopDesktopListResize}
        onDoubleClick={() => {
          setDesktopListWidthPx(DEFAULT_DESKTOP_LIST_WIDTH_PX);
          writeCache(DESKTOP_LIST_WIDTH_STORAGE_KEY, DEFAULT_DESKTOP_LIST_WIDTH_PX);
        }}
      >
        <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/30 transition group-hover:bg-primary/60" />
      </div>
      <div
        className={detailOwnsScroll
          ? 'min-w-0 flex-1 overflow-hidden'
          : 'termdock-diff-stream-scroller min-w-0 flex-1 overflow-y-auto overscroll-contain'}
        onScroll={detailOwnsScroll ? undefined : (event) => onDetailScroll?.(event.currentTarget)}
      >
        {detail}
      </div>
    </div>
  );
}
