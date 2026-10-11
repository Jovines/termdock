// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { closeSessionRuntime, foregroundProcessInstance, processStartIdentity, type SessionCloseTarget } from './sessionManagement.js';
const exec = promisify(execFile), sockets: string[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) await exec('tmux', ['-L', socket, 'kill-server']).catch(() => {}); });
it.skipIf(process.platform !== 'linux')('closes the exact real tmux shell and observes process exit before removing registration', async () => {
  const socket = `td-management-${randomUUID().slice(0, 8)}`; sockets.push(socket);
  const tmux = (args: string[]) => exec('tmux', ['-L', socket, ...args], { timeout: 3000 });
  await tmux(['new-session', '-d', '-s', 'owner', '-x', '80', '-y', '24', '/bin/sh']);
  const fields = (await tmux(['display-message', '-p', '-t', 'owner', '#{pid}|#{session_id}|#{pane_id}|#{pane_pid}'])).stdout.trim().split('|');
  const pid = Number(fields[3]);
  const target: SessionCloseTarget = { binding: { serverPid: Number(fields[0]), sessionId: fields[1], paneId: fields[2], panePid: pid, agentSlug: 'fixture', nativeSessionId: null },
    tmux_server_start_id: (await processStartIdentity(Number(fields[0])))!, kind: 'shell', process_pid: pid, process_start_id: await foregroundProcessInstance(pid), native_id: null };
  const exists = async () => {
    const present = await tmux(['has-session', '-t', '=owner']).then(() => true, () => false);
    return present || await processStartIdentity(pid) === target.process_start_id;
  };
  const removed = vi.fn(async () => { expect(await exists()).toBe(false); });
  const destroy = vi.fn(async (t: SessionCloseTarget) => { await tmux(['kill-session', '-t', t.binding.sessionId]); });
  await closeSessionRuntime({ barrier: async action => action(), exists, pendingMessages: () => 0,
    observe: async () => { expect(await foregroundProcessInstance(pid)).toBe(target.process_start_id); return target; }, destroy, forgetRuntime: removed }, target, false);
  expect(destroy).toHaveBeenCalledTimes(1); expect(removed).toHaveBeenCalledTimes(1); expect(await processStartIdentity(pid)).toBeNull();
});
