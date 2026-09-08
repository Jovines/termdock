import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationDirectory, remoteSessionAddress, type CollaborationDirectoryData, type CollaborationPeers } from './directory';

const localSession = { sessionId: 'one', name: 'TraeX', cwd: '/repo', backendSessionId: null,
  agent: { slug: 'traex-status', displayName: 'TraeX' }, status: 'ready', capability: '', currentTask: '', updatedAt: 1 };
const remoteSession = { ...localSession, sessionId: 'remote:https%3A%2F%2Fpeer.test:one', serviceOrigin: 'https://peer.test', serviceConnected: true };
const local = { groups: [{ id: 'original', name: 'Team', sessionIds: ['one', 'two'], createdAt: 1, updatedAt: 1 }], sessions: [localSession] };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const instances: CollaborationDirectory[] = [];
function create(readPeers?: () => Promise<CollaborationPeers>, readLocal = vi.fn(async () => local)) {
  const directory = new CollaborationDirectory({ origin: 'https://current.test', readLocal, readPeers });
  instances.push(directory); return directory;
}
afterEach(() => { instances.forEach((directory) => directory.dispose()); instances.length = 0; vi.useRealTimers(); });

describe('collaboration directory ownership and discovery', () => {
  it('renders local data immediately while peers are still pending, then publishes their arrival', async () => {
    const pending = deferred<CollaborationPeers>();
    const directory = create(() => pending.promise);
    const updates: CollaborationDirectoryData[] = [];
    directory.subscribe((data) => updates.push(data));
    expect(await directory.load()).toMatchObject({ ...local, peers: { state: 'loading' } });
    pending.resolve({ sessions: [remoteSession, { ...localSession, name: 'Stale' }],
      services: [{ origin: 'https://peer.test', label: 'Peer', connected: true }] });
    await vi.waitFor(() => expect(updates.at(-1)?.peers?.state).toBe('ready'));
    expect(updates.at(-1)?.sessions).toEqual([remoteSession, localSession]);
    expect(updates.at(-1)?.groups).toEqual(local.groups);
  });
  it('shares reads and never lets a dead peer make local discovery empty', async () => {
    const read = vi.fn(async () => local);
    const directory = create(async () => { throw new Error('offline'); }, read);
    const first = directory.load();
    expect(directory.load()).toBe(first);
    await first;
    await vi.waitFor(() => expect(directory.snapshot()?.peers?.state).toBe('error'));
    expect(directory.snapshot()?.sessions).toEqual(local.sessions);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('preserves persisted remote members without claiming that they are online', async () => {
    const directory = create(undefined, vi.fn(async () => ({ ...local, groups: [{ ...local.groups[0], remoteSessions: [remoteSession] }] })));
    const data = await directory.load();
    expect(data.sessions[0]).toMatchObject({ sessionId: remoteSession.sessionId, status: 'offline', serviceConnected: false });
    expect(data.peers?.state).toBe('unavailable');
  });
  it('does not bring back a group deleted on the current service from a legacy desktop response', async () => {
    const directory = create(async () => ({ sessions: [], groups: local.groups }), vi.fn(async () => ({ groups: [], sessions: [] })));
    await directory.load();
    await vi.waitFor(() => expect(directory.snapshot()?.peers?.state).toBe('ready'));
    expect(directory.snapshot()?.groups).toEqual([]);
  });
  it('marks cached peers offline after a timeout and ignores a late response from that attempt', async () => {
    vi.useFakeTimers();
    const pending = deferred<CollaborationPeers>();
    const read = vi.fn().mockResolvedValueOnce({ sessions: [remoteSession] }).mockReturnValueOnce(pending.promise).mockResolvedValue({ sessions: [] });
    const directory = create(read);
    await directory.load(); await vi.advanceTimersByTimeAsync(0);
    directory.refreshPeers(true); await vi.advanceTimersByTimeAsync(5000);
    expect(directory.snapshot()?.sessions[0]).toMatchObject({ serviceConnected: false });
    directory.refreshPeers(true); await vi.advanceTimersByTimeAsync(0);
    pending.resolve({ sessions: [remoteSession] }); await vi.advanceTimersByTimeAsync(0);
    expect(directory.snapshot()?.sessions).toEqual(local.sessions);
  });
  it('keeps a local failure visible even if peers complete later', async () => {
    const pending = deferred<CollaborationPeers>();
    const read = vi.fn().mockResolvedValueOnce(local).mockRejectedValueOnce(new Error('local offline'));
    const directory = create(() => pending.promise, read);
    const updates = vi.fn(); directory.subscribe(updates);
    await directory.load();
    await expect(directory.load()).rejects.toThrow('local offline');
    updates.mockClear(); pending.resolve({ sessions: [remoteSession] });
    await vi.waitFor(() => expect(directory.snapshot()?.peers?.state).toBe('ready'));
    expect(updates).not.toHaveBeenCalled();
  });
  it('rejects a peer response scoped to another current service', async () => {
    const directory = create(async () => ({ protocolVersion: 2, origin: 'https://wrong.test', sessions: [remoteSession] }));
    await directory.load();
    await vi.waitFor(() => expect(directory.snapshot()?.peers?.state).toBe('error'));
    expect(directory.snapshot()?.sessions).toEqual(local.sessions);
  });
  it('does not apply a read started before a successful mutation', async () => {
    const old = deferred<typeof local>();
    const current = { ...local, groups: [] };
    const directory = create(undefined, vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(current));
    const request = directory.load(); await Promise.resolve();
    directory.invalidate();
    await directory.load(); old.resolve(local);
    expect(await request).toMatchObject(current);
    expect(directory.snapshot()?.groups).toEqual([]);
  });
  it('discards late reads when the page changes service or logs out', async () => {
    const pending = deferred<typeof local>();
    const directory = create(undefined, vi.fn(() => pending.promise));
    const update = vi.fn(); directory.subscribe(update);
    const request = directory.load(); directory.dispose(); pending.resolve(local);
    await expect(request).rejects.toThrow('协作连接已切换');
    expect(update).not.toHaveBeenCalled(); expect(directory.snapshot()).toBeNull();
  });
  it('validates qualified identities and preserves identical IDs on different services', () => {
    expect(remoteSessionAddress(remoteSession.sessionId)).toEqual({ origin: 'https://peer.test', id: 'one' });
    for (const id of ['one', 'remote:bad:one', 'remote:https%3A%2F%2Fa.test%2Fpath:one', 'remote:https%3A%2F%2Fa.test:', 'remote:%:one']) {
      expect(remoteSessionAddress(id)).toBeNull();
    }
  });
});
