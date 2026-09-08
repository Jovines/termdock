import { canonicalApiPath } from '../../server/federation/accessPolicy.js';
import type { SecureClient } from './secureClient.js';

/** Install once in the app document. Nested documents receive no implicit delegation. */
export function installWorkerBridge(getClient: () => Promise<SecureClient>): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const active = new Set<() => void>();
  const receive = (event: MessageEvent) => {
    if (event.source !== navigator.serviceWorker.controller || event.data?.type !== 'termdock-secure-fetch' || event.ports.length !== 1) return;
    const port = event.ports[0];
    const { path, method, headers, body, expectedTargetPeerId, previewPrefix } = event.data;
    let url: URL;
    try { url = new URL(path, location.origin); } catch { port.close(); return; }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || active.size >= 32
      || typeof method !== 'string' || (body !== undefined && (!(body instanceof ArrayBuffer) || body.byteLength > 5 * 1024 * 1024))) {
      port.postMessage({ type: 'error' }); port.close(); return;
    }
    if (previewPrefix !== undefined && (typeof previewPrefix !== 'string' || !previewPrefix.endsWith('/')
      || !/^\/api\/terminal\/fs\/preview\/[a-f0-9]{32}\//.test(previewPrefix)
      || !['GET', 'HEAD'].includes(method) || !canonicalApiPath(url.pathname)?.startsWith(previewPrefix))) {
      port.postMessage({ type: 'error' }); port.close(); return;
    }
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let buffered: Uint8Array | undefined;
    let pulling = false;
    let done = false;
    const cleanup = () => {
      if (done) return; done = true; active.delete(cleanup);
      abort.abort(); void reader?.cancel().catch(() => {}); port.close();
    };
    active.add(cleanup);
    port.onmessage = e => {
      if (e.data?.type === 'cancel') { cleanup(); return; }
      if (e.data?.type !== 'pull' || pulling || done) return;
      pulling = true;
      void (async () => {
        if (!reader) { port.postMessage({ type: 'end' }); cleanup(); return; }
        if (!buffered?.length) {
          const result = await reader.read();
          if (result.done) { port.postMessage({ type: 'end' }); cleanup(); return; }
          buffered = result.value;
        }
        const chunk = buffered.slice(0, 64 * 1024); buffered = buffered.subarray(chunk.length);
        port.postMessage({ type: 'chunk', data: chunk.buffer }, [chunk.buffer]);
      })().catch(() => { port.postMessage({ type: 'error' }); cleanup(); }).finally(() => { pulling = false; });
    };
    port.onmessageerror = cleanup;
    port.start();
    void (async () => {
      // Capture one target for the entire request; tab/service changes never retarget an existing stream.
      const client = await getClient();
      if (done) return;
      if (expectedTargetPeerId && expectedTargetPeerId !== client.targetPeerId) throw new Error('Preview target changed');
      const response = await client.fetch(url.pathname + url.search, {
        method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        signal: abort.signal,
      });
      if (done) { await response.body?.cancel(); return; }
      reader = response.body?.getReader();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      port.postMessage({ type: 'head', status: response.status, headers: responseHeaders, bodyless: !reader, targetPeerId: client.targetPeerId });
    })().catch(() => { if (!done) { port.postMessage({ type: 'error' }); cleanup(); } });
  };
  navigator.serviceWorker.addEventListener('message', receive);
  return () => { navigator.serviceWorker.removeEventListener('message', receive); for (const cleanup of [...active]) cleanup(); };
}
