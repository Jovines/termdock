const SW_UPDATE_CHECK_INTERVAL_MS = 60_000;
const BUILD_ID_STORAGE_KEY = 'termdock:build-id:v1';

let reloadPending = false;

declare const __TERMDOCK_BUILD_ID__: string;

function reloadOnceForUpdatedServiceWorker(): void {
  if (reloadPending) return;
  reloadPending = true;
  window.setTimeout(() => {
    window.location.reload();
  }, 80);
}

function askWaitingWorkerToActivate(registration: ServiceWorkerRegistration): void {
  registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
}

async function clearCachesForNewBuild(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
}

function watchRegistration(registration: ServiceWorkerRegistration): void {
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        askWaitingWorkerToActivate(registration);
      }
    });
  });
}

export function setupPwaUpdateReload(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const buildId = typeof __TERMDOCK_BUILD_ID__ === 'string' ? __TERMDOCK_BUILD_ID__ : '';
  const previousBuildId = window.localStorage.getItem(BUILD_ID_STORAGE_KEY);
  if (buildId && previousBuildId && previousBuildId !== buildId) {
    void clearCachesForNewBuild().finally(() => {
      window.localStorage.setItem(BUILD_ID_STORAGE_KEY, buildId);
      reloadOnceForUpdatedServiceWorker();
    });
    return;
  }
  if (buildId && previousBuildId !== buildId) {
    window.localStorage.setItem(BUILD_ID_STORAGE_KEY, buildId);
  }

  let intervalId: number | null = null;
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnceForUpdatedServiceWorker);

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((registration) => {
        watchRegistration(registration);
        askWaitingWorkerToActivate(registration);

        const check = () => {
          if (document.visibilityState !== 'visible') return;
          void registration.update().then(() => askWaitingWorkerToActivate(registration)).catch(() => undefined);
        };
        check();
        intervalId = window.setInterval(check, SW_UPDATE_CHECK_INTERVAL_MS);
        document.addEventListener('visibilitychange', check);
      })
      .catch(() => undefined);
  });

  window.addEventListener('beforeunload', () => {
    if (intervalId !== null) window.clearInterval(intervalId);
  });
}
