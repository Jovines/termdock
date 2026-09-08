/** Saved addresses are display/connection metadata, never credentials. */
export interface ServiceRoute { url: string; targetPeerId: string }
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
export interface ServiceDirectoryBridge {
  getServiceConnection?(): Promise<(ServiceConnection & { invitation?: string }) | null>;
  serviceConnections?(): Promise<ServiceConnection[]>;
  saveServiceConnection?(connection: ServiceConnection): Promise<ServiceConnection[]>;
  importServiceConnection?(connection: ServiceConnection): Promise<ServiceConnection[]>;
  removeServiceConnection?(id: string): Promise<ServiceConnection[]>;
  onServiceConnections?(callback: () => void): () => void;
  openServiceConnection?(connection: ServiceConnection, invitation?: string): Promise<{ ok: boolean; error?: string }>;
}
export function normalizeServiceAddress(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('请输入服务地址。');
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)) throw new Error('请使用 HTTPS 服务地址。');
  if (url.username || url.password || url.search || url.hash || !['/', '/api/federation/secure'].includes(url.pathname)) throw new Error('请输入服务首页地址，不要包含账号或额外参数。');
  return url.origin;
}
export function parseSavedService(value: unknown): ServiceConnection | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  if (typeof item.url !== 'string') return;
  try {
    const url = normalizeServiceAddress(item.url);
    const targetPeerId = typeof item.targetPeerId === 'string' && item.targetPeerId ? item.targetPeerId : undefined;
    const label = (typeof item.label === 'string' ? item.label : typeof item.serviceName === 'string' ? item.serviceName : '').trim().slice(0, 120) || new URL(url).host;
    return { id: typeof item.id === 'string' && item.id ? item.id : targetPeerId || url, url, label,
      ...(targetPeerId ? { targetPeerId } : {}),
      ...(typeof item.serviceOrigin === 'string' ? { serviceOrigin: normalizeServiceAddress(item.serviceOrigin) } : {}),
      ...(typeof item.entryServiceId === 'string' && item.entryServiceId ? { entryServiceId: item.entryServiceId } : {}),
      ...(Array.isArray(item.routes) ? { routes: item.routes.slice(0, 4).flatMap(route => { try { return route && typeof route.targetPeerId === 'string' && route.targetPeerId ? [{ url: normalizeServiceAddress(route.url), targetPeerId: route.targetPeerId }] : []; } catch { return []; } }) } : {}) };
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
    if (index < 0) result.push(item);
    else result[index] = { ...result[index], ...item, id: result[index].id };
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
    return native;
  })();
  try { return await importing; } finally { importing = undefined; }
}
export async function saveServiceConnection(input: ServiceConnection): Promise<ServiceConnection[]> {
  const item = parseSavedService(input);
  if (!item) throw new Error('服务地址无效。');
  const bridge = nativeBridge();
  if (bridge?.saveServiceConnection) return bridge.saveServiceConnection(item);
  const current = readBrowserServices();
  const existing = current.find(record => record.id === item.id || sameService(record, item));
  const next = mergeServiceConnections([...current.filter(record => record !== existing), { ...existing, ...item, id: existing?.id || item.id }]);
  writeBrowserServices(next); return next;
}
export async function removeServiceConnection(id: string): Promise<ServiceConnection[]> {
  const bridge = nativeBridge();
  if (bridge?.removeServiceConnection) return bridge.removeServiceConnection(id);
  const next = readBrowserServices().filter(item => item.id !== id);
  writeBrowserServices(next); return next;
}
export function observeServiceConnections(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === SERVICE_DIRECTORY_KEY || event.key === null) listener(); };
  window.addEventListener(SERVICE_DIRECTORY_EVENT, listener);
  window.addEventListener('storage', storage);
  const unsubscribe = nativeBridge()?.onServiceConnections?.(listener);
  return () => { window.removeEventListener(SERVICE_DIRECTORY_EVENT, listener); window.removeEventListener('storage', storage); unsubscribe?.(); };
}
