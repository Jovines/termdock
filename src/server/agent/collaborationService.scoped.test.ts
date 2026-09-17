import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity } from '../federation/secureProtocol.js';
import { CollaborationStore } from './collaborationStore.js';
import { CollaborationService } from './collaborationService.js';
import { remoteSession, type CollaborationNode, type CollaborationPeerTransport } from './collaborationPeerTransport.js';
import type { Packet } from '../federation/packets.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** The service that shared a write invitation exposes exactly the granted
 * sessions to the recipient's service, and nothing else. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'td-scoped-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const [self, peer, device] = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
  const selfOrigin = 'https://self.test', peerOrigin = 'https://peer.test';
  const store = new CollaborationStore(join(dir, 'groups.json'));
  const sessions = [{ sessionId: 'granted', name: 'Granted', cwd: '', status: 'shell', capability: '', updatedAt: 1, agent: null },
    { sessionId: 'private', name: 'Private', cwd: '', status: 'shell', capability: '', updatedAt: 1, agent: null }];
  let deviceScope: string[] = ['granted'];
  const service = new CollaborationService({
    file: join(dir, 'services.json'), store, sessions: () => sessions, node: () => ({ serviceId: self.peerId }),
    deviceScope: subject => subject === device.peerId ? deviceScope : [],
    transport: { registeredNodes: () => [], configure: () => {} } as unknown as CollaborationPeerTransport,
    connect: async () => { throw new Error('UNREACHABLE'); },
  });
  const peerNode: CollaborationNode = { serviceId: peer.peerId, origin: peerOrigin };
  const selfNode: CollaborationNode = { serviceId: self.peerId, origin: selfOrigin };
  const remote = remoteSession(peerOrigin, 'remote-agent');
  store.mergeFederatedGroup({ id: 'cross-scoped', name: 'Scoped', federated: true, createdAt: 1, updatedAt: 1,
    sessionIds: ['granted', remote],
    remoteSessions: [{ sessionId: remote, serviceOrigin: peerOrigin, serviceLabel: peerOrigin, name: 'Remote', cwd: '', status: 'shell', capability: '', currentTask: '', updatedAt: 1, backendSessionId: null, agentNativeSessionId: null, agent: null }] });
  store.mergeFederatedGroup({ id: 'cross-private', name: 'Private', federated: true, createdAt: 1, updatedAt: 1,
    sessionIds: ['private', remote],
    remoteSessions: [{ sessionId: remote, serviceOrigin: peerOrigin, serviceLabel: peerOrigin, name: 'Remote', cwd: '', status: 'shell', capability: '', currentTask: '', updatedAt: 1, backendSessionId: null, agentNativeSessionId: null, agent: null }] });
  return { service, store, devices: { device: device.peerId }, peerNode, selfNode, peerId: peer.peerId, selfOrigin, remote,
    setDeviceScope: (scope: string[]) => { deviceScope = scope; } };
}

const wire = (service: CollaborationService, peerId: string, payload: Record<string, unknown>) => service.receive(peerId, { type: 'collaboration-service', id: 'test', ...payload } as Packet);

describe('session-scoped collaboration peers', () => {
  it('registers a peer from a device write grant and exposes only the granted sessions and groups', async () => {
    const f = await fixture();
    expect(f.service.registerScopedPeer(f.selfOrigin, f.devices.device, f.peerNode, ['granted'])).toMatchObject({ ok: true, peer: f.peerId, sessions: ['granted'] });
    const directory = wire(f.service, f.peerId, { action: 'directory' }) as { sessions: { sessionId: string }[]; groups: { id: string }[]; nodes: CollaborationNode[] };
    expect(directory.sessions.map(session => session.sessionId)).toEqual(['granted']);
    expect(directory.groups.map(group => group.id)).toEqual(['cross-scoped']);
    expect(directory.nodes).toEqual([{ serviceId: f.selfNode.serviceId, origin: f.selfOrigin }, f.peerNode]);
  });

  it('rejects a group that pulls in a local session outside the grant', async () => {
    const f = await fixture();
    f.service.registerScopedPeer(f.selfOrigin, f.devices.device, f.peerNode, ['granted']);
    const canonical = { id: 'cross-attack', name: 'Attack', federated: true, createdAt: 2, updatedAt: 2,
      sessionIds: [remoteSession(f.selfOrigin, 'private'), f.remote] };
    expect(() => wire(f.service, f.peerId, { action: 'group', group: canonical, nodes: [f.selfNode, f.peerNode] })).toThrow('SESSION_SCOPE_DENIED');
    const allowed = { ...canonical, id: 'cross-ok', sessionIds: [remoteSession(f.selfOrigin, 'granted'), f.remote] };
    expect(() => wire(f.service, f.peerId, { action: 'group', group: allowed, nodes: [f.selfNode, f.peerNode] })).not.toThrow();
  });

  it('empties the peer surface as soon as the device grants no longer include the session', async () => {
    const f = await fixture();
    f.service.registerScopedPeer(f.selfOrigin, f.devices.device, f.peerNode, ['granted']);
    f.setDeviceScope([]);
    const directory = wire(f.service, f.peerId, { action: 'directory' }) as { sessions: unknown[]; groups: unknown[] };
    expect(directory.sessions).toEqual([]); expect(directory.groups).toEqual([]);
    const canonical = { id: 'cross-late', name: 'Late', federated: true, createdAt: 3, updatedAt: 3,
      sessionIds: [remoteSession(f.selfOrigin, 'granted'), f.remote] };
    expect(() => wire(f.service, f.peerId, { action: 'group', group: canonical, nodes: [f.selfNode, f.peerNode] })).toThrow('SESSION_SCOPE_DENIED');
  });

  it('never downgrades an already authorized directory peer', async () => {
    const f = await fixture();
    f.service.connectKnown(f.selfOrigin, [f.selfNode, f.peerNode]);
    f.service.registerScopedPeer(f.selfOrigin, f.devices.device, f.peerNode, ['granted']);
    const directory = wire(f.service, f.peerId, { action: 'directory' }) as { sessions: { sessionId: string }[] };
    expect(directory.sessions.map(session => session.sessionId).sort()).toEqual(['granted', 'private']);
  });

  it('hides scoped peers entirely from the local collaboration directory', async () => {
    const f = await fixture();
    f.service.registerScopedPeer(f.selfOrigin, f.devices.device, f.peerNode, ['granted']);
    const directory = f.service.directory();
    expect(directory.sessions.filter(session => session.serviceOrigin === 'https://peer.test')).toEqual([]);
  });
});
