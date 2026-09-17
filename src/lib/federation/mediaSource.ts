import { useEffect, useRef, useState } from 'react';

export function isBusinessResource(value: string): boolean {
  try { return new URL(value, location.href).pathname.startsWith('/api/'); } catch { return false; }
}

// Give an installed worker a moment to claim the page before spending the
// encrypted channel on a whole-resource fallback fetch.
const WORKER_CONTROL_GRACE_MS = 1500;
// The fallback buffers the resource in memory. It covers images and ordinary
// clips, but refuses to hold multi-gigabyte videos from a broken worker shell.
const MAX_FALLBACK_BYTES = 256 * 1024 * 1024;

async function loadEncryptedBlob(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Media fallback failed: HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    if (blob.size > MAX_FALLBACK_BYTES) throw new Error('Media too large for encrypted fallback');
    return URL.createObjectURL(blob);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FALLBACK_BYTES) throw new Error('Media too large for encrypted fallback');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type }));
}

/** Native media requests bypass window.fetch. When a worker that forwards them
 * to the paired channel controls the page, hand the URL to the element directly.
 * Some shells (relay-only Electron windows, origins Chromium refuses to register
 * a worker for) never get that worker, so fall back to a blob fetched through
 * the page's encrypted fetch. Never assign the raw business URL to native media. */
export function useEncryptedMediaSource(url: string, onError?: () => void): string | undefined {
  const business = isBusinessResource(url);
  const [controlled, setControlled] = useState(() => Boolean(navigator.serviceWorker?.controller));
  const [fallback, setFallback] = useState<string | undefined>(undefined);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!business || controlled) return;
    const worker = navigator.serviceWorker;
    const update = () => setControlled(Boolean(worker?.controller));
    worker?.addEventListener('controllerchange', update);
    update();
    return () => worker?.removeEventListener('controllerchange', update);
  }, [business, controlled]);

  useEffect(() => {
    if (!business || controlled) { setFallback(undefined); return; }
    let cancelled = false;
    let objectUrl: string | undefined;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void loadEncryptedBlob(url, abort.signal).then((next) => {
        if (cancelled) { URL.revokeObjectURL(next); return; }
        objectUrl = next;
        setFallback(next);
      }).catch(() => {
        if (cancelled || abort.signal.aborted) return;
        onErrorRef.current?.();
      });
    }, WORKER_CONTROL_GRACE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [business, controlled, url]);

  if (!business || controlled) return url;
  return fallback;
}
