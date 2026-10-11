import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { clientLog } from '../utils/clientLog';
import { isIOSDevice } from '../utils/touchTerminalLayout';

/** iOS 27's native top blur uses fixed-edge sampling. Keep this sampling strip
 * outside the app/frame stacking contexts and independent of safe-area padding.
 * background-clip: text keeps the empty strip visually transparent. */
export function PwaStatusBarSurface() {
  const surface = useRef<HTMLDivElement>(null);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true;
  const enabled = window.parent === window && isIOSDevice() && standalone;

  useEffect(() => {
    if (!enabled) return;
    // Log once after the authenticated app has presented its first viewport.
    // This distinguishes a stale PWA bundle from a native sampling failure.
    const report = () => {
      const element = surface.current;
      if (!element) return;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      clientLog('info', 'PWA_STATUS_BAR_SURFACE', {
        revision: 'ipad-default-status-bar',
        statusBarStyle: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content'),
        entry: document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src'),
        parent: element.parentElement?.tagName,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
        background: style.backgroundColor, clip: style.backgroundClip, zIndex: style.zIndex,
        safeTop: getComputedStyle(document.documentElement).getPropertyValue('--safe-top-inset'),
        viewport: { width: window.innerWidth, height: window.innerHeight, offsetTop: window.visualViewport?.offsetTop },
        screen: { width: window.screen.width, height: window.screen.height },
      });
    };
    window.addEventListener('termdock:initial-viewport-presented', report, { once: true });
    return () => window.removeEventListener('termdock:initial-viewport-presented', report);
  }, [enabled]);

  if (!enabled) return null;

  return createPortal(
    <div
      ref={surface}
      data-pwa-status-bar-surface
      aria-hidden="true"
      className="pwa-status-bar-surface pointer-events-none fixed inset-x-0 top-0 z-popover app-chrome-bg"
    />,
    document.body,
  );
}
