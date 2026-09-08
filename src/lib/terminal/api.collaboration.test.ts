import { afterEach, describe, expect, it, vi } from 'vitest';
import { listCollaborationGroups, moveCollaborationMember, removeCollaborationGroup, resetCollaborationDirectory, resetCsrfTokenCache,
  saveCollaborationGroup, subscribeCollaborationGroups } from './api';

const session = (sessionId: string, name = 'TraeX') => ({ sessionId, name, cwd: '/work',
  backendSessionId: null, agent: { slug: 'traex-status', displayName: 'TraeX' },
  status: 'ready', capability: '', currentTask: '', updatedAt: 1 });
const local = { groups: [{ id: 'existing', name: 'Original', sessionIds: ['one', 'two'], createdAt: 1, updatedAt: 2 }],
  sessions: [session('one'), session('two')] };
function setup(bridge?: Record<string, unknown>) {
  vi.stubGlobal('window', { location: { origin: 'https://current.test' }, termdockDesktop: bridge });
  const fetch = vi.fn(async (path: string, init?: RequestInit) => new Response(JSON.stringify(
    path === '/api/csrf-token' ? { csrfToken: 'test' }
      : init?.method === 'POST' ? { group: { ...local.groups[0], ...JSON.parse(String(init.body)) } } : local),
    init?.method === 'DELETE' ? { status: 200 } : undefined));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => { resetCollaborationDirectory(); resetCsrfTokenCache(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('desktop collaboration compatibility', () => {
  it('loads current sessions even when the old bridge returns an empty list', async () => {
    const fetch = setup({ collaborationList: async () => ({ groups: [], sessions: [] }) });
    expect(await listCollaborationGroups()).toMatchObject(local);
    expect(fetch).toHaveBeenCalledWith('/api/terminal/operations/collaboration-groups', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it('accepts only peer sessions from legacy bridges and never their stale local groups', async () => {
    const remote = session('remote:https%3A%2F%2Fpeer.test:one');
    setup({ collaborationList: async () => ({ groups: [{ ...local.groups[0], name: 'Wrong', updatedAt: 99 }],
      sessions: [session('one', 'Stale'), session('removed'), remote] }) });
    const update = vi.fn(); const unsubscribe = subscribeCollaborationGroups(update);
    try {
      await listCollaborationGroups();
      await vi.waitFor(() => expect(update.mock.lastCall?.[0].peers.state).toBe('ready'));
      expect(update.mock.lastCall?.[0]).toMatchObject({ groups: local.groups, sessions: [remote, ...local.sessions] });
    } finally { unsubscribe(); }
  });
  it('works without a bridge and with rejected or stuck legacy bridges', async () => {
    for (const collaborationList of [undefined, async () => { throw new Error('old preload failed'); }, () => new Promise(() => {})]) {
      setup(collaborationList ? { collaborationList } : undefined);
      expect(await listCollaborationGroups()).toMatchObject(local);
      resetCollaborationDirectory();
    }
  });
  it('uses versioned peer discovery without calling the legacy aggregator', async () => {
    const legacy = vi.fn();
    const peers = vi.fn(async () => ({ protocolVersion: 2, origin: 'https://current.test', sessions: [] }));
    setup({ collaboration: { protocolVersion: 2, peers: true, save: true }, collaborationPeers: peers, collaborationList: legacy });
    await listCollaborationGroups();
    expect(peers).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
  });
  it('respects an explicit disabled peer capability instead of guessing from a legacy method', async () => {
    const legacy = vi.fn();
    setup({ collaboration: { protocolVersion: 2, peers: false, save: false }, collaborationList: legacy });
    expect(await listCollaborationGroups()).toMatchObject({ ...local, peers: { state: 'unavailable' } });
    expect(legacy).not.toHaveBeenCalled();
  });
  it('propagates current-service failures and permits a later retry', async () => {
    const fetch = setup({ collaborationList: async () => ({ groups: [], sessions: [session('stale')] }) });
    fetch.mockRejectedValueOnce(new Error('disconnected'));
    await expect(listCollaborationGroups()).rejects.toThrow('disconnected');
    expect(await listCollaborationGroups()).toMatchObject(local);
  });
});

describe('collaboration mutation ownership', () => {
  it('creates and edits local groups through the page even with a broken old preload', async () => {
    const native = vi.fn().mockRejectedValue(new Error('old bridge'));
    const fetch = setup({ collaborationSave: native });
    const input = { name: 'Local', sessionIds: ['one', 'two'] };
    await saveCollaborationGroup(input);
    await saveCollaborationGroup({ ...input, id: 'existing', expectedUpdatedAt: 2 });
    expect(native).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
  });
  it('retains offline existing members but refuses new missing members instead of filtering them out', async () => {
    const fetch = setup();
    fetch.mockImplementation(async (path, init) => new Response(JSON.stringify(path === '/api/csrf-token' ? { csrfToken: 'test' }
      : init?.method === 'POST' ? { group: local.groups[0] } : { ...local, sessions: [session('one')] })));
    await saveCollaborationGroup({ ...local.groups[0], expectedUpdatedAt: 2 });
    await expect(saveCollaborationGroup({ name: 'New', sessionIds: ['one', 'missing', 'another'] })).rejects.toThrow('所选会话已变化');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('rejects deleted groups and stale member edits before any write', async () => {
    const fetch = setup();
    await expect(saveCollaborationGroup({ ...local.groups[0], expectedUpdatedAt: 1 })).rejects.toThrow('协作组已被修改');
    await expect(saveCollaborationGroup({ ...local.groups[0], id: 'deleted' })).rejects.toThrow('协作组已删除');
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('uses a legacy bridge only to add new remote members and never falls back after a failed write', async () => {
    const native = vi.fn().mockRejectedValue(new Error('write result unknown'));
    const fetch = setup({ collaborationSave: native });
    const input = { name: 'Cross', sessionIds: ['one', 'remote:https%3A%2F%2Fpeer.test:one'] };
    await expect(saveCollaborationGroup(input)).rejects.toThrow('write result unknown');
    expect(native).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('limits an incompatible declared protocol to current-service actions', async () => {
    const native = vi.fn();
    setup({ collaboration: { protocolVersion: 99, peers: true, save: true }, collaborationSave: native });
    await saveCollaborationGroup({ name: 'Local', sessionIds: ['one', 'two'] });
    await expect(saveCollaborationGroup({ name: 'Cross', sessionIds: ['one', 'remote:https%3A%2F%2Fpeer.test:one'] })).rejects.toThrow('支持协作的 Mac 客户端');
    expect(native).not.toHaveBeenCalled();
  });
  it('refuses unsafe two-step transfers on an old service and uses one write when supported', async () => {
    const fetch = setup();
    const input = { sourceGroupId: 'source', targetGroupId: 'target', sessionId: 'one', expectedSourceUpdatedAt: 1, expectedTargetUpdatedAt: 1 };
    await expect(moveCollaborationMember(input)).rejects.toThrow('原成员关系未修改');
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fetch.mockResolvedValueOnce(Response.json({ ...local, capabilities: { groupMove: 1 } }));
    await moveCollaborationMember(input);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path))
      .toEqual(['/api/terminal/operations/collaboration-groups/move-member']);
  });

  it('does not let an old bridge partially promote an existing local group', async () => {
    const native = vi.fn(); const fetch = setup({ collaborationSave: native });
    await expect(saveCollaborationGroup({ id: 'existing', name: 'Promote', sessionIds: ['one', 'two', 'remote:https%3A%2F%2Fpeer.test:one'] }))
      .rejects.toThrow('原组和记录均未修改');
    expect(native).not.toHaveBeenCalled(); expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('deletes federated groups on their current durable replica without calling preload', async () => {
    const native = vi.fn(); const fetch = setup({ collaborationRemove: native });
    await removeCollaborationGroup('cross-existing');
    expect(fetch).toHaveBeenCalledWith('/api/terminal/operations/collaboration-groups/cross-existing', expect.objectContaining({ method: 'DELETE' }));
    expect(native).not.toHaveBeenCalled();
  });
});
