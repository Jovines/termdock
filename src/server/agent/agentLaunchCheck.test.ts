import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentLaunchBlockReason, normalizeAgentLaunchCheck, type AgentLaunchCheck } from './agentLaunchCheck.js';
import { CollaborationStore } from './collaborationStore.js';
import { CollaborationDeliveryWorker } from './collaborationDeliveryWorker.js';

describe('TD-initiated Agent launch before terminal delivery', () => {
  let directory: string;
  let store: CollaborationStore;
  let worker: CollaborationDeliveryWorker;
  let check: AgentLaunchCheck | null;
  let observed: { agentSlug: string | null; nativeSessionId: string | null };
  let write: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;
  let group: string;
  beforeEach(() => {
    vi.useFakeTimers();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-launch-check-'));
    store = new CollaborationStore(path.join(directory, 'messages.json'));
    group = store.save({ name: 'launch', sessionIds: ['sender', 'recipient'] }).id;
    check = { id: 'generation-one', agentSlug: 'fixture', nativeSessionId: null, deadline: Date.now() + 120_000 };
    observed = { agentSlug: null, nativeSessionId: null };
    write = vi.fn(async () => undefined);
    worker = new CollaborationDeliveryWorker({ store, peers: () => [], isLocal: () => true, onError: () => {}, snapshotDelayMs: 0,
      resolve: async () => {
        const reason = agentLaunchBlockReason(check, observed);
        if (reason) return { state: 'recovering', reason };
        check = null; // production persists the completed one-time observation
        return { state: 'ready', write };
      } });
  });
  afterEach(() => { worker.stop(); vi.useRealTimers(); fs.rmSync(directory, { recursive: true, force: true }); });
  const message = () => store.send({ groupId: group, fromSessionId: 'sender', toSessionIds: ['recipient'], kind: 'message', content: 'run once' })[0]!;

  it('holds cold-start input without writing into the launcher shell, then permits an Agent with no native UUID', async () => {
    const sent = message();
    await worker.run('recipient');
    expect(store.receipt(sent.id)).toMatchObject({ status: 'pending', attempt_count: 0, last_error: 'AGENT_LAUNCH_PENDING' });
    expect(write).not.toHaveBeenCalled();
    observed = { agentSlug: 'fixture', nativeSessionId: null };
    await vi.advanceTimersByTimeAsync(2000);
    await worker.run('recipient');
    expect(store.receipt(sent.id)).toMatchObject({ status: 'delivered', attempt_count: 1, last_error: null });
    expect(write).toHaveBeenCalledTimes(1);
    // A subsequent message does not acquire an application-ready gate.
    observed = { agentSlug: null, nativeSessionId: null };
    message(); await worker.run('recipient');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('restores a persisted launch intent and refuses a different native UUID before writing', async () => {
    check!.nativeSessionId = 'original-native';
    fs.writeFileSync(path.join(directory, 'launch.json'), JSON.stringify(check));
    check = normalizeAgentLaunchCheck(JSON.parse(fs.readFileSync(path.join(directory, 'launch.json'), 'utf8')));
    const sent = message();
    observed = { agentSlug: 'fixture', nativeSessionId: 'other-native' };
    await worker.run('recipient');
    expect(store.receipt(sent.id)).toMatchObject({ status: 'pending', attempt_count: 0, last_error: 'AGENT_LAUNCH_IDENTITY_MISMATCH' });
    observed.nativeSessionId = 'original-native';
    await vi.advanceTimersByTimeAsync(2000);
    await worker.run('recipient');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not blind-write on a startup timeout, and a later real observation can unblock the original message', async () => {
    const sent = message();
    await vi.advanceTimersByTimeAsync(120_000);
    await worker.run('recipient');
    expect(store.receipt(sent.id)).toMatchObject({ status: 'pending', attempt_count: 0, last_error: 'AGENT_LAUNCH_TIMEOUT' });
    expect(write).not.toHaveBeenCalled();
    observed.agentSlug = 'fixture';
    await vi.advanceTimersByTimeAsync(2000);
    await worker.run('recipient');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary terminals unchanged and requires a fresh observation after a new explicit restore', async () => {
    check = null;
    const first = message(); await worker.run('recipient');
    expect(store.receipt(first.id).status).toBe('delivered');
    check = { id: 'generation-two', agentSlug: 'fixture', nativeSessionId: 'original-native', deadline: Date.now() + 120_000 };
    const second = message(); await worker.run('recipient');
    expect(store.receipt(second.id)).toMatchObject({ status: 'pending', attempt_count: 0 });
    observed.agentSlug = 'fixture'; // Agent recognition alone cannot confirm resume.
    await vi.advanceTimersByTimeAsync(2000); await worker.run('recipient');
    expect(store.receipt(second.id).status).toBe('pending');
    observed.nativeSessionId = 'original-native';
    await vi.advanceTimersByTimeAsync(4000); await worker.run('recipient');
    expect(store.receipt(second.id).status).toBe('delivered');
    expect(write).toHaveBeenCalledTimes(2);
  });
});
