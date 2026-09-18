import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupervisor, DEFAULT_SUPERVISOR_TIMING, type SupervisedChild, type SupervisorDeps, type SupervisorTiming } from './supervisor.js';
import type { HealthProbeResult } from './utils/healthProbe.js';
import type { SupervisorState } from './utils/supervisorProtocol.js';

/** 假子进程：生命周期完全由测试摆布，不碰真实进程。 */
class FakeChild implements SupervisedChild {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killed: NodeJS.Signals[] = [];
  private messageListeners: Array<(message: unknown) => void> = [];
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];

  constructor(pid: number) {
    this.pid = pid;
  }

  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown {
    if (event === 'message') this.messageListeners.push(listener as (message: unknown) => void);
    if (event === 'exit') this.exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    if (event === 'error') this.errorListeners.push(listener as (error: Error) => void);
    return this;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    return true;
  }

  ready(): void {
    for (const listener of this.messageListeners) listener({ type: 'termdock-ready' });
  }

  declareIntent(intent: 'restart-after-update' | 'stop'): void {
    for (const listener of this.messageListeners) listener({ type: 'termdock-intent', intent });
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    for (const listener of this.exitListeners) listener(code, signal);
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

interface Harness {
  handle: ReturnType<typeof createSupervisor>;
  children: FakeChild[];
  current: () => FakeChild;
  incidents: Record<string, unknown>[];
  states: SupervisorState[];
  cleared: () => number;
  exits: number[];
  logs: string[];
  launcher: Record<string, unknown>[];
  setProbe: (result: HealthProbeResult) => void;
}

function makeHarness(timing: SupervisorTiming = DEFAULT_SUPERVISOR_TIMING): Harness {
  const children: FakeChild[] = [];
  const incidents: Record<string, unknown>[] = [];
  const states: SupervisorState[] = [];
  const exits: number[] = [];
  const logs: string[] = [];
  const launcher: Record<string, unknown>[] = [];
  let cleared = 0;
  let nextPid = 1000;
  let probeResult: HealthProbeResult = { ok: true };

  const deps: SupervisorDeps = {
    spawnChild: () => {
      const child = new FakeChild(nextPid++);
      children.push(child);
      return child;
    },
    probe: () => Promise.resolve(probeResult),
    recordIncident: (entry) => { incidents.push(entry); },
    log: (message) => { logs.push(message); },
    exit: (code) => { exits.push(code); },
    now: () => Date.now(),
    writeState: (state) => { states.push(state as SupervisorState); },
    clearState: () => { cleared += 1; },
    notifyLauncher: (message) => { launcher.push(message as unknown as Record<string, unknown>); },
  };

  const handle = createSupervisor({
    childEntry: '/tmp/fake-cli.js',
    childArgs: [],
    healthUrl: 'http://localhost:9834/health',
    version: '1.4.261',
    timing,
  }, deps);

  return {
    handle, children, incidents, states, exits, logs, launcher,
    current: () => children[children.length - 1],
    cleared: () => cleared,
    setProbe: (result) => { probeResult = result; },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('supervisor 状态机', () => {
  it('就绪后进入 running，并把 ready 透传给 launcher', () => {
    const harness = makeHarness();
    harness.handle.start();
    expect(harness.states.at(-1)?.phase).toBe('starting');

    harness.current().ready();

    expect(harness.handle.phase()).toBe('running');
    expect(harness.states.at(-1)).toMatchObject({ phase: 'running', serverPid: 1000 });
    expect(harness.launcher).toEqual([{ type: 'termdock-ready' }]);
  });

  it('就绪后崩溃 → 退避重启，事件记为 crash', async () => {
    const harness = makeHarness();
    harness.handle.start();
    harness.current().ready();

    harness.current().exit(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.incidents.at(-1)).toMatchObject({ role: 'supervisor', event: 'crash', exitCode: 1, version: '1.4.261' });
    expect(harness.children).toHaveLength(2);
    expect(harness.children[1].pid).toBe(1001);
    expect(harness.states.at(-1)).toMatchObject({ restarts: 1 });
  });

  it('从未就绪就退出 → startup-failure，并立刻回报 launcher', () => {
    const harness = makeHarness();
    harness.handle.start();

    harness.current().exit(1);

    expect(harness.incidents.at(-1)).toMatchObject({ event: 'startup-failure' });
    expect(harness.launcher).toEqual([{ type: 'termdock-startup-failed', reason: 'startup-failure', detail: expect.stringContaining('exit code 1') }]);
  });

  it('spawn 失败（ENOENT）也能说清原因，而不是"什么都没发生"', () => {
    const harness = makeHarness();
    harness.handle.start();

    harness.current().fail(new Error('spawn ENOENT'));

    expect(harness.incidents.at(-1)).toMatchObject({ event: 'startup-failure', spawnError: 'spawn ENOENT' });
    expect(harness.launcher.at(-1)).toMatchObject({ type: 'termdock-startup-failed', reason: 'spawn-failed' });
  });

  it('服务声明 restart-after-update 后退出 → 立刻重启、不计崩溃、退避归零', async () => {
    const harness = makeHarness();
    harness.handle.start();
    harness.current().ready();
    harness.current().declareIntent('restart-after-update');

    harness.current().exit(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_SUPERVISOR_TIMING.restartDelayMs);

    expect(harness.incidents.at(-1)).toMatchObject({ event: 'update-restart' });
    expect(harness.children).toHaveLength(2);
    expect(harness.states.at(-1)).toMatchObject({ consecutiveCrashes: 0, restarts: 1 });
  });

  it('服务声明 stop → 不重启，删状态并以 0 退出', () => {
    const harness = makeHarness();
    harness.handle.start();
    harness.current().ready();
    harness.current().declareIntent('stop');

    harness.current().exit(0);

    expect(harness.incidents.at(-1)).toMatchObject({ event: 'stop' });
    expect(harness.exits).toEqual([0]);
    expect(harness.cleared()).toBe(1);
    expect(harness.children).toHaveLength(1);
  });

  it('外部 SIGTERM（无 intent）= 有意停机：记录但不重启', () => {
    const harness = makeHarness();
    harness.handle.start();
    harness.current().ready();

    harness.current().exit(null, 'SIGTERM');

    expect(harness.incidents.at(-1)).toMatchObject({ event: 'terminated-externally' });
    expect(harness.children).toHaveLength(1);
    expect(harness.exits).toEqual([0]);
  });

  it('--stop：杀子进程、不重启、退出 0', () => {
    const harness = makeHarness();
    harness.handle.start();
    harness.current().ready();

    harness.handle.stop();
    expect(harness.current().killed).toContain('SIGTERM');

    harness.current().exit(null, 'SIGTERM');

    expect(harness.exits).toEqual([0]);
    expect(harness.cleared()).toBe(1);
    expect(harness.incidents.at(-1)).toMatchObject({ event: 'stop' });
  });

  it('--restart：重启一次，事件记为 manual-restart 而不是崩溃', async () => {
    const harness = makeHarness();
    harness.handle.start();
    harness.current().ready();

    harness.handle.restart();
    harness.current().exit(null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(DEFAULT_SUPERVISOR_TIMING.restartDelayMs);

    expect(harness.incidents.at(-1)).toMatchObject({ event: 'manual-restart' });
    expect(harness.children).toHaveLength(2);
    expect(harness.exits).toEqual([]);
  });

  it('连续 5 次崩溃后停手：phase=gave-up、退出 1、记录里给出回滚命令', async () => {
    const harness = makeHarness();
    harness.handle.start();

    for (let attempt = 0; attempt < DEFAULT_SUPERVISOR_TIMING.maxConsecutiveCrashes; attempt += 1) {
      harness.current().exit(1);
      await vi.advanceTimersByTimeAsync(DEFAULT_SUPERVISOR_TIMING.crashResetMs);
    }

    expect(harness.handle.phase()).toBe('gave-up');
    expect(harness.exits).toEqual([1]);
    const giveUp = harness.incidents.filter((entry) => entry.event === 'gave-up');
    expect(giveUp).toHaveLength(1);
    expect(giveUp[0]).toMatchObject({ restartCommand: 'npm i -g termdock@1.4.261' });
    // 5 次之后不再拉新进程
    expect(harness.children).toHaveLength(DEFAULT_SUPERVISOR_TIMING.maxConsecutiveCrashes);
  });

  it('稳定运行满 crashResetMs 后崩溃计数清零（零星崩溃不该累积成放弃）', async () => {
    const harness = makeHarness();
    harness.handle.start();

    for (let round = 0; round < 3; round += 1) {
      harness.current().ready();
      await vi.advanceTimersByTimeAsync(DEFAULT_SUPERVISOR_TIMING.crashResetMs);
      expect(harness.states.at(-1)?.consecutiveCrashes).toBe(0);
      harness.current().exit(1);
      await vi.advanceTimersByTimeAsync(4_000);
    }

    // 三轮都各自被重置过，所以永远到不了 5 次：3 轮崩溃各拉起一个后继进程（1000 是首代）
    expect(harness.handle.phase()).not.toBe('gave-up');
    expect(harness.children).toHaveLength(4);
    expect(harness.states.at(-1)?.consecutiveCrashes).toBe(1);
  });

  it('健康探测连续失败 → 判卡死、杀掉重启，事件记为 wedge', async () => {
    const harness = makeHarness();
    harness.setProbe({ ok: false, failure: 'timeout' });
    harness.handle.start();
    harness.current().ready();

    for (let probe = 0; probe < DEFAULT_SUPERVISOR_TIMING.wedgeFailures; probe += 1) {
      await vi.advanceTimersByTimeAsync(DEFAULT_SUPERVISOR_TIMING.healthIntervalMs);
    }

    expect(harness.current().killed).toContain('SIGTERM');
    harness.current().exit(null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.incidents.at(-1)).toMatchObject({ event: 'wedge' });
    expect(harness.children).toHaveLength(2);
  });

  it('探测中间恢复就不再累计失败次数', async () => {
    const harness = makeHarness();
    harness.setProbe({ ok: false, failure: 'timeout' });
    harness.handle.start();
    harness.current().ready();

    await vi.advanceTimersByTimeAsync(DEFAULT_SUPERVISOR_TIMING.healthIntervalMs);
    harness.setProbe({ ok: true });
    await vi.advanceTimersByTimeAsync(DEFAULT_SUPERVISOR_TIMING.healthIntervalMs);
    await vi.advanceTimersByTimeAsync(DEFAULT_SUPERVISOR_TIMING.healthIntervalMs);

    expect(harness.current().killed).toEqual([]);
    expect(harness.children).toHaveLength(1);
  });

  it('卡死判定优先于信号：我们自己的 SIGKILL 不会被误读成"被外部终止"', () => {
    const harness = makeHarness();
    harness.setProbe({ ok: false, failure: 'timeout' });
    harness.handle.start();
    harness.current().ready();
    // 直接把探测失败次数顶到阈值
    return vi.advanceTimersByTimeAsync(DEFAULT_SUPERVISOR_TIMING.healthIntervalMs * DEFAULT_SUPERVISOR_TIMING.wedgeFailures).then(async () => {
      harness.current().exit(null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.incidents.at(-1)).toMatchObject({ event: 'wedge', signal: 'SIGKILL' });
    });
  });
});
