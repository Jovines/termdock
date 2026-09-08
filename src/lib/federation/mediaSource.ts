import { useEffect, useState } from 'react';

export function isBusinessResource(value: string): boolean {
  try { return new URL(value, location.href).pathname.startsWith('/api/'); } catch { return false; }
}

/** Native media requests bypass window.fetch. Do not assign a business URL
 * until the worker that forwards it to the paired channel controls this page. */
export function useEncryptedMediaSource(url: string, onError?: () => void): string | undefined {
  const [controlled, setControlled] = useState(() => Boolean(navigator.serviceWorker?.controller));
  useEffect(() => {
    if (!isBusinessResource(url) || controlled) return;
    const worker = navigator.serviceWorker;
    const update = () => setControlled(Boolean(worker?.controller));
    worker?.addEventListener('controllerchange', update);
    update();
    const timeout = window.setTimeout(() => { if (!worker?.controller) onError?.(); }, 10_000);
    return () => { worker?.removeEventListener('controllerchange', update); window.clearTimeout(timeout); };
  }, [url, controlled, onError]);
  return isBusinessResource(url) && !controlled ? undefined : url;
}
