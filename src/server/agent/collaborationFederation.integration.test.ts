import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationFederation, qualifySession, type FederationService } from '../../../desktop/collaborationFederation.js';
import { CollaborationStore } from './collaborationStore.js';
import type { MessageFragment, TransportDiagnostic } from './collaborationProtocol.js';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-collab-bridge-')); directories.push(directory);
  const nodes = ['https://one.test', 'https://two.test', 'https://unrelated.test'].map((origin, index) => ({ origin, file: path.join(directory, `${index}.json`),
    store: new CollaborationStore(path.join(directory, `${index}.json`)), connected: true, version: 2, fragments: 0, failAt: -1 }));
  const services: FederationService[] = nodes.map((node) => ({ origin: node.origin, label: node.origin,
    request: async (_route, method, input) => {
      if (!node.connected) throw new Error('disconnected');
      const sessions = ['generic', 'second'].map((sessionId) => ({ sessionId, name: 'Generic adapter', cwd: '', status: 'shell', capability: '', currentTask: '', updatedAt: 1, backendSessionId: null, agent: null }));
      if (_route === '/collaboration-groups' && method !== 'POST') return { groups: node.store.list(), sessions, capabilities: { groupPromotion: 1 } };
      if (_route.endsWith('/promote') && method === 'POST') {
        const body = input as { group: Parameters<CollaborationStore['promoteGroup']>[1]; expectedUpdatedAt: number };
        return { group: node.store.promoteGroup(decodeURIComponent(_route.split('/')[2]), body.group, body.expectedUpdatedAt) };
      }
      let fragmentReceipts: unknown[] = [];
      if (method === 'POST') {
        const body = input as { group: Parameters<CollaborationStore['mergeFederatedGroup']>[0]; messages: Parameters<CollaborationStore['mergeFederatedMessages']>[0]; fragments?: MessageFragment[];
          transport?: Array<{ message_id: string; diagnostic: TransportDiagnostic; failure_reason?: string }> };
        node.store.mergeFederatedGroup(body.group); node.store.mergeFederatedMessages(body.messages);
        fragmentReceipts = (body.fragments ?? []).map((fragment) => {
          node.fragments++;
          if (node.fragments === node.failAt) throw new Error('link dropped mid-message');
          return node.store.acceptFragment(fragment);
        });
        for (const entry of body.transport ?? []) { node.store.recordTransport(entry.message_id, entry.diagnostic); if (entry.failure_reason) node.store.fail(entry.message_id, entry.failure_reason); }
      }
      return { protocolVersion: node.version, ...node.store.federationSnapshot(), fragmentReceipts,
        sessions };
    } }));
  return { nodes, services, bridge: new CollaborationFederation(() => services) };
}

describe('real stores over the desktop collaboration bridge', () => {
  it('promotes a local group without copying or deleting its history in separate requests', async () => {
    const { nodes, services, bridge } = setup();
    const original = nodes[0].store.save({ name: 'Original', sessionIds: ['generic', 'second'] });
    const [message] = nodes[0].store.send({ groupId: original.id, fromSessionId: 'generic', toSessionIds: ['second'], kind: 'ask', content: 'Preserve' });
    const request = vi.spyOn(services[0], 'request');
    const result = await bridge.save(nodes[0].origin, { id: original.id, name: 'Promoted', expectedUpdatedAt: original.updatedAt,
      sessionIds: ['generic', 'second', qualifySession(nodes[1].origin, 'generic')] }) as { group: { id: string } };
    expect(nodes[0].store.getGroup(original.id)).toBeNull();
    expect(nodes[0].store.listMessages(result.group.id).map((item) => item.id)).toEqual([message.id]);
    expect(request.mock.calls.filter(([, method]) => method === 'POST').map(([route]) => route)).toEqual([`/collaboration-groups/${original.id}/promote`]);
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
    await bridge.refresh();
    expect(nodes[1].store.getGroup(result.group.id)).not.toBeNull();
  });

  it('resumes a large fragmented message after both bridge and recipient restart, without partial or duplicate inbox entries', async () => {
    let time = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => time);
    const { nodes, services, bridge } = setup();
    await bridge.save(nodes[0].origin, { name: 'Pair', sessionIds: ['generic', qualifySession(nodes[1].origin, 'generic')] });
    await bridge.refresh();
    const group = nodes[0].store.list()[0];
    const content = '跨服务完整证据\n'.repeat(20_000);
    const [message] = nodes[0].store.send({ groupId: group.id, fromSessionId: 'generic', toSessionIds: [qualifySession(nodes[1].origin, 'generic')], kind: 'task', content, idempotencyKey: 'long-task' });
    nodes[1].failAt = 2;
    await bridge.refresh();
    expect(nodes[1].store.getMessage(message.id)).toBeNull();
    expect(nodes[0].store.receipt(message.id)).toMatchObject({ status: 'pending', attempt_count: 1, fragments_sent: 1, last_error: 'link dropped mid-message' });
    nodes[1].store = new CollaborationStore(nodes[1].file);
    time += 31_000;
    const restoredBridge = new CollaborationFederation(() => services);
    await restoredBridge.refresh();
    await restoredBridge.refresh();
    expect(nodes[1].store.inbox('generic')).toHaveLength(1);
    expect(nodes[1].store.getMessage(message.id)?.content).toBe(content);
    expect(nodes[2].store.list()).toEqual([]);
    expect(nodes[2].store.inbox('generic')).toEqual([]);
    nodes[1].store.markRead([message.id]);
    await restoredBridge.refresh();
    expect(nodes[0].store.receipt(message.id)).toMatchObject({ status: 'read', read_semantics: 'explicit' });
  });
  it('reports old-peer incompatibility explicitly, while keeping an offline peer retryable', async () => {
    const { nodes, bridge } = setup();
    await bridge.save(nodes[0].origin, { name: 'Pair', sessionIds: ['generic', qualifySession(nodes[1].origin, 'generic')] });
    await bridge.refresh();
    const group = nodes[0].store.list()[0];
    nodes[1].connected = false;
    const [message] = nodes[0].store.send({ groupId: group.id, fromSessionId: 'generic', toSessionIds: [qualifySession(nodes[1].origin, 'generic')], kind: 'message', content: 'x'.repeat(30_000) });
    await bridge.refresh();
    expect(nodes[0].store.receipt(message.id)).toMatchObject({ status: 'pending', peer_reachable: false, last_error: 'PEER_UNREACHABLE' });
    nodes[1].version = 1; nodes[1].connected = true;
    await bridge.refresh();
    expect(nodes[0].store.receipt(message.id)).toMatchObject({ status: 'failed', failure_reason: 'PEER_UPGRADE_REQUIRED' });
    expect(nodes[1].store.getMessage(message.id)).toBeNull();
  });
});
