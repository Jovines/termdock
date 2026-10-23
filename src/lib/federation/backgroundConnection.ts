import { RELAY_CLIENT_CONNECT_TIMEOUT_MS } from '../../server/federation/streamLimits';
import { directConnectionAddresses, relayConnectionRoutes, serviceEndpoint } from '../../server/federation/connectionModel';
import { connect, type SecureClient } from './secureClient';
import { getIdentity } from './deviceIdentity';
import { createRelaySocketFactory } from './relaySocket';
import type { BackgroundTarget } from './backgroundState';
import { raceConnectionAttempts, type ConnectionAttempt } from './connectionAttempts';
import { readDeviceAuthorization } from './deviceAuthorization';
import { connectionAccessError, relayAuthorizationError } from './accessFailure';
/** Reuse the paired identity and saved pins, including authorized relay tickets. */
export async function connectBackgroundTarget(target: BackgroundTarget): Promise<SecureClient> {
  const identity = await getIdentity();
  const record = { url: '', targetPeerId: target.targetPeerId, routes: target.routes };
  const routes = relayConnectionRoutes(record);
  const addresses = new Set([...directConnectionAddresses(record), ...target.addresses.slice(0, 5).flatMap(url => directConnectionAddresses({ ...record, url }))]);
  const validate = async (client: SecureClient, signal: AbortSignal) => {
    const abort = () => client.close(); signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) throw signal.reason;
      await readDeviceAuthorization(client, { timeoutMs: 3000 });
      if (signal.aborted) throw signal.reason;
      return client;
    } catch (error) { client.close(); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  };
  const attempts: ConnectionAttempt<SecureClient>[] = [...addresses].map(address => ({ key: `direct:${address}`, run: async signal => {
    try {
      const client = await connect({ url: serviceEndpoint(address).href, identity, targetPeerId: target.targetPeerId, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      return await validate(client, signal);
    } catch (error) { throw connectionAccessError(error, { targetServiceId: target.targetPeerId }) || error; }
  } }));
  for (const route of routes) attempts.push({ key: `relay:${route.targetPeerId}:${route.url}`, run: async signal => {
    let entry: SecureClient | undefined;
    const context = { targetServiceId: target.targetPeerId, entryServiceId: route.targetPeerId, entryUrl: route.url };
    try {
      entry = await connect({ url: serviceEndpoint(route.url).href, identity, targetPeerId: route.targetPeerId, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      const ticket = await entry.request({ type: 'route-ticket', serviceId: target.targetPeerId }, { timeoutMs: 3000 }).catch(error => { throw relayAuthorizationError(error, context); });
      if (signal.aborted) throw signal.reason;
      if (typeof ticket.routeToken !== 'string') throw new Error('Invalid relay ticket');
      const url = serviceEndpoint(route.url, 'relay'); url.searchParams.set('routeToken', ticket.routeToken);
      const client = await connect({ url: url.href, identity, targetPeerId: target.targetPeerId, socketFactory: createRelaySocketFactory(target.targetPeerId, context), signal: AbortSignal.any([signal, AbortSignal.timeout(RELAY_CLIENT_CONNECT_TIMEOUT_MS)]) });
      return await validate(client, signal);
    } catch (error) { throw connectionAccessError(error, context) || error; }
    finally { entry?.close(); }
  } });
  return (await raceConnectionAttempts(attempts, client => client.close())).value;
}
