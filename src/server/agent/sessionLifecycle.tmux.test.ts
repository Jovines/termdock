// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { IntegrationSessions, type IntegrationSession, type IntegrationSessionAdapter } from './integrationSessions.js';
import type { IntegrationPrincipal } from './integrationStore.js';
import { releaseSessionRuntime } from './sessionLifecycle.js';

/** Real runtime fixture, not a private Agent compatibility test. Keeps the
 * original process/pane identity pinned and verifies actual tmux absence. */
it.skipIf(process.platform === 'win32')('releases real tmux with zero surviving pane, then recreates the same logical descriptor and exact native argument', async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'td-runtime-'));
  const socket = `td-runtime-${process.pid}-${Date.now()}`;
  const exec = promisify(execFile);
  const run = async (args: string[]) => (await exec('tmux', ['-f', '/dev/null', '-L', socket, ...args], { timeout: 5000 })).stdout;
  const wrapper = path.join(dir, 'fixture');
  fs.writeFileSync(wrapper, '#!/bin/sh\nprintf "%s" "$1" > "$2"\nwhile :; do sleep 1; done\n', { mode: 0o700 });
  const p: IntegrationPrincipal = { id: 'test', groupId: 'group', tokenHash: 'unused', revoked: false,
    permissions: ['session.create', 'session.read', 'session.restore', 'session.release'],
    launchProfiles: [{ id: 'fixture', agentSlug: 'fixture', executable: wrapper, argv: [], cwdRoots: [dir], resumeArgv: ['{sessionId}', '{cwd}', '{launchArgs}'] }] };
  // Launch parameters for this fixture are provided directly by its adapter.
  let inventory: string | null = null, native: string | null = null, launches = 0;
  const name = (r: IntegrationSession) => `runtime-${r.session_id}`;
  const exists = async (r: IntegrationSession) => {
    try { await run(['has-session', '-t', `=${name(r)}`]); return true; }
    catch (error) { if (/can't find session|no server running|no sessions|No such file/.test(String(error))) return false; throw error; }
  };
  const api: IntegrationSessionAdapter = {
    subscribe: () => () => {}, resumeConfiguration: async () => ({ exactResume: 'fixture-native-arg-v1' }),
    pendingMessages: () => 0, runtimePresent: async r => inventory !== null || await exists(r),
    async create(r, prepared) {
      await run(['new-session', '-d', '-s', name(r), '/bin/sh']); inventory = r.session_id;
      const parts = (await run(['display-message', '-p', '-t', name(r), '#{pid}:#{session_id}:#{pane_id}:#{pane_pid}'])).trim().split(':');
      prepared({ serverPid: Number(parts[0]), sessionId: parts[1], paneId: parts[2], panePid: Number(parts[3]), agentSlug: r.agent_slug, nativeSessionId: null });
      native = r.agent_native_session_id ?? 'original-native-identity'; launches++;
      await run(['send-keys', '-t', parts[2], '-l', `'${wrapper}' '${native}' '${path.join(dir, 'identity')}'`]);
      await run(['send-keys', '-t', parts[2], 'Enter']);
      await expect.poll(() => fs.existsSync(path.join(dir, 'identity'))).toBe(true);
    },
    async restore(r, prepared) {
      await api.create(r, prepared); native = r.agent_native_session_id;
      expect(fs.readFileSync(path.join(dir, 'identity'), 'utf8')).toBe(native);
    },
    async inspect(r) {
      if (!await exists(r)) return { exists: false, running: false, shell: false, agentSlug: null, nativeId: null };
      const parts = (await run(['display-message', '-p', '-t', name(r), '#{pid}:#{session_id}:#{pane_id}:#{pane_pid}:#{pane_current_command}'])).trim().split(':');
      if (r.terminal_binding && (Number(parts[0]) !== r.terminal_binding.serverPid || parts[1] !== r.terminal_binding.sessionId
        || parts[2] !== r.terminal_binding.paneId || Number(parts[3]) !== r.terminal_binding.panePid)) throw Object.assign(new Error(), { code: 'SESSION_IDENTITY_MISMATCH' });
      const { stdout } = await exec('ps', ['-p', parts[3], '-o', 'pgid=,tpgid=']);
      const [pgid, tpgid] = stdout.trim().split(/\s+/).map(Number);
      const current = (await exec('ps', ['-p', String(tpgid), '-o', 'args='])).stdout.trim().split(/\s+/);
      const index = current.indexOf(wrapper);
      const observedNative = index >= 0 ? current[index + 1] : null;
      const shell = index < 0 && parts[4] === 'sh' && pgid > 0 && pgid === tpgid;
      return { exists: true, running: !!observedNative, shell, agentSlug: observedNative ? 'fixture' : null, nativeId: observedNative ?? null };
    },
    async release(r, reconcile) {
      await releaseSessionRuntime({ barrier: action => action(), exists: () => exists(r), pendingMessages: () => 0,
        verifyOwnership: async () => { expect(inventory).toBe(r.session_id); }, inspect: () => api.inspect(r),
        destroy: async () => { await run(['kill-session', '-t', `=${name(r)}`]); },
        forgetRuntime: async () => { inventory = null; },
      }, reconcile);
    },
  };
  const file = path.join(dir, 'records.json'); let sessions = new IntegrationSessions(file, api);
  try {
    const created = await sessions.create(p, { profile: 'fixture', cwd: dir, idempotencyKey: 'create' });
    await api.inspect(created);
    expect(created).toMatchObject({ state: 'ready', error_code: null });
    const firstPane = created.terminal_binding!;
    const list = (await run(['list-panes', '-t', name(created), '-F', '#{pane_id}'])).trim().split('\n');
    expect(list).toEqual([firstPane.paneId]);
    await expect(sessions.release(p, created.session_id, 1, 'running')).rejects.toMatchObject({ code: 'SESSION_STILL_RUNNING' });
    await run(['send-keys', '-t', firstPane.paneId, 'C-c']);
    await expect.poll(async () => (await api.inspect(created)).shell).toBe(true);
    const released = await sessions.release(p, created.session_id, 1, 'release');
    expect(released).toMatchObject({ state: 'released', runtime_present: false, terminal_binding: null });
    expect(await exists(released)).toBe(false); expect(inventory).toBeNull();
    sessions.close(); sessions = new IntegrationSessions(file, api);
    expect(await sessions.get(p, created.session_id)).toMatchObject({ state: 'released', runtime_present: false });
    fs.unlinkSync(path.join(dir, 'identity'));
    const restored = await sessions.restore(p, created.session_id, 'restore');
    expect(restored).toMatchObject({ state: 'ready', session_id: created.session_id, agent_native_session_id: 'original-native-identity', generation: 3 });
    expect(restored.terminal_binding?.paneId === firstPane.paneId && restored.terminal_binding?.panePid === firstPane.panePid).toBe(false);
    expect(launches).toBe(2);
    await sessions.restore(p, created.session_id, 'restore'); expect(launches).toBe(2);
  } finally { sessions.close(); await run(['kill-server']).catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
}, 15000);
