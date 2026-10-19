import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { IntegrationRuntime } from './integrationServer.js';
import { CollaborationStore } from './collaborationStore.js';
import { CollaborationTaskStore } from './collaborationTaskStore.js';

const directories: string[] = [];
async function makeRuntime() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'td-release-batch-'));
  directories.push(directory);
  const groupsFile = path.join(directory, 'groups.json');
  await fs.writeFile(groupsFile, JSON.stringify({ version: 2, groups: [{ id: 'g1', name: 'test', sessionIds: [], createdAt: 1, updatedAt: 1 }], messages: [], terminalHistoryComplete: true, localGroupRequestsComplete: true }));
  const messages = new CollaborationStore(groupsFile);
  const adapter = { subscribe: () => () => {}, create: async () => {}, restore: async () => {}, inspect: async () => ({ exists: true, running: true, shell: false, agentSlug: 'codex', nativeId: 'native' }) } as any;
  const runtime = new IntegrationRuntime({ directory, socketPath: path.join(directory, 'integration.sock'), messages,
    taskStore: new CollaborationTaskStore(path.join(directory, 'tasks.json')), tasks: {} as any, peers: {} as any, sessions: adapter });
  const { principal } = runtime.store.provision({ id: 'p1', groupId: 'g1', permissions: ['session.release'], launchProfiles: [] });
  vi.spyOn(runtime.sessions, 'get').mockImplementation(async (_p, id) => ({ session_id: id, generation: 7 } as any));
  const release = vi.spyOn(runtime.sessions, 'release').mockImplementation(async (_p, id) => ({ session_id: id, state: 'released' } as any));
  return { runtime, principal, release };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

it('durably batches principal-owned releases, replays the same key, and rejects changed input', async () => {
  const { runtime, principal, release } = await makeRuntime();
  const create = (runtime as any).createReleaseBatch.bind(runtime) as (p: any, ids: unknown, key: unknown) => Promise<any>;
  const first = await create(principal, ['s2', 's1', 's1'], 'release-key');
  expect(first.accepted).toBe(true);
  await vi.waitFor(() => expect(runtime['releaseBatchOperations'][0].state).toBe('succeeded'));
  expect(release).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'p1', groupId: 'g1' }), 's1', 7, expect.stringMatching(/:s1$/));
  expect(release).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'p1', groupId: 'g1' }), 's2', 7, expect.stringMatching(/:s2$/));
  const replay = await create(principal, ['s1', 's2'], 'release-key');
  expect(replay.replayed).toBe(true);
  expect(replay.operation.id).toBe(first.operation.id);
  await expect(create(principal, ['s3'], 'release-key')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const stored = JSON.parse(await fs.readFile(path.join(directories.at(-1)!, 'session-release-batches.json'), 'utf8'));
  expect(stored[0]).toMatchObject({ state: 'succeeded', items: [{ state: 'released' }, { state: 'released' }] });
});
