import { readFileSync, statSync } from 'node:fs';
import type { DirectTargetConfig } from './directRoutes.js';

const peer = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^(?:[\da-f]{2}:){31}[\da-f]{2}$/i.test(value);
function origin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return;
    return url.origin;
  } catch { return; }
}
/** Read only this OS user's Desktop directory. The local service must itself
 * have been pinned there before its administrator can discover other entries.
 * This supplies addresses, never the Desktop client's device authorization.
 */
export function desktopDirectTargets(file: string, localServiceId: string): DirectTargetConfig[] {
  if (!localServiceId) return [];
  try {
    if (statSync(file).size > 1024 * 1024) return [];
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.connections) || data.connections.length > 256) return [];
    const removed = new Set(Array.isArray(data.removedServiceKeys) ? data.removedServiceKeys : []);
    const connections = data.connections.filter((item: Record<string, unknown> | null) => item && ![item.id, item.targetPeerId, item.serviceOrigin || item.url].some(key => removed.has(key)));
    if (!connections.some((item: Record<string, unknown>) => item.targetPeerId === localServiceId)) return [];
    const trusts = new Map<string, string>();
    if (Array.isArray(data.trustedCertificateAuthorities)) for (const trust of data.trustedCertificateAuthorities.slice(0, 256)) {
      const url = origin(trust?.origin);
      if (url && fingerprint(trust.fingerprint256)) trusts.set(url, trust.fingerprint256.toUpperCase());
    }
    const targets = new Map<string, DirectTargetConfig>();
    for (const item of connections) {
      if (!peer(item.targetPeerId) || item.targetPeerId === localServiceId) continue;
      const url = origin(item.serviceOrigin || item.url);
      if (!url) continue;
      // An entry-only bookmark does not supply a direct address for its target.
      if ((!item.serviceOrigin && item.entryServiceId && item.entryServiceId !== item.targetPeerId)
        || (Array.isArray(item.routes) && item.routes.some((route: Record<string, unknown> | null) => route && route.targetPeerId !== item.targetPeerId && origin(route.url) === url))) continue;
      const caFingerprint256 = trusts.get(url);
      targets.set(item.targetPeerId, { serviceId: item.targetPeerId, url,
        ...(typeof item.label === 'string' && item.label.trim() ? { label: item.label.trim().slice(0, 120) } : {}),
        ...(caFingerprint256 ? { caFingerprint256 } : {}) });
      if (targets.size >= 64) break;
    }
    return [...targets.values()];
  } catch { return []; }
}
