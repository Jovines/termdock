import type RFB from '@novnc/novnc';

/** Coordinates and button masks are in remote desktop pixels / RFB order. */
export interface ComputerPointer {
  position?(): { x: number; y: number };
  observeCursor?(): Record<string, unknown>;
  size(): { width: number; height: number };
  surface(): HTMLElement;
  send(x: number, y: number, buttons: number): void;
}

// noVNC 1.7 has no public pointer API. Keep the version-specific access in
// this adapter, using its existing button/coordinate path and encrypted socket.
interface VncPointerInternals {
  _fbWidth: number;
  _fbHeight: number;
  _canvas: HTMLCanvasElement;
  _cursor?: { move(x: number, y: number): void; _hideCursor?(): void };
  _display: { scale: number; absX(value: number): number; absY(value: number): number };
  _mousePos: { x: number; y: number };
  _mouseButtonMask: number;
  _mouseMoveTimer: ReturnType<typeof setTimeout> | null;
  _mouseLastMoveTime: number;
  _sendMouse(x: number, y: number, buttons: number): void;
}
/** noVNC's touch cursor lives under body, outside the retained sidebar pane. */
export function hideVncCursor(session: RFB): void {
  (session as unknown as VncPointerInternals)._cursor?._hideCursor?.();
}
export function vncPointer(session: RFB): ComputerPointer {
  const vnc = session as unknown as VncPointerInternals;
  return {
    position: () => ({
      x: Number.isFinite(vnc._mousePos.x) ? vnc._display.absX(vnc._mousePos.x) : vnc._fbWidth / 2,
      y: Number.isFinite(vnc._mousePos.y) ? vnc._display.absY(vnc._mousePos.y) : vnc._fbHeight / 2,
    }),
    size: () => ({ width: vnc._fbWidth, height: vnc._fbHeight }),
    surface: () => vnc._canvas,
    send: (x, y, buttons) => {
      const scale = vnc._display.scale;
      const localX = (x - vnc._display.absX(0)) * scale;
      const localY = (y - vnc._display.absY(0)) * scale;
      vnc._mousePos = { x: localX, y: localY };
      // Touchpad input has one sending path. Avoid the normal button handler's
      // duplicate position and cancel any older native-mouse sample.
      if (vnc._mouseMoveTimer !== null) clearTimeout(vnc._mouseMoveTimer);
      vnc._mouseMoveTimer = null;
      vnc._mouseButtonMask = buttons;
      vnc._mouseLastMoveTime = Date.now();
      vnc._sendMouse(localX, localY, buttons);
      const bounds = vnc._canvas.getBoundingClientRect();
      vnc._cursor?.move(bounds.left + localX, bounds.top + localY);
    },
  };
}
