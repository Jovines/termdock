import { connect, type SecureClient } from './secureClient';
import { getIdentity } from './deviceIdentity';
import { createRelaySocketFactory } from './relaySocket';
import type { BackgroundTarget } from './backgroundState';
function endpoint(origin: string, relay = false): URL {
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invalid background service address');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = relay ? '/api/federation/relay' : '/api/federation/secure';
  url.search = ''; url.hash = ''; return url;
}
/** Reuse the paired identity and saved pins, including authorized relay tickets. */
export async function connectBackgroundTarget(target: BackgroundTarget): Promise<SecureClient> {
  const identity = await getIdentity();
  for (const address of target.addresses.slice(0, 5)) {
    try { return await connect({ url: endpoint(address).href, identity, targetPeerId: target.targetPeerId, signal: AbortSignal.timeout(3000) }); }
    catch { /* Try only saved addresses and approved entries. */ }
  }
  for (const route of target.routes.slice(0, 4)) {
    let entry: SecureClient | undefined;
    try {
      entry = await connect({ url: endpoint(route.url).href, identity, targetPeerId: route.targetPeerId, signal: AbortSignal.timeout(3000) });
      const ticket = await entry.request({ type: 'route-ticket', serviceId: target.targetPeerId }, { timeoutMs: 3000 });
      if (typeof ticket.routeToken !== 'string') continue;
      const url = endpoint(route.url, true); url.searchParams.set('routeToken', ticket.routeToken);
      return await connect({ url: url.href, identity, targetPeerId: target.targetPeerId, socketFactory: createRelaySocketFactory(target.targetPeerId), signal: AbortSignal.timeout(5000) });
    } catch { /* No plaintext fallback. */ }
    finally { entry?.close(); }
  }
  throw new Error('Background encrypted service unavailable');
}
