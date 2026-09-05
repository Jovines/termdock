import { useSyncExternalStore } from 'react';

const SW_UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;
let waitingRegistration: ServiceWorkerRegistration | undefined;
let updateAvailable = false;
let accepted = false;
let initialized = false;
const listeners = new Set<() => void>();
function notifyUpdate(): void {
  updateAvailable = true;
  listeners.forEach((listener) => listener());
}
export function usePwaUpdateAvailable(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => updateAvailable, () => false);
}

export function applyPwaUpdate(): void {
  // Synchronous draft flush hooks run before activation or a manual reload.
  window.dispatchEvent(new Event('termdock:before-update'));
  accepted = true;
  if (waitingRegistration?.waiting) {
    waitingRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
  } else window.location.reload();
}

export function createControllerChangeHandler(
  controlledAtStartup: boolean,
  onUpdate: () => void,
): () => void {
  let hasSeenController = controlledAtStartup;
  return () => {
    if (!hasSeenController) { hasSeenController = true; return; }
    onUpdate();
  };
}

export function setupPwaUpdateReload(): void {
  if (initialized || typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  initialized = true;
  navigator.serviceWorker.addEventListener('controllerchange', createControllerChangeHandler(
    Boolean(navigator.serviceWorker.controller),
    () => { if (accepted) window.location.reload(); else notifyUpdate(); },
  ));

  const register = () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => {
        waitingRegistration = registration;
        const inspect = () => { if (registration.waiting) notifyUpdate(); };
        const watch = () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) inspect();
          });
        };
        registration.addEventListener('updatefound', watch);
        watch();
        inspect();
        let lastCheck = 0;
        const check = () => {
          if (document.visibilityState !== 'visible' || Date.now() - lastCheck < SW_UPDATE_CHECK_INTERVAL_MS) return;
          lastCheck = Date.now();
          void registration.update().then(inspect).catch(() => undefined);
        };
        check();
        window.setInterval(check, SW_UPDATE_CHECK_INTERVAL_MS);
        document.addEventListener('visibilitychange', check);
      }).catch(() => undefined);
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
