import { readPinnedCertificateAuthority } from './trustedCa.js';
import { createIdentity, secureConnection } from './secureProtocol.js';
import { socketDuplex } from './socketDuplex.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { RelayRouter } from './relay.js';
export interface DirectTargetConfig { serviceId: string; url: string; caPath?: string; caFingerprint256?: string; label?: string }
function endpoint(config: DirectTargetConfig): string {
  if (!config || typeof config !== 'object' || Object.keys(config).some(key => !['serviceId', 'url', 'caPath', 'caFingerprint256', 'label'].includes(key)) || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(config.serviceId) || typeof config.url !== 'string' || (config.caPath !== undefined && typeof config.caPath !== 'string')) throw new Error('Invalid direct target configuration');
  if ((config.caFingerprint256 !== undefined && (typeof config.caFingerprint256 !== 'string' || !/^(?:[\da-f]{2}:){31}[\da-f]{2}$/i.test(config.caFingerprint256))) || (config.caPath && config.caFingerprint256) || (config.label !== undefined && (typeof config.label !== 'string' || config.label.length > 120))) throw new Error('Invalid direct target metadata');
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
    return { serviceId: config.serviceId, url, caFingerprint256: config.caFingerprint256, ca: config.caPath ? readFileSync(resolve(baseDir, config.caPath)) : undefined };
  });
  let stopped = false; const sockets = new Set<WebSocket>(); const cleanups: (() => void)[] = [];
  const cleanup = () => { stopped = true; for (const close of cleanups.splice(0)) close(); for (const ws of sockets) ws.terminate(); };
  try {
    for (const target of targets) cleanups.push(router.registerDirect(target.serviceId, async () => {
      const ca = target.caFingerprint256 ? await readPinnedCertificateAuthority(target.url.replace(/^wss:/, 'https:'), target.caFingerprint256) : target.ca;
      return new Promise<WebSocket>((accept, reject) => {
        if (stopped) { reject(new Error('Direct target stopped')); return; }
        const ws = new WebSocket(target.url, { ca, rejectUnauthorized: true, followRedirects: false, handshakeTimeout: 10000, maxPayload: 256 * 1024 });
        sockets.add(ws); ws.once('close', () => sockets.delete(ws));
        const failed = () => { reject(new Error('Direct target unavailable')); ws.terminate(); };
        ws.once('error', failed); ws.once('close', failed);
        ws.once('open', () => { ws.off('error', failed); ws.off('close', failed); ws.on('error', () => ws.terminate()); if (stopped) failed(); else accept(ws); });
      });
    }));
  } catch (error) { cleanup(); throw error; }
  return cleanup;
}

/** An administrator enabling a new backup first proves the target's pinned
 * identity; HTTPS validation remains enabled throughout. */
export async function verifyDirectTarget(config: DirectTargetConfig): Promise<void> {
  const url = endpoint(config);
  const ca = config.caFingerprint256 ? await readPinnedCertificateAuthority(url.replace(/^wss:/, 'https:'), config.caFingerprint256) : config.caPath ? readFileSync(config.caPath) : undefined;
  const ws = new WebSocket(url, { ca, rejectUnauthorized: true, followRedirects: false, handshakeTimeout: 5000, maxPayload: 256 * 1024 });
  const duplex = socketDuplex(ws);
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(new Error('Target closed'))); });
    await secureConnection({ identity: await createIdentity(), initiator: true, targetPinnedPeerId: config.serviceId, duplex, signal: AbortSignal.timeout(5000) });
  } finally { ws.close(); }
}
