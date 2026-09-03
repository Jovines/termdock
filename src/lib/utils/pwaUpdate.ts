const SW_UPDATE_CHECK_INTERVAL_MS = 60_000;

let reloadPending = false;

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

export function createControllerChangeHandler(
  controlledAtStartup: boolean,
  reload: () => void,
): () => void {
  let hasSeenController = controlledAtStartup;
  return () => {
    // The first controller on a fresh install already owns a page that loaded
    // the current network build. Reloading here makes the app visibly boot
    // twice and needlessly destroys a newly-created xterm renderer.
    if (!hasSeenController) {
      hasSeenController = true;
      return;
    }
    reload();
  };
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

  let intervalId: number | null = null;
  navigator.serviceWorker.addEventListener('controllerchange', createControllerChangeHandler(
    Boolean(navigator.serviceWorker.controller),
    reloadOnceForUpdatedServiceWorker,
  ));

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
