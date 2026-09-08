import { createIdentity, secureConnection } from './secureProtocol.js';
import { socketDuplex } from './socketDuplex.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { RelayRouter } from './relay.js';
export interface DirectTargetConfig { serviceId: string; url: string; caPath?: string }
function endpoint(config: DirectTargetConfig): string {
  if (!config || typeof config !== 'object' || Object.keys(config).some(key => !['serviceId', 'url', 'caPath'].includes(key)) || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(config.serviceId) || typeof config.url !== 'string' || (config.caPath !== undefined && typeof config.caPath !== 'string')) throw new Error('Invalid direct target configuration');
  const url = new URL(config.url);
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/', '/api/federation/secure'].includes(url.pathname)) throw new Error('Direct targets require a verified HTTPS/WSS origin');
  url.protocol = 'wss:'; url.pathname = '/api/federation/secure'; return url.toString();
}
/** Registers only administrator-configured destinations. TLS validation and redirect
 * refusal apply even though the inner session also has end-to-end encryption. */
export function attachRegisteredDirectTargets<P>(router: RelayRouter<P>, configs: readonly DirectTargetConfig[], baseDir = process.cwd()): () => void {
  if (!Array.isArray(configs) || configs.length > 64) throw new Error('Invalid direct target registry');
  const ids = new Set<string>();
  const targets = configs.map(config => {
    const url = endpoint(config);
    if (ids.has(config.serviceId)) throw new Error('Duplicate direct target'); ids.add(config.serviceId);
    return { serviceId: config.serviceId, url, ca: config.caPath ? readFileSync(resolve(baseDir, config.caPath)) : undefined };
  });
  let stopped = false; const sockets = new Set<WebSocket>(); const cleanups: (() => void)[] = [];
  const cleanup = () => { stopped = true; for (const close of cleanups.splice(0)) close(); for (const ws of sockets) ws.terminate(); };
  try {
    for (const target of targets) cleanups.push(router.registerDirect(target.serviceId, () => new Promise<WebSocket>((accept, reject) => {
      if (stopped) { reject(new Error('Direct target stopped')); return; }
      const ws = new WebSocket(target.url, { ca: target.ca, rejectUnauthorized: true, followRedirects: false, handshakeTimeout: 10000, maxPayload: 256 * 1024 });
      sockets.add(ws); ws.once('close', () => sockets.delete(ws));
      const failed = () => { reject(new Error('Direct target unavailable')); ws.terminate(); };
      ws.once('error', failed); ws.once('close', failed);
      ws.once('open', () => { ws.off('error', failed); ws.off('close', failed); ws.on('error', () => ws.terminate()); if (stopped) failed(); else accept(ws); });
    })));
  } catch (error) { cleanup(); throw error; }
  return cleanup;
}

/** An administrator enabling a new backup first proves the target's pinned
 * identity; HTTPS validation remains enabled throughout. */
export async function verifyDirectTarget(config: DirectTargetConfig): Promise<void> {
  const ws = new WebSocket(endpoint(config), { rejectUnauthorized: true, followRedirects: false, handshakeTimeout: 5000, maxPayload: 256 * 1024 });
  const duplex = socketDuplex(ws);
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(new Error('Target closed'))); });
    await secureConnection({ identity: await createIdentity(), initiator: true, targetPinnedPeerId: config.serviceId, duplex, signal: AbortSignal.timeout(5000) });
  } finally { ws.close(); }
}
