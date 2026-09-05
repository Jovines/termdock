// Private resource bodies are reused only after server validation. Per-resource
// requests share a controller; one view closing must not abort another reader.
interface BodyEntry { blob: Blob; headers: Headers; status: number }
interface Pending { controller: AbortController; readers: number; promise: Promise<BodyEntry> }
const cache = new Map<string, BodyEntry>();
const pending = new Map<string, Pending>();
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 48;
let bytes = 0;
let generation = 0;

export function clearPreviewResourceCache(): void {
  generation += 1;
  cache.clear();
  bytes = 0;
  for (const request of pending.values()) request.controller.abort();
  pending.clear();
}

if (typeof window !== 'undefined') window.addEventListener('auth:unauthorized', clearPreviewResourceCache);

function remember(key: string, entry: BodyEntry): void {
  const previous = cache.get(key);
  if (previous) { bytes -= previous.blob.size; cache.delete(key); }
  if (entry.blob.size > MAX_ENTRY_BYTES) return;
  cache.set(key, entry);
  bytes += entry.blob.size;
  while (cache.size > MAX_ENTRIES || bytes > MAX_BYTES) {
    const oldest = cache.keys().next().value!;
    bytes -= cache.get(oldest)!.blob.size;
    cache.delete(oldest);
  }
}

export function previewCacheStats(): { entries: number; bytes: number; pending: number } {
  return { entries: cache.size, bytes, pending: pending.size };
}

export async function fetchPreviewResource(input: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Response> {
  const url = new URL(input, typeof location !== 'undefined' ? location.origin : 'http://localhost');
  if (!/^\/api\/terminal\/fs\/(read|blob)$/.test(url.pathname)) return fetch(input, { signal: options.signal });
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
  // IO cancellation is now owned by the shared controller. These UI-local IDs
  // must not make every reopen a different HTTP cache entry.
  url.searchParams.delete('requestSlotId');
  url.searchParams.delete('action');
  url.searchParams.sort();
  const key = url.href;
  let request = pending.get(key);
  if (!request) {
    const controller = new AbortController();
    const epoch = generation;
    const entry = cache.get(key);
    const headers = new Headers();
    const etag = entry?.headers.get('ETag');
    if (etag) headers.set('If-None-Match', etag);
    const timer = setTimeout(() => controller.abort(new DOMException('File preview timed out. Please retry.', 'TimeoutError')), options.timeoutMs ?? 15_000);
    const created: Pending = { controller, readers: 0, promise: Promise.resolve(null as unknown as BodyEntry) };
    created.promise = (async () => {
      const response = await fetch(key, { headers, signal: controller.signal, cache: 'no-cache' });
      let body: BodyEntry;
      if (response.status === 304 && entry) body = entry;
      else body = { blob: await response.blob(), headers: new Headers(response.headers), status: response.status };
      if (generation === epoch && !controller.signal.aborted && body.status === 200 && body.headers.has('ETag')) remember(key, body);
      if (response.status === 401) clearPreviewResourceCache();
      return body;
    })().finally(() => {
      clearTimeout(timer);
      if (pending.get(key) === created) pending.delete(key);
    });
    request = created;
    pending.set(key, request);
  }
  const shared = request;
  shared.readers += 1;
  return new Promise<Response>((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return false;
      finished = true;
      options.signal?.removeEventListener('abort', abort);
      shared.readers -= 1;
      if (shared.readers === 0 && pending.get(key) === shared) {
        pending.delete(key);
        shared.controller.abort();
      }
      return true;
    };
    const abort = () => { if (release()) reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    shared.promise.then((entry) => {
      if (release()) resolve(new Response(entry.blob, { status: entry.status, headers: entry.headers }));
    }, (error) => { if (release()) reject(error); });
  });
}
