// Keep these independent of app releases and Workbox's app-shell caches.
// The asset URL carries the core version; existing v2 downloads stay reusable.
const CACHE_NAME = 'termdock-video-compression-v2';
const DATABASE_NAME = 'termdock-media-plugins';
const STORE_NAME = 'assets';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    let settled = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error('Plugin storage unavailable'));
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error('Plugin storage unavailable'));
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      resolve(request.result);
    };
  });
}

async function withBlobStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      // Wait for the write to commit before reporting that it has been saved.
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Plugin storage failed'));
    });
  } finally {
    db.close();
  }
}

export async function readVideoCoreCache(url: string, expectedSize: number): Promise<Blob | null> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(url);
    if (response?.ok) {
      const blob = await response.blob();
      if (blob.size === expectedSize) return blob;
      await cache.delete(url);
    }
  } catch { /* Try the independent IndexedDB fallback. */ }
  try {
    const blob = await withBlobStore('readonly', store => store.get(url));
    if (blob instanceof Blob && blob.size === expectedSize) return blob;
  } catch { /* No readable local copy; HTTP caching is still available. */ }
  return null;
}

export async function writeVideoCoreCache(url: string, blob: Blob): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/wasm' } }));
    const stored = await cache.match(url);
    if (stored?.ok && (await stored.blob()).size === blob.size) return true;
  } catch { /* Some browser modes reject Cache Storage writes. */ }
  try {
    await withBlobStore('readwrite', store => store.put(blob, url));
    const stored = await withBlobStore('readonly', store => store.get(url));
    return stored instanceof Blob && stored.size === blob.size;
  } catch {
    return false;
  }
}
