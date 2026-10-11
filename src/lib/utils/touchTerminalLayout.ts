import { viewportWindow } from '../services/workspaceViewport';

export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Terminal input follows device capabilities independently of sidebar width. */
export function usesTouchTerminalLayout(): boolean {
  if (typeof window === 'undefined') return false;
  const owner = viewportWindow();
  const hasTouch = owner.navigator.maxTouchPoints > 0 || 'ontouchstart' in owner;
  return isIOSDevice() || (hasTouch && Math.min(owner.innerWidth, owner.innerHeight) < 768);
}
