import { markEncryptedRequest } from '../federation/requestContext.js';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity } from '../federation/secureProtocol.js';
import { CollaborationStore } from './collaborationStore.js';
import { assertPeerRegistrationAuthority, CollaborationPeerTransport, remoteSession, type CollaborationNode } from './collaborationPeerTransport.js';
import type { Packet } from '../federation/packets.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks(); });
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'td-peer-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const ids = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
  const nodes: CollaborationNode[] = ids.map((identity, index) => ({ serviceId: identity.peerId, origin: `https://node${index}.test` }));
  const stores = nodes.map((_, index) => new CollaborationStore(join(dir, `${index}.json`)));
  const deliveries = nodes.map(() => vi.fn());
  const transports: CollaborationPeerTransport[] = [];
  let offline = false, loseReceipt = false;
  for (let index = 0; index < 3; index++) {
    stores[index].mergeFederatedGroup({ id: 'cross-test', name: 'Test', federated: true, createdAt: 1, updatedAt: 1,
      sessionIds: nodes.map((node, n) => n === index ? 'agent' : remoteSession(node.origin, 'agent')),
      remoteSessions: nodes.flatMap((node, n) => n === index ? [] : [{ sessionId: remoteSession(node.origin, 'agent'), serviceOrigin: node.origin,
        serviceLabel: node.origin, name: 'Agent', cwd: '', status: 'shell', capability: '', currentTask: '', updatedAt: 1, backendSessionId: null, agentNativeSessionId: null, agent: null }]) });
    const transport = new CollaborationPeerTransport({ file: join(dir, `peers${index}.json`), serviceId: nodes[index].serviceId, store: stores[index],
      connect: async peer => {
        if (offline) throw new Error('OFFLINE');
        const target = nodes.findIndex(node => node.serviceId === peer.serviceId);
        return { closed: false, close() {}, request: async packet => {
          const result = transports[target].receive(nodes[index].serviceId, { ...packet, id: 'rpc' } as Packet);
          if (loseReceipt) { loseReceipt = false; throw new Error('RECEIPT_LOST'); }
          return { ...result, id: 'rpc', type: 'result' };
        } };
      }, deliver: id => {
        const pending = stores[index].inbox(id).filter(message => message.status === 'pending');
        if (pending.length) deliveries[index](pending.map(m => m.id));
        for (const m of pending) { stores[index].setSnapshot(m.id, 'clean screen'); stores[index].markDelivered([m.id]); }
      } });
    transports.push(transport); cleanup.push(() => transport.close());
  }
  return { dir, nodes, stores, transports, deliveries, configure: () => transports.forEach((t, i) => t.configure('cross-test', nodes[i].origin, nodes)),
    setOffline: (value: boolean) => { offline = value; }, loseReceipt: () => { loseReceipt = true; } };
}
describe('server collaboration delivery', () => {
  it('delivers immediately without a browser, syncs terminal facts, and preserves bindings after restart', async () => {
    const f = await setup(); f.configure();
    const [message] = f.stores[0].send({ groupId: 'cross-test', fromSessionId: 'agent', toSessionIds: [remoteSession(f.nodes[1].origin, 'agent')], kind: 'message', content: '任务\n'.repeat(40_000) });
    f.transports[0].wake();
    await vi.waitFor(() => expect(f.stores[0].receipt(message.id)).toMatchObject({ status: 'delivered', snapshot: 'clean screen' }));
    expect(f.deliveries[1]).toHaveBeenCalledTimes(1);
    f.stores[1].markRead([message.id]);
    await new Promise(resolve => setTimeout(resolve, 1050)); f.transports[0].wake();
    await vi.waitFor(() => expect(f.stores[0].receipt(message.id).status).toBe('delivered'));
    expect(JSON.parse(readFileSync(join(f.dir, 'peers0.json'), 'utf8')).bindings).toHaveLength(2);
  });
  it('retries a lost receipt with the same ID without repeating terminal delivery', async () => {
    const f = await setup(); f.configure(); f.loseReceipt();
    const [message] = f.stores[0].send({ groupId: 'cross-test', fromSessionId: 'agent', toSessionIds: [remoteSession(f.nodes[1].origin, 'agent')], kind: 'message', content: 'once' });
    f.transports[0].wake();
    await vi.waitFor(() => expect(f.stores[0].receipt(message.id).last_error).toBe('RECEIPT_LOST'));
    await new Promise(resolve => setTimeout(resolve, 550)); f.transports[0].wake();
    await vi.waitFor(() => expect(f.stores[0].receipt(message.id).status).toBe('delivered'));
    expect(f.deliveries[1]).toHaveBeenCalledTimes(1);
    expect(f.stores[1].inbox('agent')).toHaveLength(1);
  });
  it('reports missing registration and offline retries instead of a silent pending', async () => {
    const f = await setup();
    const [message] = f.stores[0].send({ groupId: 'cross-test', fromSessionId: 'agent', toSessionIds: [remoteSession(f.nodes[1].origin, 'agent')], kind: 'message', content: 'queued' });
    f.transports[0].wake(); expect(f.stores[0].receipt(message.id).last_error).toBe('PEER_REGISTRATION_REQUIRED');
    f.setOffline(true); f.configure();
    await vi.waitFor(() => expect(f.stores[0].receipt(message.id)).toMatchObject({ status: 'pending', last_error: 'OFFLINE', attempt_count: 1, next_retry_at: expect.any(Number) }));
    f.setOffline(false); await new Promise(resolve => setTimeout(resolve, 550)); f.transports[0].wake();
    await vi.waitFor(() => expect(f.stores[0].receipt(message.id).status).toBe('delivered'));
  });
  it('denies unknown identities, cross-group traffic, forged senders and removed groups', async () => {
    const f = await setup(); f.configure();
    const request = { type: 'collaboration-exchange', id: 'rpc', groupId: 'cross-test', ids: [] };
    expect(() => f.transports[1].receive('unknown', request)).toThrow('NOT_AUTHORIZED');
    expect(() => f.transports[1].receive(f.nodes[0].serviceId, { ...request, groupId: 'cross-other' })).toThrow('NOT_AUTHORIZED');
    expect(() => f.transports[1].receive(f.nodes[0].serviceId, { ...request, message: { groupId: 'cross-test', fromSessionId: remoteSession(f.nodes[2].origin, 'agent'), toSessionId: 'agent' } })).toThrow('INVALID_PEER_MESSAGE');
    f.stores[1].getGroup('cross-test')!.deleted = true;
    expect(() => f.transports[1].receive(f.nodes[0].serviceId, request)).toThrow('NOT_AUTHORIZED');
  });
  it('delivers rule update notices to remote members once and syncs member traits without a client relay', async () => {
    const f = await setup();
    const rules = f.stores[0].setRules('cross-test', '评审只接非紧急任务', 'agent');
    f.stores[0].setRole({ groupId: 'cross-test', sessionId: remoteSession(f.nodes[1].origin, 'agent'), role: '深度评审，不接急单' });
    f.configure();
    await vi.waitFor(() => expect(f.stores[1].getGroup('cross-test')?.instructions).toMatchObject({ text: rules.text, version: rules.version }));
    expect(f.stores[1].getGroup('cross-test')?.roles?.agent).toBe('深度评审，不接急单');
    await vi.waitFor(() => expect(f.stores[1].inbox('agent')).toHaveLength(1));
    expect(f.stores[1].inbox('agent')[0].content).toContain('群规已更新');
    expect(f.stores[1].inbox('agent')[0].instructions?.version).toBe(rules.version);
    const changed = f.stores[1].setRules('cross-test', '更新验收要求', 'agent', rules.version);
    await new Promise(resolve => setTimeout(resolve, 1100)); f.transports.forEach(t => t.wake());
    await vi.waitFor(() => expect(f.stores[0].getGroup('cross-test')?.instructions?.version).toBe(changed.version));
    await vi.waitFor(() => expect(f.stores[0].inbox('agent')).toHaveLength(1));
    await vi.waitFor(() => expect(f.stores[2].inbox('agent')).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 1100)); f.transports.forEach(t => t.wake());
    await vi.waitFor(() => expect(f.deliveries[2]).toHaveBeenCalledTimes(2));
    expect(f.stores[0].inbox('agent')).toHaveLength(1);
    expect(f.stores[1].inbox('agent')).toHaveLength(1);
    expect(f.stores[2].inbox('agent')).toHaveLength(2);
  });

});

it('requires durable administrator authority for browser peer registration, not temporary open access', () => {
  const authorize = vi.fn(() => ({ allowed: false }));
  const request = { app: { locals: { passwordRuntime: { serviceId: 'service', store: { authorize } } } } } as unknown as Request;
  markEncryptedRequest(request, 'browser');
  expect(() => assertPeerRegistrationAuthority(request)).toThrow('AUTHORIZATION_DENIED');
  authorize.mockReturnValue({ allowed: true });
  expect(() => assertPeerRegistrationAuthority(request)).not.toThrow();
  expect(authorize).toHaveBeenCalledWith({ subjectId: 'browser', serviceId: 'service', action: 'authorization.manage' });
});
