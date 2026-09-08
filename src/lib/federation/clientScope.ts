export const TARGET_KEY = 'termdock-secure-target-v1';
export const ENTRY_KEY = 'termdock-secure-entry-v1';
const GLOBAL_KEYS = new Set([TARGET_KEY, ENTRY_KEY, 'termdock-color-theme', 'termdock:locale', 'termdock.federation.connections.v1']);
const rawGet = typeof Storage === 'undefined' ? undefined : Storage.prototype.getItem;
const rawSet = typeof Storage === 'undefined' ? undefined : Storage.prototype.setItem;
const LEGACY_OWNER_KEY = 'termdock-secure-legacy-owner';
export interface SavedTarget { url: string; targetPeerId: string; serviceName?: string; serviceOrigin?: string; entryServiceId?: string; routes?: { url: string; targetPeerId: string }[] }
export function readSelectedTarget(): SavedTarget | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(TARGET_KEY) ?? localStorage.getItem(TARGET_KEY) ?? 'null');
    return value && typeof value.url === 'string' && typeof value.targetPeerId === 'string' ? value : null;
  } catch { return null; }
}
// Each tab captures its own target. Another tab switching services cannot redirect this one.
let selected = readSelectedTarget();
export const BOOT_SERVICE_ID = selected?.targetPeerId ?? 'unpaired';
export function selectedTarget(): SavedTarget | null { return selected; }
export function saveSelectedTarget(value: SavedTarget): void {
  selected = value;
  const raw = JSON.stringify(value);
  sessionStorage.setItem(TARGET_KEY, raw); localStorage.setItem(TARGET_KEY, raw);
}
export function scopedStorageKey(key: string, serviceId = BOOT_SERVICE_ID): string {
  return GLOBAL_KEYS.has(key) || key.startsWith('termdock-secure-') ? key : `termdock-service:${serviceId}:${key}`;
}
/** Bind pre-upgrade browser state once, only after authenticating this origin's direct service. */
export function migrateLegacyServiceState(serviceId: string): void {
  if (!rawGet || !rawSet) return;
  try {
    const owner = rawGet.call(localStorage, LEGACY_OWNER_KEY);
    if (owner) return;
    rawSet.call(localStorage, LEGACY_OWNER_KEY, serviceId);
    for (const storage of [localStorage, sessionStorage]) {
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key);
      for (const key of keys) {
        if (key.startsWith('termdock-service:') || scopedStorageKey(key, serviceId) === key) continue;
        const target = scopedStorageKey(key, serviceId);
        const value = rawGet.call(storage, key);
        if (value !== null && rawGet.call(storage, target) === null) rawSet.call(storage, target, value);
      }
    }
  } catch { /* Storage denial must not prevent authenticated access. */ }
}
let installed = false;
/** Existing stores share the same browser origin; scope their persisted state before importing App.
 * A target switch performs a full page reload so in-memory singletons share this same boundary. */
export function installServiceStorageScope(): void {
  if (installed || typeof Storage === 'undefined') return;
  installed = true;
  const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
  Storage.prototype.getItem = function(key: string) { return get.call(this, scopedStorageKey(String(key))); };
  Storage.prototype.setItem = function(key: string, value: string) { set.call(this, scopedStorageKey(String(key)), value); };
  Storage.prototype.removeItem = function(key: string) { remove.call(this, scopedStorageKey(String(key))); };
}
