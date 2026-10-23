import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useConnectionRecovery } from '../federation/connectionRecovery';
import { useI18n } from '../i18n';

const startupVisible = () => document.getElementById('termdock-startup')?.hidden === false;
function subscribeStartupVisibility(listener: () => void) {
  const surface = document.getElementById('termdock-startup');
  if (!surface) return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(surface, { attributes: true, attributeFilter: ['hidden'] });
  return () => observer.disconnect();
}

/** Feedback follows the painted surface, including its two-frame handoff. */
export function useStartupVisible() {
  return useSyncExternalStore(subscribeStartupVisibility, startupVisible);
}

// One document-owned surface survives HTML → Suspense → authorization → restore.
// Components hold leases instead of remounting the image and animations.
interface StartupPresentation {
  status: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}
const holders = new Map<HTMLElement, StartupPresentation>();
let revision = 0;
let observer: MutationObserver | undefined;

function reconcileStartup() {
  const generation = ++revision;
  requestAnimationFrame(() => {
    if (generation !== revision) return;
    const surface = document.getElementById('termdock-startup');
    if (!surface) return;
    const visible = [...holders].find(([marker]) => marker.isConnected
      && !marker.closest('[aria-hidden="true"], [hidden]')
      && getComputedStyle(marker).visibility !== 'hidden');
    if (visible) {
      surface.hidden = false;
      const label = surface.querySelector('[data-startup-status]');
      const presentation = visible[1];
      if (label && label.textContent !== presentation.status) label.textContent = presentation.status;
      const detail = surface.querySelector<HTMLElement>('[data-startup-detail]');
      if (detail) {
        detail.hidden = !presentation.detail;
        detail.textContent = presentation.detail ?? '';
      }
      const action = surface.querySelector<HTMLButtonElement>('[data-startup-action]');
      if (action) {
        action.hidden = !presentation.actionLabel || !presentation.onAction;
        action.textContent = presentation.actionLabel ?? '';
        action.onclick = presentation.onAction ?? null;
      }
      return;
    }
    // Paint the destination before releasing. A new lease cancels this exit,
    // including StrictMode cleanup and lazy boundaries changing in this frame.
    requestAnimationFrame(() => {
      if (generation !== revision) return;
      surface.hidden = true;
      const action = surface.querySelector<HTMLButtonElement>('[data-startup-action]');
      if (action) action.onclick = null;
    });
  });
}

/** Also releases the HTML surface for login, error and development views. */
export function StartupHandoff() {
  useLayoutEffect(() => { reconcileStartup(); }, []);
  return null;
}

export function StartupScreen({ status = 'Loading Termdock', detail, actionLabel, onAction }: Partial<StartupPresentation> & { className?: string }) {
  const connection = useConnectionRecovery();
  const { locale } = useI18n();
  if (connection !== 'ready') {
    status = locale === 'zh'
      ? connection === 'offline' ? '网络已断开，等待恢复…' : '正在恢复连接…'
      : connection === 'offline' ? 'Offline. Waiting for network…' : 'Reconnecting…';
  }
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = marker.current!;
    holders.set(element, { status, detail, actionLabel, onAction });
    if (!observer) {
      observer = new MutationObserver(reconcileStartup);
      const root = document.getElementById('root');
      if (root) observer.observe(root, { attributes: true, subtree: true, attributeFilter: ['style', 'aria-hidden', 'hidden'] });
    }
    reconcileStartup();
    return () => {
      holders.delete(element);
      if (!holders.size) { observer?.disconnect(); observer = undefined; }
      reconcileStartup();
    };
  }, [status, detail, actionLabel, onAction]);
  return <span ref={marker} data-startup-pending="" style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} />;
}
