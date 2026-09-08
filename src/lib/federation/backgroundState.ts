import type { ServiceRoute } from '../services/serviceDirectory';
export interface BackgroundTarget {
  targetPeerId: string;
  addresses: string[];
  routes: ServiceRoute[];
  publicKey: string;
  preferences: { aiEnabled: boolean; exitEnabled: boolean; alertStyle: string; locale: string };
}
export async function backgroundStore<T>(action: (store: IDBObjectStore) => IDBRequest<T>, write = false, databaseName = 'termdock-encrypted-background'): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('state', write ? 'readwrite' : 'readonly');
      const request = action(tx.objectStore('state'));
      tx.oncomplete = () => resolve(request.result); tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export const backgroundTargets = () => backgroundStore<BackgroundTarget[]>(store => store.getAll());
export const saveBackgroundTarget = (target: BackgroundTarget) => backgroundStore(store => store.put(target, target.targetPeerId), true);
export const removeBackgroundTarget = (id: string) => backgroundStore(store => store.delete(id), true);
