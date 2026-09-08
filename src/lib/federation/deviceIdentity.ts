import { createIdentity, importIdentity, exportIdentity, type Identity } from '../../server/federation/secureProtocol';
let identityPromise: Promise<Identity> | undefined;
export async function getIdentity(): Promise<Identity> {
  if (!identityPromise) identityPromise = (async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('termdock-device-identity', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const stored = await new Promise<string | undefined>((resolve, reject) => {
        const request = database.transaction('keys').objectStore('keys').get('identity');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (stored) return importIdentity(stored);
      const identity = await createIdentity();
      let winner = identity;
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('keys', 'readwrite');
        const store = tx.objectStore('keys'); const existing = store.get('identity');
        existing.onsuccess = () => { if (typeof existing.result === 'string') winner = importIdentity(existing.result); else store.put(exportIdentity(identity), 'identity'); };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      return winner;
    } finally { database.close(); }
  })();
  return identityPromise;
}
