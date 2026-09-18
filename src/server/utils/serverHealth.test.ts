import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerHealthState, dismissServerHealth, type ServerHealthOptions } from './serverHealth.js';

let directory: string;
let options: ServerHealthOptions;

function crashLogPath(): string {
  return path.join(directory, 'crash.log');
}

function writeCrashLog(lines: Array<Record<string, unknown> | string>): void {
  fs.writeFileSync(crashLogPath(), lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
}

function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ts: '2026-09-19T01:00:00.000Z',
    pid: 4242,
    role: 'supervisor',
    event: 'crash',
    detail: 'exit code 1',
    ...overrides,
  };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-health-'));
  options = {
    crashLogPath: crashLogPath(),
    dismissedPath: path.join(directory, 'dismissed.json'),
    supervisorStatePath: path.join(directory, 'supervisor.json'),
  };
  delete process.env.TERMDOCK_SUPERVISED;
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('serverHealth 快照', () => {
  it('没有 crash.log 时什么都不报', () => {
    const state = buildServerHealthState(options);
    expect(state).toMatchObject({ incident: null, attention: false, dismissedAt: null, supervisor: null, supervised: false });
    expect(state.generatedAt).toBeGreaterThan(0);
  });

  it('把最新一条异常投影成界面要的形状', () => {
    writeCrashLog([
      entry({ event: 'stop', detail: 'stopped on request' }),
      entry({
        ts: '2026-09-19T02:30:00.000Z',
        event: 'killed',
        detail: 'signal SIGKILL',
        signal: 'SIGKILL',
        exitCode: null,
        uptimeMs: 12_000,
        version: '1.4.261',
        oomSuspect: true,
        restartCount: 3,
      }),
    ]);

    const { incident, attention } = buildServerHealthState(options);
    expect(attention).toBe(true);
    expect(incident).toEqual({
      at: Date.parse('2026-09-19T02:30:00.000Z'),
      event: 'killed',
      detail: 'signal SIGKILL',
      role: 'supervisor',
      exitCode: null,
      signal: 'SIGKILL',
      uptimeMs: 12_000,
      version: '1.4.261',
      oomSuspect: true,
      restartCount: 3,
    });
  });

  it.each(['stop', 'update-restart', 'manual-restart'])('「%s」是我们自己干的，不点红点', (event) => {
    writeCrashLog([entry({ event })]);
    expect(buildServerHealthState(options)).toMatchObject({ incident: null, attention: false });
  });

  it('坏行、缺 event 的行、非 JSON 行都跳过，好行照常生效', () => {
    writeCrashLog([
      entry({ event: 'wedge' }),
      '{ 这不是 JSON',
      entry({ detail: '没有 event 字段', event: undefined as unknown as string }),
    ]);
    expect(buildServerHealthState(options).incident?.event).toBe('wedge');
  });

  it('服务侧的进程内取证（uncaught-exception）同样算数——没有监督者时也得能看到', () => {
    writeCrashLog([entry({ role: 'server', event: 'uncaught-exception', detail: 'TypeError: x is not a function', exitCode: 1 })]);
    const state = buildServerHealthState(options);
    expect(state.incident).toMatchObject({ role: 'server', event: 'uncaught-exception', detail: 'TypeError: x is not a function' });
    expect(state.attention).toBe(true);
  });

  it('「知道了」清掉红点，但新的事故会再点亮', () => {
    writeCrashLog([entry({ ts: '2026-09-19T02:00:00.000Z', event: 'crash' })]);
    expect(buildServerHealthState(options).attention).toBe(true);

    const dismissed = dismissServerHealth(options);
    expect(dismissed.attention).toBe(false);
    expect(dismissed.dismissedAt).toBe(Date.parse('2026-09-19T02:00:00.000Z'));
    // 重启进程后再读一遍：确认它真的落盘了，而不是只活在返回值里。
    expect(buildServerHealthState(options).attention).toBe(false);

    fs.appendFileSync(crashLogPath(), JSON.stringify(entry({ ts: '2026-09-19T03:00:00.000Z', event: 'wedge' })) + '\n');
    expect(buildServerHealthState(options).attention).toBe(true);
  });

  it('没有事故时「知道了」是空操作，不会写出一份假的确认记录', () => {
    const state = dismissServerHealth(options);
    expect(state.dismissedAt).toBeNull();
    expect(fs.existsSync(options.dismissedPath as string)).toBe(false);
  });

  it('supervisor.json 给出「谁在盯着、重启过几次」，进程没了也要照实说', () => {
    fs.writeFileSync(options.supervisorStatePath as string, JSON.stringify({
      version: 1,
      pid: process.pid,
      serverPid: 999,
      phase: 'running',
      startedAt: 1,
      restarts: 2,
      consecutiveCrashes: 0,
      lastIncident: null,
    }));
    process.env.TERMDOCK_SUPERVISED = '1';
    expect(buildServerHealthState(options)).toMatchObject({
      supervised: true,
      supervisor: { pid: process.pid, alive: true, phase: 'running', restarts: 2, consecutiveCrashes: 0 },
    });

    // 换成一个不可能存在的 pid：状态文件还在，但它已经死了。
    fs.writeFileSync(options.supervisorStatePath as string, JSON.stringify({
      version: 1, pid: 2 ** 30, serverPid: null, phase: 'gave-up',
      // 放弃时的真实形状：连续崩了 5 次，但只成功重启了 4 次（第 5 次就放弃了）。
      startedAt: 1, restarts: 4, consecutiveCrashes: 5, lastIncident: null,
    }));
    expect(buildServerHealthState(options)).toMatchObject({
      supervisor: { alive: false, phase: 'gave-up', restarts: 4, consecutiveCrashes: 5 },
    });
  });

  it('形状不对的 supervisor.json 当作没有，而不是把脏数据端给界面', () => {
    fs.writeFileSync(options.supervisorStatePath as string, JSON.stringify({ pid: 'not-a-number' }));
    expect(buildServerHealthState(options).supervisor).toBeNull();
  });
});
