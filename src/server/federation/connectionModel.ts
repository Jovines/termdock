import { ConnectionAccessError } from './connectionErrors.js';

/** Shared metadata contract for pages, background workers and service routing.
 * Addresses never establish identity or convey permission. */
export interface ServiceRoute { url: string; targetPeerId: string }
export interface ConnectionRecord {
  url: string;
  targetPeerId?: string;
  serviceOrigin?: string;
  entryServiceId?: string;
  routes?: ServiceRoute[];
}
export const MAX_SAVED_ROUTES = 4;
export function normalizeServiceAddress(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('请输入服务地址。');
  const raw = value.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !loopback) throw new Error('请使用 HTTPS 服务地址。');
  if (url.username || url.password || url.search || url.hash || !['/', '/api/federation/secure'].includes(url.pathname)) throw new Error('请输入服务首页地址，不要包含账号或额外参数。');
  return url.origin;
}

export function normalizedRoutes(record: ConnectionRecord): ServiceRoute[] {
  if (record.entryServiceId && record.entryServiceId === record.targetPeerId) throw new ConnectionAccessError('RELAY_SELF_TARGET', { entryServiceId: record.entryServiceId, targetServiceId: record.targetPeerId });
  const candidates = Array.isArray(record.routes) ? record.routes.slice(0, 64) : [];
  if (record.entryServiceId) candidates.unshift({ url: record.url, targetPeerId: record.entryServiceId });
  const seen = new Set<string>();
  return candidates.flatMap(route => {
    try {
      if (!route || typeof route.targetPeerId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(route.targetPeerId)) return [];
      const url = normalizeServiceAddress(route.url), key = JSON.stringify([route.targetPeerId, url]);
      if (seen.has(key)) return [];
      seen.add(key); return [{ url, targetPeerId: route.targetPeerId }];
    } catch { return []; }
  }).slice(0, MAX_SAVED_ROUTES);
}

export function relayConnectionRoutes(record: ConnectionRecord): ServiceRoute[] {
  return normalizedRoutes(record).filter(route => route.targetPeerId !== record.targetPeerId);
}
export function directConnectionAddresses(record: ConnectionRecord): string[] {
  const routes = normalizedRoutes(record);
  const entryUrls = new Set(routes.filter(route => route.targetPeerId !== record.targetPeerId).map(route => route.url));
  const candidates = [record.serviceOrigin || record.url, ...routes.filter(route => route.targetPeerId === record.targetPeerId).map(route => route.url)];
  const result = new Set<string>();
  for (const value of candidates) try {
    const address = normalizeServiceAddress(value);
    if (!entryUrls.has(address)) result.add(address);
  } catch { /* An invalid address cannot substitute for a saved identity. */ }
  return [...result];
}

export function hasIndependentConnectionRoute(record: ConnectionRecord, deniedEntryServiceId?: string, excludedEntries: ReadonlySet<string> = new Set()): boolean {
  return directConnectionAddresses(record).length > 0
    || !!deniedEntryServiceId && relayConnectionRoutes(record).some(route => route.targetPeerId !== deniedEntryServiceId && !excludedEntries.has(route.targetPeerId));
}

/** Run after merges, including imports from old native clients. Otherwise an
 * omitted serviceOrigin can retain an old entry URL from the previous record. */
export function canonicalConnectionRouting<T extends ConnectionRecord>(record: T): T {
  const result = { ...record, url: normalizeServiceAddress(record.url) };
  const routes = normalizedRoutes(record);
  if (record.routes !== undefined) result.routes = routes;
  if (record.serviceOrigin) {
    const origin = normalizeServiceAddress(record.serviceOrigin);
    if (routes.some(route => route.targetPeerId !== record.targetPeerId && route.url === origin)) delete result.serviceOrigin;
    else result.serviceOrigin = origin;
  }
  return result;
}

export function serviceEndpoint(address: string, kind: 'secure' | 'relay' | 'relay-target' = 'secure'): URL {
  const url = new URL(normalizeServiceAddress(address));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/api/federation/${kind}`;
  return url;
}
