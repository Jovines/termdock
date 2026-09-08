import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';
import { CollaborationDeliveryWorker, type CollaborationRoute } from './collaborationDeliveryWorker.js';

describe('background collaboration delivery', () => {
  let directory: string;
  let file: string;
  let store: CollaborationStore;
  let groupId: string;
  let worker: CollaborationDeliveryWorker;
  let resolve: ReturnType<typeof vi.fn<(id: string) => Promise<CollaborationRoute>>>;
  let write: ReturnType<typeof vi.fn<(messages: unknown[]) => Promise<void>>>;
  beforeEach(() => {
    vi.useFakeTimers();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-collab-worker-'));
    file = path.join(directory, 'messages.json');
    store = new CollaborationStore(file);
    groupId = store.save({ name: 'Team', sessionIds: ['a', 'b', 'c'] }).id;
    write = vi.fn(async () => undefined);
    resolve = vi.fn(async () => ({ state: 'ready', write }));
    worker = makeWorker();
  });
  afterEach(() => { worker.stop(); vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(directory, { recursive: true, force: true }); });
  function makeWorker() {
    return new CollaborationDeliveryWorker({ store, peers: () => ['a', 'b', 'c'], isLocal: (id) => !id.startsWith('remote:'),
      resolve, onError: () => undefined });
  }
  function send(target = 'b', expiresAt?: number) {
    return store.send({ groupId, fromSessionId: 'a', toSessionIds: [target], kind: 'message', content: 'Please verify', expiresAt })[0]!;
  }

  it('drains durable messages after restart without a browser or hook event', async () => {
    const message = send();
    store = new CollaborationStore(file);
    worker = makeWorker();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.receipt(message.id)).toMatchObject({ status: 'delivered', attempt_count: 1, delivery_semantics: 'pty_written', read_at: null, ack_at: null });
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('joins concurrent recovery and delivery requests for the same peer', async () => {
    send();
    let release!: (route: CollaborationRoute) => void;
    resolve.mockImplementation(() => new Promise((done) => { release = done; }));
    const one = worker.run('b');
    const two = worker.run('b');
    await Promise.resolve();
    expect(one).toBe(two);
    expect(resolve).toHaveBeenCalledTimes(1);
    release({ state: 'ready', write });
    await Promise.all([one, two]);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('records routing failures without pretending a transport attempt occurred, and retries later', async () => {
    const message = send();
    resolve.mockResolvedValueOnce({ state: 'detached', reason: 'TMUX_ATTACH_EXITED' });
    await worker.run('b');
    expect(store.receipt(message.id)).toMatchObject({ status: 'pending', attempt_count: 0, last_error: 'TMUX_ATTACH_EXITED', next_retry_at: expect.any(Number) });
    await worker.run('b');
    expect(resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await worker.run('b');
    expect(store.receipt(message.id)).toMatchObject({ status: 'delivered', attempt_count: 1, last_error: null, next_retry_at: null });
  });

  it('persists transport failures and retry deadlines across restart', async () => {
    const message = send();
    write.mockRejectedValueOnce(new Error('broken pipe'));
    await worker.run('b');
    store = new CollaborationStore(file);
    worker = makeWorker();
    await worker.run('b');
    expect(write).toHaveBeenCalledTimes(1);
    expect(store.receipt(message.id)).toMatchObject({ status: 'pending', attempt_count: 1, last_error: 'TERMINAL_WRITE_FAILED: broken pipe' });
    await vi.advanceTimersByTimeAsync(2_000);
    await worker.run('b');
    expect(store.receipt(message.id)).toMatchObject({ status: 'delivered', attempt_count: 2 });
  });

  it('does not send messages read or expired during asynchronous attachment', async () => {
    const message = send();
    resolve.mockImplementationOnce(async () => { store.markRead([message.id]); return { state: 'ready', write }; });
    await worker.run('b');
    const expiring = send('b', Date.now() + 1_000);
    resolve.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 2_000); return { state: 'ready', write }; });
    await worker.run('b');
    expect(store.getMessage(expiring.id)?.status).toBe('expired');
    expect(write).not.toHaveBeenCalled();
  });

  it('isolates a broken peer and leaves remote delivery to the federation transport', async () => {
    const broken = send('b');
    const healthy = send('c');
    resolve.mockImplementation(async (id) => { if (id === 'b') throw new Error('tmux timeout'); return { state: 'ready', write }; });
    await worker.tick();
    await worker.run('remote:other');
    expect(store.getMessage(broken.id)?.status).toBe('pending');
    expect(store.getMessage(healthy.id)?.status).toBe('delivered');
    expect(resolve.mock.calls.flat()).not.toContain('remote:other');
    expect(worker.state('b')).toMatchObject({ state: 'unavailable', reason: 'ROUTE_RECOVERY_FAILED: tmux timeout' });
  });

  it('does not expire a message in the middle of an already-started terminal write', async () => {
    const message = send('b', Date.now() + 1_000);
    write.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 2_000);
      expect(store.receipt(message.id).status).toBe('pending');
    });
    await worker.run('b');
    expect(store.receipt(message.id).status).toBe('delivered');
  });

  it('serializes explicit rebinding behind an in-flight delivery and clears route backoff', async () => {
    const message = send();
    let release!: (route: CollaborationRoute) => void;
    resolve.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    const delivery = worker.run('b');
    await Promise.resolve();
    const configure = vi.fn(async () => undefined);
    const reset = worker.reconfigure('b', configure);
    expect(configure).not.toHaveBeenCalled();
    release({ state: 'identity-mismatch', reason: 'TMUX_PANE_CHANGED' });
    await Promise.all([delivery, reset]);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(store.receipt(message.id).next_retry_at).toBeNull();
    await worker.run('b');
    expect(store.receipt(message.id).status).toBe('delivered');
  });

  it('never writes if persisting the transport attempt fails', async () => {
    const message = send();
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(worker.run('b')).rejects.toThrow('disk full');
    expect(write).not.toHaveBeenCalled();
    expect(store.receipt(message.id)).toMatchObject({ status: 'pending', attempt_count: 0 });
  });

  it('does not rewrite terminal input when receipt persistence fails after a successful write', async () => {
    const message = send();
    write.mockImplementationOnce(async () => {
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full after write'); });
    });
    await expect(worker.run('b')).rejects.toThrow('disk full after write');
    expect(store.getMessage(message.id)?.status).toBe('pending');
    resolve.mockResolvedValue({ state: 'offline', reason: 'SHELL_BACKEND_NOT_RUNNING' });
    await vi.advanceTimersByTimeAsync(2_000);
    await worker.run('b');
    expect(write).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(store.getMessage(message.id)?.status).toBe('delivered');
  });

  it('keeps FIFO order and never replays successfully delivered messages across restart', async () => {
    const first = send();
    const second = send();
    await worker.run('b');
    store = new CollaborationStore(file);
    worker = makeWorker();
    await worker.run('b');
    expect(write.mock.calls.map(([messages]) => (messages[0] as { id: string }).id)).toEqual([first.id, second.id]);
  });
});
