export interface TerminalSnapshot {
  id: string;
  version: 1;
  epoch: string;
  seq: number;
  cols: number;
  rows: number;
  data: string;
  savedAt: number;
}
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_AGE = 24 * 60 * 60_000;
let generation = 0;
let connection: Promise<IDBDatabase | null> | undefined;
function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return connection ??= new Promise((resolve) => {
    const request = indexedDB.open('termdock-terminal-snapshots', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots', { keyPath: 'id' });
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = undefined; };
      resolve(request.result);
    };
  });
}
export function isUsableTerminalSnapshot(value: TerminalSnapshot | undefined): value is TerminalSnapshot {
  return !!value && value.version === 1 && typeof value.epoch === 'string' && value.epoch.length > 0
    && Number.isSafeInteger(value.cols) && value.cols > 0 && Number.isSafeInteger(value.rows) && value.rows > 0
    && Number.isSafeInteger(value.seq) && value.seq > 0 && typeof value.data === 'string'
    && value.data.length * 2 <= MAX_ENTRY_BYTES && value.savedAt <= Date.now()
    && Date.now() - value.savedAt < MAX_AGE;
}
export async function readTerminalSnapshot(id: string): Promise<TerminalSnapshot | null> {
  const revision = generation;
  try {
    const db = await database();
    if (!db || revision !== generation) return null;
    return await new Promise((resolve) => {
      const request = db.transaction('snapshots').objectStore('snapshots').get(id);
      request.onerror = () => resolve(null);
      request.onsuccess = () => resolve(revision === generation && isUsableTerminalSnapshot(request.result) ? request.result : null);
    });
  } catch { return null; }
}
export async function writeTerminalSnapshot(snapshot: TerminalSnapshot): Promise<void> {
  const revision = generation;
  if (!isUsableTerminalSnapshot(snapshot)) return;
  try {
    const db = await database();
    if (!db || revision !== generation) return;
    await new Promise<void>((resolve) => {
      const transaction = db.transaction('snapshots', 'readwrite');
      const store = transaction.objectStore('snapshots');
      store.put(snapshot);
      const all = store.getAll();
      all.onsuccess = () => {
        let bytes = 0;
        let count = 0;
        for (const item of (all.result as TerminalSnapshot[]).sort((a, b) => b.savedAt - a.savedAt)) {
          bytes += item.data.length * 2;
          if (++count > 32 || bytes > MAX_BYTES || !isUsableTerminalSnapshot(item)) store.delete(item.id);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => resolve();
    });
  } catch { /* Storage denial or quota must never interrupt the terminal. */ }
}
export async function clearTerminalSnapshots(): Promise<void> {
  generation += 1;
  try {
    const db = await database();
    db?.transaction('snapshots', 'readwrite').objectStore('snapshots').clear();
  } catch { /* best effort */ }
}
if (typeof window !== 'undefined') window.addEventListener('auth:unauthorized', () => { void clearTerminalSnapshots(); });
