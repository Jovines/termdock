import { describe, it, expect, vi } from 'vitest';
import { CollaborationFederation, qualifySession, sessionAddress, type FederationGroup, type FederationService, type FederationSession } from './collaborationFederation.js';

function fixture(origins = ['https://one.test', 'https://two.test']) {
  const records = origins.map((origin) => ({ origin, connected: true, groups: [] as FederationGroup[], messages: [] as any[],
    sessions: [{ sessionId: 'same-id', name: origin, cwd: '/work', status: 'idle', capability: '', currentTask: '', updatedAt: 1,
      backendSessionId: null, agent: null }] as FederationSession[] }));
  const services: FederationService[] = records.map((record) => ({ origin: record.origin, label: record.origin,
    request: async (route, method, body) => {
      if (!record.connected) throw new Error('offline');
      if (method === 'DELETE') {
        const id = decodeURIComponent(route.split('/').at(-1)!);
        record.groups = record.groups.flatMap((group) => group.id !== id ? [group]
          : group.federated ? [{ ...group, deleted: true, updatedAt: group.updatedAt + 1 }] : []);
      }
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
  it('returns healthy peers when a renderer hangs, ignores late results, and allows retry', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, records, services } = fixture(['https://one.test', 'https://two.test', 'https://three.test']);
      const request = services[2].request;
      let release!: (value: unknown) => void;
      services[2].request = () => new Promise(resolve => { release = resolve; });
      const pending = bridge.peers(records[0].origin);
      await vi.advanceTimersByTimeAsync(18_000);
      const peers = await pending;
      expect(peers.sessions.map(session => session.serviceOrigin)).toEqual([records[1].origin]);
      expect(peers.services[2]).toMatchObject({ connected: false, error: '服务协作目录响应超时' });
      release({ groups: [], sessions: records[2].sessions, messages: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(peers.services[2].connected).toBe(false);
      services[2].request = request;
      const retried = await bridge.peers(records[0].origin);
      expect(retried.services.every(service => service.connected)).toBe(true);
      expect(retried.sessions).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('discovers candidates without forwarding pending messages as a side effect', async () => {
    const { bridge, records } = fixture();
    await bridge.save(records[0].origin, { name: 'Pair', sessionIds: ['same-id', qualifySession(records[1].origin, 'same-id')] });
    await bridge.refresh();
    records[0].messages.push({ id: 'pending', groupId: records[0].groups[0].id, fromSessionId: 'same-id',
      toSessionId: qualifySession(records[1].origin, 'same-id'), status: 'pending' });
    const peers = await bridge.peers(records[0].origin);
    await bridge.list(records[0].origin);
    expect(peers).toMatchObject({ protocolVersion: 2, origin: records[0].origin });
    expect(peers.sessions.map((session) => session.sessionId)).toEqual([qualifySession(records[1].origin, 'same-id')]);
    expect(records[1].messages).toEqual([]);
    await bridge.refresh();
    expect(records[1].messages).toHaveLength(1);
  });

  it('validates new local members against the current response even when the federation snapshot is empty', async () => {
    const { records, services } = fixture();
    const request = services[0].request;
    services[0].request = async (route, method, body) => {
      const result = await request(route, method, body) as object;
      return route === '/collaboration-federation' && method !== 'POST' ? { ...result, sessions: [] } : result;
    };
    const bridge = new CollaborationFederation(() => services);
    await bridge.save(records[0].origin, { name: 'Pair', sessionIds: ['same-id', qualifySession(records[1].origin, 'same-id')] });
    await bridge.refresh();
    expect(records[0].groups[0].sessionIds).toEqual(['same-id', qualifySession(records[1].origin, 'same-id')]);
    records[1].connected = false;
    await expect(bridge.save(records[0].origin, { name: 'Unavailable', sessionIds: ['same-id', qualifySession(records[1].origin, 'same-id')] }))
      .rejects.toThrow('服务不可达');
    expect(records[0].groups).toHaveLength(1);
  });

  it('rejects a stale edit before changing the durable source group', async () => {
    const { bridge, records } = fixture();
    const result = await bridge.save(records[0].origin, { name: 'Pair', sessionIds: ['same-id', qualifySession(records[1].origin, 'same-id')] }) as { group: FederationGroup };
    await bridge.refresh();
    await expect(bridge.save(records[0].origin, { id: result.group.id, name: 'Stale', sessionIds: result.group.sessionIds,
      expectedUpdatedAt: result.group.updatedAt - 1 })).rejects.toThrow('协作组已被修改');
    expect(records[0].groups[0].name).toBe('Pair');
  });

  it('uses fresh local sessions when a reachable federation snapshot is empty or stale', async () => {
    const { records, services } = fixture();
    const request = services[0].request;
    services[0].request = async (route, method, body) => {
      const result = await request(route, method, body) as { sessions: FederationSession[] };
      return route === '/collaboration-federation' ? { ...result, sessions: [] } : result;
    };
    const bridge = new CollaborationFederation(() => services);
    const listed = await bridge.list(records[0].origin);
    expect(listed.sessions).toContainEqual(records[0].sessions[0]);
    expect(listed.sessions.map((session) => session.sessionId)).toEqual([
      qualifySession(records[1].origin, 'same-id'), 'same-id',
    ]);
    records[0].sessions = [];
    expect((await bridge.list(records[0].origin)).sessions.map((session) => session.sessionId))
      .toEqual([qualifySession(records[1].origin, 'same-id')]);
  });

  it('disambiguates identical IDs, persists replicas, and restores through a new desktop process', async () => {
    const { bridge, records, services } = fixture();
    const remote = qualifySession(records[1].origin, 'same-id');
    expect(sessionAddress(remote)).toEqual({ origin: records[1].origin, id: 'same-id' });
    const result = await bridge.save(records[0].origin, { name: 'Pair', sessionIds: ['same-id', remote] }) as { group: FederationGroup };
    await bridge.refresh();
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
    await bridge.refresh();
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
    await bridge.refresh();
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
    await bridge.refresh();
    records[1].connected = false;
    await bridge.remove(records[0].origin, records[0].groups[0].id);
    records[1].connected = true;
    await bridge.refresh();
    const result = await bridge.list(records[1].origin);
    expect(result.groups).toHaveLength(0);
    expect(records[1].groups[0].deleted).toBe(true);
  });
});

it('provisions public server identities once and leaves upgraded peer message delivery to the servers', async () => {
  const f = fixture();
  const registrations: unknown[] = [];
  for (const [index, service] of f.services.entries()) {
    const original = service.request;
    service.request = async (route, method, body) => {
      if (route === '/collaboration-peers') { registrations.push(body); return { ok: true }; }
      return { ...await original(route, method, body) as object, serverTransport: { serviceId: `node-${index}` } };
    };
  }
  await f.bridge.save(f.records[0].origin, { name: 'Pair', sessionIds: ['same-id', qualifySession(f.records[1].origin, 'same-id')] });
  await f.bridge.refresh();
  expect(registrations).toHaveLength(2);
  const registrationCount = registrations.length;
  f.records[0].messages.push({ id: 'server-owned', groupId: f.records[0].groups[0].id, fromSessionId: 'same-id',
    toSessionId: qualifySession(f.records[1].origin, 'same-id'), status: 'pending', content: 'server sends this' });
  await f.bridge.refresh();
  expect(registrations).toHaveLength(registrationCount);
  expect(f.records[1].messages).toHaveLength(0);
  expect(registrations[0]).toMatchObject({ nodes: [{ serviceId: 'node-0', origin: f.records[0].origin }, { serviceId: 'node-1', origin: f.records[1].origin }] });
});
