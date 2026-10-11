import type RFB from '@novnc/novnc';
import type { RdpSession } from './rdpSession';

export interface ZoomAnchor { x: number; y: number }
export interface ComputerZoom {
  get(): number;
  set(value: number, anchor?: ZoomAnchor): void;
  pan(x: number, y: number): void;
  dispose(): void;
}
export const constrainComputerZoom = (value: number) => Math.max(1, Math.min(8, Number.isFinite(value) ? value : 1));
interface VncZoomInternals {
  _screen: HTMLElement;
  _canvas: HTMLCanvasElement;
  _display: { scale: number };
  _updateScale(): void;
}

/** Change the renderer's own scale, so remote pointer coordinates stay correct.
 * CSS transforms on an ancestor would break noVNC's coordinate conversion. */
export function attachComputerZoom(session: RFB | RdpSession, changed: (value: number) => void): ComputerZoom {
  let zoom = 1;
  const rdp = 'viewportZoom' in session;
  const vnc = session as unknown as VncZoomInternals;
  const surface = () => rdp ? session.pointerTarget.surface() : vnc._canvas;
  const scroller = () => rdp ? session.viewportScroller : vnc._screen;
  const originalScale = rdp ? undefined : vnc._updateScale;
  if (originalScale) vnc._updateScale = function () {
    originalScale.call(vnc); vnc._display.scale *= zoom;
  };
  return {
    get: () => zoom,
    set(value, anchor) {
      const next = constrainComputerZoom(value);
      const element = surface(), scroll = scroller(), before = element.getBoundingClientRect();
      const bounds = scroll.getBoundingClientRect();
      const focus = anchor ?? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      const relative = { x: (focus.x - before.left) / (before.width || 1), y: (focus.y - before.top) / (before.height || 1) };
      zoom = next;
      if (rdp) session.viewportZoom = zoom;
      else vnc._updateScale();
      const after = element.getBoundingClientRect();
      scroll.scrollLeft += after.left + relative.x * after.width - focus.x;
      scroll.scrollTop += after.top + relative.y * after.height - focus.y;
      if (zoom === 1) { scroll.scrollLeft = 0; scroll.scrollTop = 0; }
      changed(zoom);
    },
    pan(x, y) { const scroll = scroller(); scroll.scrollLeft -= x; scroll.scrollTop -= y; },
    dispose() { if (originalScale) vnc._updateScale = originalScale; },
  };
}
