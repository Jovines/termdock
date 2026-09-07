import { describe, it, expect } from 'vitest';
import { CollaborationFederation, qualifySession, sessionAddress, type FederationGroup, type FederationService, type FederationSession } from './collaborationFederation.js';

function fixture(origins = ['https://one.test', 'https://two.test']) {
  const records = origins.map((origin) => ({ origin, connected: true, groups: [] as FederationGroup[], messages: [] as any[],
    sessions: [{ sessionId: 'same-id', name: origin, cwd: '/work', status: 'idle', capability: '', currentTask: '', updatedAt: 1,
      backendSessionId: null, agent: null }] as FederationSession[] }));
  const services: FederationService[] = records.map((record) => ({ origin: record.origin, label: record.origin,
    request: async (route, method, body) => {
      if (!record.connected) throw new Error('offline');
      if (method === 'POST') {
        const payload = structuredClone(body) as { group: FederationGroup; messages: any[] };
        const existing = record.groups.find((group) => group.id === payload.group.id);
        if (!existing || payload.group.updatedAt >= existing.updatedAt) record.groups = [...record.groups.filter((group) => group.id !== payload.group.id), payload.group];
        for (const message of payload.messages) {
          const previous = record.messages.find((item) => item.id === message.id);
          const rank = { pending: 0, delivered: 1, read: 2 } as Record<string, number>;
          if (!previous || rank[message.status] > rank[previous.status]) record.messages = [...record.messages.filter((item) => item.id !== message.id), message];
        }
      }
      return structuredClone({ groups: record.groups.filter((group) => route !== '/collaboration-groups' || !group.deleted), sessions: record.sessions, messages: record.messages });
    },
  }));
  return { records, services, bridge: new CollaborationFederation(() => services) };
}

describe('cross-service collaboration transport', () => {
  it('disambiguates identical IDs, persists replicas, and restores through a new desktop process', async () => {
    const { bridge, records, services } = fixture();
    const remote = qualifySession(records[1].origin, 'same-id');
    expect(sessionAddress(remote)).toEqual({ origin: records[1].origin, id: 'same-id' });
    const result = await bridge.save(records[0].origin, { name: 'Pair', sessionIds: ['same-id', remote] }) as { group: FederationGroup };
    expect(records[0].groups[0].sessionIds).toEqual(['same-id', remote]);
    expect(records[1].groups[0].sessionIds).toEqual([qualifySession(records[0].origin, 'same-id'), 'same-id']);
    const restored = await new CollaborationFederation(() => services).list(records[1].origin);
    expect(restored.groups[0].id).toBe(result.group.id);
    expect(new Set(restored.sessions.map((session) => session.sessionId)).size).toBe(2);
    expect(restored.groups[0].remoteSessions?.[0].agentNativeSessionId).toBeNull();
  });

  it('keeps messages pending on disconnect, retries once on reconnect, and propagates receipts', async () => {
    const { bridge, records } = fixture();
    await bridge.save(records[0].origin, { name: 'Pair', sessionIds: ['same-id', qualifySession(records[1].origin, 'same-id')] });
    records[1].connected = false;
    records[0].messages.push({ id: 'message', groupId: records[0].groups[0].id,
      fromSessionId: 'same-id', toSessionId: qualifySession(records[1].origin, 'same-id'), status: 'pending', content: 'hello' });
    await bridge.refresh();
    expect(records[0].groups[0].remoteSessions?.[0].serviceConnected).toBe(false);
    expect(records[1].messages).toHaveLength(0);
    records[1].connected = true;
    await bridge.refresh();
    await bridge.refresh();
    expect(records[1].messages).toHaveLength(1);
    expect(records[1].messages[0]).toMatchObject({ id: 'message', fromSessionId: qualifySession(records[0].origin, 'same-id'), toSessionId: 'same-id', status: 'pending' });
    records[1].messages[0].status = 'read';
    await bridge.refresh();
    expect(records[0].messages[0].status).toBe('read');
  });

  it('does not copy group messages to an unrelated connected service', async () => {
    const { bridge, records } = fixture(['https://one.test', 'https://two.test', 'https://unrelated.test']);
    await bridge.save(records[0].origin, { name: 'Pair', sessionIds: ['same-id', qualifySession(records[1].origin, 'same-id')] });
    records[0].messages.push({ id: 'private-message', groupId: records[0].groups[0].id,
      fromSessionId: 'same-id', toSessionId: qualifySession(records[1].origin, 'same-id'), status: 'pending' });
    await bridge.refresh();
    expect(records[2].groups).toEqual([]);
    expect(records[2].messages).toEqual([]);
    expect((await bridge.list(records[2].origin)).groups).toEqual([]);
  });

  it('propagates deletion after an offline service returns without resurrecting the group', async () => {
    const { bridge, records } = fixture();
    await bridge.save(records[0].origin, { name: 'Pair', sessionIds: ['same-id', qualifySession(records[1].origin, 'same-id')] });
    records[1].connected = false;
    await bridge.remove(records[0].origin, records[0].groups[0].id);
    records[1].connected = true;
    const result = await bridge.list(records[1].origin);
    expect(result.groups).toHaveLength(0);
    expect(records[1].groups[0].deleted).toBe(true);
  });
});
