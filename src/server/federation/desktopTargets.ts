import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DirectTargetConfig } from './directRoutes.js';
import { directConnectionAddresses, type ConnectionRecord } from './connectionModel.js';

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
export function desktopDirectTargets(file: string, localServiceId: string, format: 'electron' | 'preview' = 'electron'): DirectTargetConfig[] {
  if (!localServiceId) return [];
  try {
    if (statSync(file).size > 1024 * 1024) return [];
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.connections) || data.connections.length > 256) return [];
    const removedKeys = format === 'preview' ? data.removedKeys : data.removedServiceKeys;
    const removed = new Set(Array.isArray(removedKeys) ? removedKeys : []);
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
      for (const address of directConnectionAddresses(item as unknown as ConnectionRecord)) {
        const url = origin(address);
        if (!url) continue;
        const caFingerprint256 = trusts.get(url);
        const pin = format === 'preview' ? data.certificatePins?.[url] : undefined;
        // Preview pins the leaf certificate, whereas Electron approves a CA.
        // Never reinterpret one as the other or discard an invalid saved pin.
        if (pin !== undefined && (typeof pin !== 'string' || !/^[\da-f]{64}$/i.test(pin))) continue;
        targets.set(JSON.stringify([item.targetPeerId, url]), { serviceId: item.targetPeerId, url,
          ...(typeof item.label === 'string' && item.label.trim() ? { label: item.label.trim().slice(0, 120) } : {}),
          ...(format === 'electron' && caFingerprint256 ? { caFingerprint256 } : {}),
          ...(pin ? { certificateFingerprint256: pin.toUpperCase() } : {}) });
        if (targets.size >= 64) break;
      }
      if (targets.size >= 64) break;
    }
    return [...targets.values()];
  } catch { return []; }
}

/** Both installations keep their own bookmarks and trust. Reading Preview's
 * native directory also supports already-installed Preview apps, without
 * copying credentials or overwriting the Electron configuration. */
export function desktopServiceTargets(home: string, localServiceId: string, platform: NodeJS.Platform = process.platform): DirectTargetConfig[] {
  const previewRoot = platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? process.env.APPDATA || join(home, 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || join(home, '.config');
  const key = (target: DirectTargetConfig) => JSON.stringify([target.serviceId, target.url]);
  const targets = new Map(desktopDirectTargets(join(home, '.termdock', 'desktop.json'), localServiceId).map(target => [key(target), target]));
  for (const target of desktopDirectTargets(join(previewRoot, 'com.jovines.termdock.preview', 'connections.json'), localServiceId, 'preview')) targets.set(key(target), target);
  return [...targets.values()].slice(0, 64);
}
