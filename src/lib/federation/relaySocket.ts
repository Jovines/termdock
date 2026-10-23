import { RelayTransport, type RelayWireSocket } from '../../server/federation/relayTransport.js';
import type { AccessFailureContext } from './accessFailure';

/** Browser adapter; the protocol state machine is also used by Node peers. */
export class RelaySocket extends RelayTransport {
  constructor(url: string, targetServiceId: string, socketFactory: (url: string) => RelayWireSocket = url => new WebSocket(url), context: AccessFailureContext = {}) {
    super(url, targetServiceId, socketFactory, context);
  }
}
export function createRelaySocketFactory(targetServiceId: string, context: AccessFailureContext = {}): (url: string) => WebSocket {
  return url => new RelaySocket(url, targetServiceId, undefined, context) as unknown as WebSocket;
}
