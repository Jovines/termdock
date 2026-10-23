import { createIdentity, secureConnection } from './secureProtocol.js';
import { socketDuplex } from './socketDuplex.js';
import WebSocket from 'ws';
import { RelayRouter } from './relay.js';
import { openServiceSocket } from './serviceTransport.js';
import { serviceEndpoint } from './connectionModel.js';
export interface DirectTargetConfig { serviceId: string; url: string; caPath?: string; caFingerprint256?: string; certificateFingerprint256?: string; label?: string }
function endpoint(config: DirectTargetConfig): string {
  if (!config || typeof config !== 'object' || Object.keys(config).some(key => !['serviceId', 'url', 'caPath', 'caFingerprint256', 'certificateFingerprint256', 'label'].includes(key)) || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(config.serviceId) || typeof config.url !== 'string' || (config.caPath !== undefined && typeof config.caPath !== 'string')) throw new Error('Invalid direct target configuration');
  if ((config.caFingerprint256 !== undefined && (typeof config.caFingerprint256 !== 'string' || !/^(?:[\da-f]{2}:){31}[\da-f]{2}$/i.test(config.caFingerprint256))) || (config.caPath && config.caFingerprint256) || (config.label !== undefined && (typeof config.label !== 'string' || config.label.length > 120))) throw new Error('Invalid direct target metadata');
  if (config.certificateFingerprint256 !== undefined && (typeof config.certificateFingerprint256 !== 'string' || !/^[\da-f]{64}$/i.test(config.certificateFingerprint256)
    || config.caPath !== undefined || config.caFingerprint256 !== undefined)) throw new Error('Invalid direct target certificate pin');
  const url = new URL(config.url);
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/', '/api/federation/secure'].includes(url.pathname)) throw new Error('Direct targets require a verified HTTPS/WSS origin');
  return serviceEndpoint(url.origin).href;
}
/** Registers only administrator-configured destinations. TLS validation and redirect
 * refusal apply even though the inner session also has end-to-end encryption. */
export function attachRegisteredDirectTargets<P>(router: RelayRouter<P>, configs: readonly DirectTargetConfig[], baseDir = process.cwd()): () => void {
  if (!Array.isArray(configs) || configs.length > 64) throw new Error('Invalid direct target registry');
  const ids = new Set<string>();
  const targets = configs.map(config => {
    const url = endpoint(config);
    const key = JSON.stringify([config.serviceId, url]);
    if (ids.has(key)) throw new Error('Duplicate direct target address'); ids.add(key);
    return { config, serviceId: config.serviceId, url };
  });
  let stopped = false; const sockets = new Set<WebSocket>(); const cleanups: (() => void)[] = [];
  const lifetime = new AbortController();
  const cleanup = () => { stopped = true; lifetime.abort(); for (const close of cleanups.splice(0)) close(); for (const ws of sockets) ws.terminate(); };
  try {
    for (const target of targets) cleanups.push(router.registerDirect(target.serviceId, async signal => {
      if (stopped) throw new Error('Direct target stopped');
      const ws = await openServiceSocket(target.url, target.config, { baseDir, maxPayload: 256 * 1024, handshakeTimeout: 10000, signal: AbortSignal.any([signal, lifetime.signal]) });
      if (stopped) { ws.terminate(); throw new Error('Direct target stopped'); }
      sockets.add(ws); ws.once('close', () => sockets.delete(ws)); return ws;
    }));
  } catch (error) { cleanup(); throw error; }
  return cleanup;
}

/** An administrator enabling a new backup first proves the target's pinned
 * identity; HTTPS validation remains enabled throughout. */
export async function verifyDirectTarget(config: DirectTargetConfig, baseDir = process.cwd(), signal?: AbortSignal): Promise<void> {
  const url = endpoint(config);
  const ws = await openServiceSocket(url, config, { baseDir, maxPayload: 256 * 1024, signal });
  const duplex = socketDuplex(ws);
  try {
    await secureConnection({ identity: await createIdentity(), initiator: true, targetPinnedPeerId: config.serviceId, duplex, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  } finally { ws.close(); }
}
