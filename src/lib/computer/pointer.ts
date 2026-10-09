import type RFB from '@novnc/novnc';

/** Coordinates and button masks are in remote desktop pixels / RFB order. */
export interface ComputerPointer {
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
  _display: { scale: number; absX(value: number): number; absY(value: number): number };
  _mousePos: { x: number; y: number };
  _mouseButtonMask: number;
  _mouseMoveTimer: ReturnType<typeof setTimeout> | null;
  _mouseLastMoveTime: number;
  _sendMouse(x: number, y: number, buttons: number): void;
}
export function vncPointer(session: RFB): ComputerPointer {
  const vnc = session as unknown as VncPointerInternals;
  return {
    size: () => ({ width: vnc._fbWidth, height: vnc._fbHeight }),
    surface: () => vnc._canvas,
    send: (x, y, buttons) => {
      const scale = vnc._display.scale;
      const localX = (x - vnc._display.absX(0)) * scale;
      const localY = (y - vnc._display.absY(0)) * scale;
      vnc._mousePos = { x: localX, y: localY };
      // The touchpad has already coalesced movement for this frame. The
      // normal button handler would send the same position twice, and an
      // earlier direct-mouse timer could send an obsolete position later.
      if (vnc._mouseMoveTimer !== null) clearTimeout(vnc._mouseMoveTimer);
      vnc._mouseMoveTimer = null;
      vnc._mouseButtonMask = buttons;
      vnc._mouseLastMoveTime = Date.now();
      vnc._sendMouse(localX, localY, buttons);
    },
  };
}
