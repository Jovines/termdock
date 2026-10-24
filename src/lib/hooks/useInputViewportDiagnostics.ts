import { useEffect, type RefObject } from 'react';
import { viewportWindow } from '../services/workspaceViewport';
import { clientLog } from '../utils/clientLog';
import { isIOSDevice } from '../utils/touchTerminalLayout';
import { VIEWPORT_LAYOUT_CHANGE_EVENT } from './useViewportHeight';

/** Numeric evidence for session-persistent native viewport faults. Never changes
 * focus, scroll, styles or input data. At most three samples per focus session. */
export function useInputViewportDiagnostics(input: RefObject<HTMLTextAreaElement>, enabled: boolean) {
  useEffect(() => {
    const element = input.current;
    if (!enabled || !isIOSDevice() || !element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let samples = 0, sequence = 0, armed = false;
    const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const rect = (node: Element | null | undefined) => {
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) };
    };
    const report = (source: string) => {
      if (!armed || samples >= 3 || document.visibilityState !== 'visible') return;
      samples++;
      const owner = viewportWindow(), viewport = owner.visualViewport;
      const style = getComputedStyle(document.documentElement);
      const px = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
      const root = document.getElementById('root');
      clientLog('info', 'INPUT_VIEWPORT_GEOMETRY', {
        revision: 'native-focus-layout-2', source, sequence, sample: samples,
        focused: document.activeElement === element, frame: owner !== window,
        window: { height: owner.innerHeight, scrollY: owner.scrollY },
        viewport: viewport ? { height: viewport.height, offsetTop: viewport.offsetTop, pageTop: viewport.pageTop, scale: viewport.scale } : null,
        baseHeight: px('--app-base-vh'), keyboardHeight: px('--kb-height'),
        nativePan: px('--app-native-pan'),
        safeTop: px('--safe-top-inset'), safeBottom: px('--safe-bottom-inset'),
        root: rect(root), ownerRoot: rect(owner.document.getElementById('root')),
        rootPaddingBottom: root ? Number.parseFloat(getComputedStyle(root).paddingBottom) || 0 : 0,
        panel: rect(element.closest('[data-session-chat]')),
        composer: rect(element.closest('.session-chat-composer')),
        input: rect(element), opacity: getComputedStyle(element).opacity,
      });
    };
    const settle = () => {
      if (!armed || samples >= 3) return;
      cancel(); timer = setTimeout(() => { timer = undefined; report('layout.settled'); }, 250);
    };
    const focus = () => { cancel(); samples = 0; sequence++; armed = true; report('focus'); settle(); };
    const blur = () => { cancel(); report('blur'); armed = false; };
    const typed = () => { cancel(); report('native.input'); };
    element.addEventListener('focus', focus);
    element.addEventListener('blur', blur);
    element.addEventListener('input', typed);
    document.addEventListener(VIEWPORT_LAYOUT_CHANGE_EVENT, settle);
    if (document.activeElement === element) focus();
    return () => {
      cancel();
      element.removeEventListener('focus', focus);
      element.removeEventListener('blur', blur);
      element.removeEventListener('input', typed);
      document.removeEventListener(VIEWPORT_LAYOUT_CHANGE_EVENT, settle);
    };
  }, [input, enabled]);
}
