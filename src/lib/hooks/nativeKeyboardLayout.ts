import { isIOSDevice } from '../utils/touchTerminalLayout';
import { viewportWindow } from '../services/workspaceViewport';

/** Native focus owns input placement on iOS; viewport height is state only. */
export function usesNativeKeyboardLayout(): boolean {
  return isIOSDevice();
}

export function focusKeyboardInput(input: HTMLElement | null | undefined): void {
  if (usesNativeKeyboardLayout()) input?.focus();
  else input?.focus({ preventScroll: true });
}

/** Measure what actually moved, never what keyboard/visual height predicts.
 * Retained same-origin workspaces include their physical frame displacement. */
export function measureNativePagePan(): number {
  const root = document.getElementById('root');
  if (!root) return 0;
  let top = root.getBoundingClientRect().top;
  let current: Window = window;
  const owner: Window = viewportWindow();
  try {
    while (current !== owner && current.frameElement) {
      top += current.frameElement.getBoundingClientRect().top;
      current = current.parent;
    }
  } catch { /* Cross-origin frames keep their own layout authority. */ }
  return Math.round(-top * 100) / 100 || 0;
}
