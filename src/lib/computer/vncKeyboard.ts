import type RFB from '@novnc/novnc';

interface VncKeyboardInternals {
  _canvas: HTMLCanvasElement;
  _screen: HTMLElement;
  _mouseButtonMask: number;
  _mousePos: { x: number; y: number };
  _mouseMoveTimer: ReturnType<typeof setTimeout> | null;
  _sendMouse(x: number, y: number, buttons: number): void;
  _keyboard: { _target: HTMLElement; grab(): void; ungrab(): void; _allKeysUp(): void };
}

/** Preserve noVNC's physical-key/AltGr/platform mapping while giving browser
 * IMEs an editable target. Isolate the version-specific keyboard binding here. */
export function attachVncKeyboard(session: RFB, sendText: (text: string) => void): () => void {
  const vnc = session as unknown as VncKeyboardInternals;
  const keyboard = vnc._keyboard, originalTarget = keyboard._target, originalFocus = session.focus;
  const field = document.createElement('textarea');
  field.tabIndex = -1; field.setAttribute('aria-label', 'Remote desktop keyboard');
  field.autocapitalize = 'off'; field.autocomplete = 'off'; field.spellcheck = false;
  Object.assign(field.style, { position: 'absolute', left: '0', top: '0', width: '1px', height: '1px', fontSize: '16px', opacity: '0', pointerEvents: 'none' });
  vnc._screen.append(field);
  const listeners = new AbortController();
  let composing = false, frame: number | null = null, stopped = false;
  const releaseMouse = () => {
    if (vnc._mouseMoveTimer !== null) clearTimeout(vnc._mouseMoveTimer);
    vnc._mouseMoveTimer = null;
    if (vnc._mouseButtonMask) { vnc._mouseButtonMask = 0; vnc._sendMouse(vnc._mousePos.x, vnc._mousePos.y, 0); }
  };
  window.addEventListener('blur', releaseMouse, { signal: listeners.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { keyboard._allKeysUp(); releaseMouse(); } }, { signal: listeners.signal });
  const commit = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const text = field.value; field.value = '';
    if (text && !session.viewOnly) sendText(text);
  };
  field.addEventListener('keydown', event => {
    // noVNC 1.7 otherwise prevents the composition key's browser default.
    if (composing || event.isComposing || event.keyCode === 229) event.stopImmediatePropagation();
  }, { capture: true, signal: listeners.signal });
  field.addEventListener('compositionstart', () => { if (frame !== null) commit(); composing = true; keyboard._allKeysUp(); }, { signal: listeners.signal });
  field.addEventListener('compositionend', () => {
    composing = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(commit);
  }, { signal: listeners.signal });
  field.addEventListener('input', event => {
    if (!composing && !(event as InputEvent).isComposing && frame === null) commit();
  }, { signal: listeners.signal });
  field.addEventListener('blur', () => { if (!composing && frame !== null) commit(); keyboard._allKeysUp(); }, { signal: listeners.signal });
  keyboard.ungrab(); keyboard._target = field;
  if (!session.viewOnly) keyboard.grab();
  session.focus = options => { if (!stopped && !session.viewOnly) field.focus(options); };
  if (document.activeElement === originalTarget) session.focus({ preventScroll: true });
  return () => {
    if (stopped) return;
    stopped = true;
    if (frame !== null) { if (!composing) commit(); else cancelAnimationFrame(frame); }
    releaseMouse(); listeners.abort(); keyboard.ungrab(); keyboard._target = originalTarget;
    if (!session.viewOnly) keyboard.grab();
    session.focus = originalFocus; field.remove();
  };
}
