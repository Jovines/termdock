// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { spawn, type IPty } from 'node-pty';
import { applyAgentEvent, defaultAgentSessionState, parseAgentEvent } from './agent/session.js';

const clients: IPty[] = [];
let socket: string | undefined;
let directory: string | undefined;
afterEach(() => {
  if (socket) {
    try { execFileSync('tmux', ['-S', socket, 'kill-server']); } catch { /* already gone */ }
  }
  for (const client of clients.splice(0)) { try { client.kill(); } catch { /* already gone */ } }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  socket = directory = undefined;
});

it.skipIf(process.platform !== 'linux')('delivers real hook transitions to every managed tmux observer without writing to ordinary clients', async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-hook-'));
  socket = path.join(directory, 'tmux.sock');
  const tmux = (args: string[]) => execFileSync('tmux', ['-S', socket!, ...args], { encoding: 'utf8' });
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '80', '-y', '24', '/bin/sh']);
  const [serverPid, paneId] = tmux(['display-message', '-p', '-t', 'fixture', '#{pid} #{pane_id}']).trim().split(' ');
  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.TERMDOCK;
  const output = ['', '', ''];
  for (let i = 0; i < output.length; i++) {
    const client = spawn('tmux', ['-S', socket, 'attach-session', '-t', 'fixture'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: directory,
      env: i < 2 ? { ...env, TERMDOCK: '1' } : env,
    });
    client.onData(data => { output[i] += data; });
    clients.push(client);
    await expect.poll(() => tmux(['list-clients', '-F', '#{client_pid}']).trim().split('\n').length).toBe(i + 1);
  }

  const states = [defaultAgentSessionState(), defaultAgentSessionState()];
  for (const [event, phase, input] of [
    ['prompt-submit', 'working', { prompt: '中文'.repeat(6000) }],
    ['tool-start', 'waiting', { tool_name: 'request_user_input' }],
    ['tool-complete', 'working', {}],
    ['stop', 'done', {}],
  ] as const) {
    output.fill('');
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, ['--import', 'tsx', path.resolve('src/server/agentHook.ts'), 'agent-hook', 'codex', event], {
        env: { ...env, TERMDOCK: '1', TMUX: `${socket},${serverPid},0`, TMUX_PANE: paneId }, timeout: 5000,
      }, error => error ? reject(error) : resolve());
      child.stdin!.end(JSON.stringify({ session_id: 'fixture-native', ...input }));
    });
    await expect.poll(() => output.slice(0, 2).every(data => data.includes('termdock://cli-agent'))).toBe(true);
    for (let i = 0; i < states.length; i++) {
      const payload = output[i].match(/\x1b\](777;notify;termdock:\/\/cli-agent;[^\x07]+)\x07/)?.[1];
      const parsed = payload && parseAgentEvent(payload);
      expect(parsed).toBeTruthy();
      if (parsed) applyAgentEvent(states[i], parsed);
      expect(states[i].status).toBe(phase);
      expect(states[i].sessionId).toBe('fixture-native');
      if (event === 'prompt-submit') expect(parsed && parsed.promptPayload).toContain('中文'.repeat(6000));
    }
    expect(output[2]).not.toContain('termdock://cli-agent');
  }
}, 15_000);
