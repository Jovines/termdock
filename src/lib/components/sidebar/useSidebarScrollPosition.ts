import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushCacheThrottled, readCache, writeCacheThrottled } from '../../utils/localStorageCache';

export const SIDEBAR_SCROLL_POSITION_KEY = 'termdock-left-sidebar-scroll-position';

export function useSidebarScrollPosition(
  listRef: RefObject<HTMLElement>,
  visible: boolean,
  hasSessions: boolean,
): void {
  const [savedTop] = useState(() => readCache(SIDEBAR_SCROLL_POSITION_KEY,
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0));
  const restoredList = useRef<HTMLElement | null>(null);

  // Run before active-row visibility checks. An empty loading list must not
  // clamp the saved position to zero or replace it before sessions arrive.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!visible || !hasSessions || !list || list.clientHeight === 0 || restoredList.current === list) return;
    if (savedTop !== null) list.scrollTop = savedTop;
    restoredList.current = list;
  });

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const save = () => {
      if (restoredList.current !== list || list.clientHeight === 0) return;
      writeCacheThrottled(SIDEBAR_SCROLL_POSITION_KEY, Math.max(0, list.scrollTop), 150);
    };
    const flush = () => { save(); flushCacheThrottled(SIDEBAR_SCROLL_POSITION_KEY); };
    const background = () => { if (document.hidden) flush(); };
    list.addEventListener('scroll', save, { passive: true });
    window.addEventListener('pagehide', flush);
    window.addEventListener('termdock:before-update', flush);
    document.addEventListener('visibilitychange', background);
    return () => {
      flush();
      list.removeEventListener('scroll', save);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('termdock:before-update', flush);
      document.removeEventListener('visibilitychange', background);
    };
  }, [listRef]);
}
