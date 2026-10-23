/** Saved addresses are display/connection metadata, never credentials.
 * A route with the service's own peer ID is another direct address; a different
 * peer ID identifies an explicitly authorized relay service.
 */
import { normalizeServiceAddress, canonicalConnectionRouting, MAX_SAVED_ROUTES, type ServiceRoute } from '../../server/federation/connectionModel';
export { normalizeServiceAddress };
export type { ServiceRoute };
export interface ServiceConnection {
  id: string;
  url: string;
  label: string;
  targetPeerId?: string;
  serviceOrigin?: string;
  entryServiceId?: string;
  routes?: ServiceRoute[];
}
export const SERVICE_DIRECTORY_KEY = 'termdock.federation.connections.v1';
export const SERVICE_DIRECTORY_EVENT = 'termdock:services-changed';
const REMOVED_SERVICES_KEY = 'termdock-secure-removed-services';
const connectionKeys = (item: ServiceConnection): string[] => [item.id, item.targetPeerId, item.serviceOrigin || item.url].filter((key): key is string => !!key);
function removedServiceKeys(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(REMOVED_SERVICES_KEY) || '[]');
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
  } catch { return []; }
}
export interface ServiceDirectoryBridge {
  getServiceConnection?(): Promise<(ServiceConnection & { invitation?: string }) | null>;
  serviceConnections?(): Promise<ServiceConnection[]>;
  saveServiceConnection?(connection: ServiceConnection): Promise<ServiceConnection[]>;
  importServiceConnection?(connection: ServiceConnection): Promise<ServiceConnection[]>;
  removeServiceConnection?(id: string): Promise<ServiceConnection[]>;
  onServiceConnections?(callback: () => void): () => void;
  openServiceConnection?(connection: ServiceConnection, invitation?: string): Promise<{ ok: boolean; error?: string }>;
}
export function parseSavedService(value: unknown): ServiceConnection | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  if (typeof item.url !== 'string') return;
  try {
    const url = normalizeServiceAddress(item.url);
    const targetPeerId = typeof item.targetPeerId === 'string' && item.targetPeerId ? item.targetPeerId : undefined;
    const label = (typeof item.label === 'string' ? item.label : typeof item.serviceName === 'string' ? item.serviceName : '').trim().slice(0, 120) || new URL(url).host;
    return canonicalConnectionRouting({ id: typeof item.id === 'string' && item.id ? item.id : targetPeerId || url, url, label,
      ...(targetPeerId ? { targetPeerId } : {}),
      ...(typeof item.serviceOrigin === 'string' ? { serviceOrigin: normalizeServiceAddress(item.serviceOrigin) } : {}),
      ...(typeof item.entryServiceId === 'string' && item.entryServiceId ? { entryServiceId: item.entryServiceId } : {}),
      ...(Array.isArray(item.routes) ? { routes: item.routes.slice(0, MAX_SAVED_ROUTES).flatMap(route => { try { return route && typeof route.targetPeerId === 'string' && route.targetPeerId ? [{ url: normalizeServiceAddress(route.url), targetPeerId: route.targetPeerId }] : []; } catch { return []; } }) } : {}) });
  } catch { return; }
}
export function sameService(left: ServiceConnection, right: ServiceConnection): boolean {
  if (left.targetPeerId && right.targetPeerId) return left.targetPeerId === right.targetPeerId;
  return (left.serviceOrigin || left.url) === (right.serviceOrigin || right.url);
}
export function mergeServiceConnections(items: ServiceConnection[]): ServiceConnection[] {
  const result: ServiceConnection[] = [];
  for (const item of items) {
    const index = result.findIndex(existing => sameService(existing, item));
    if (index < 0) result.push(canonicalConnectionRouting(item));
    else result[index] = canonicalConnectionRouting({ ...result[index], ...item, id: result[index].id });
  }
  return result;
}
function nativeBridge(): ServiceDirectoryBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.termdockDesktop;
}
export function readBrowserServices(): ServiceConnection[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(SERVICE_DIRECTORY_KEY) || '[]');
    return Array.isArray(values) ? mergeServiceConnections(values.map(parseSavedService).filter((item): item is ServiceConnection => !!item)) : [];
  } catch { return []; }
}
export function writeBrowserServices(services: ServiceConnection[]): void {
  // Keep the old field too so an already-open older tab can still display names.
  localStorage.setItem(SERVICE_DIRECTORY_KEY, JSON.stringify(services.map(item => ({ ...item, serviceName: item.label }))));
  window.dispatchEvent(new Event(SERVICE_DIRECTORY_EVENT));
}
let importing: Promise<ServiceConnection[]> | undefined;
export async function listServiceConnections(): Promise<ServiceConnection[]> {
  const bridge = nativeBridge();
  if (!bridge?.serviceConnections || !bridge.saveServiceConnection) return readBrowserServices();
  if (importing) return importing;
  importing = (async () => {
    let native = await bridge.serviceConnections!();
    // Desktop config is authoritative. Import pre-existing web bookmarks once;
    // thereafter stale per-origin copies must not resurrect removed services.
    const legacy = readBrowserServices();
    for (const item of legacy) if (!native.some(existing => sameService(existing, item))) native = await (bridge.importServiceConnection || bridge.saveServiceConnection)!(item);
    if (legacy.length) localStorage.removeItem(SERVICE_DIRECTORY_KEY);
    return native.map(parseSavedService).filter((item): item is ServiceConnection => !!item);
  })();
  try { return await importing; } finally { importing = undefined; }
}
export async function saveServiceConnection(input: ServiceConnection): Promise<ServiceConnection[]> {
  if (input.entryServiceId && input.entryServiceId === input.targetPeerId) throw new Error('不能保存服务到自身的中转；请将其它地址添加为备用地址。');
  const item = parseSavedService(input);
  if (!item) throw new Error('服务地址无效。');
  const bridge = nativeBridge();
  if (bridge?.saveServiceConnection) return (await bridge.saveServiceConnection(item)).map(parseSavedService).filter((entry): entry is ServiceConnection => !!entry);
  const current = readBrowserServices();
  const existing = current.find(record => record.id === item.id || sameService(record, item));
  const restoredKeys = new Set([...connectionKeys(item), ...(existing ? connectionKeys(existing) : [])]);
  localStorage.setItem(REMOVED_SERVICES_KEY, JSON.stringify(removedServiceKeys().filter(key => !restoredKeys.has(key))));
  const next = mergeServiceConnections([...current.filter(record => record !== existing), canonicalConnectionRouting({ ...existing, ...item, id: existing?.id || item.id })]);
  writeBrowserServices(next); return next;
}
/** Background reconnects may update metadata but cannot undo an explicit removal
 * from another workspace. Native and browser directories honor the same rule. */
export async function rememberServiceConnection(input: ServiceConnection): Promise<ServiceConnection[]> {
  if (input.entryServiceId && input.entryServiceId === input.targetPeerId) throw new Error('不能保存服务到自身的中转；请将其它地址添加为备用地址。');
  const item = parseSavedService(input);
  if (!item) throw new Error('服务地址无效。');
  const bridge = nativeBridge();
  if (bridge?.importServiceConnection) return (await bridge.importServiceConnection(item)).map(parseSavedService).filter((entry): entry is ServiceConnection => !!entry);
  if (bridge?.serviceConnections) {
    const current = await bridge.serviceConnections();
    return current.some(existing => sameService(existing, item)) ? saveServiceConnection(item) : current;
  }
  return connectionKeys(item).some(key => removedServiceKeys().includes(key)) ? readBrowserServices() : saveServiceConnection(item);
}
export async function removeServiceConnection(id: string): Promise<ServiceConnection[]> {
  const bridge = nativeBridge();
  if (bridge?.removeServiceConnection) return (await bridge.removeServiceConnection(id)).map(parseSavedService).filter((entry): entry is ServiceConnection => !!entry);
  const current = readBrowserServices();
  const removed = current.find(item => item.id === id);
  if (removed) localStorage.setItem(REMOVED_SERVICES_KEY, JSON.stringify([...new Set([...removedServiceKeys(), ...connectionKeys(removed)])].slice(-768)));
  const next = current.filter(item => item.id !== id);
  writeBrowserServices(next); return next;
}
export function observeServiceConnections(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === SERVICE_DIRECTORY_KEY || event.key === null) listener(); };
  window.addEventListener(SERVICE_DIRECTORY_EVENT, listener);
  window.addEventListener('storage', storage);
  const unsubscribe = nativeBridge()?.onServiceConnections?.(listener);
  return () => { window.removeEventListener(SERVICE_DIRECTORY_EVENT, listener); window.removeEventListener('storage', storage); unsubscribe?.(); };
}
