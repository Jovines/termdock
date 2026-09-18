/**
 * supervisor 的端到端：起一个**真的** supervisor 进程，盯一个假的服务器。
 *
 * 与 supervisor.test.ts 的分工：那边用假子进程验状态机的分支覆盖，这边验的是
 * 那些只有真进程才说得清的事——IPC 有没有通、pid 有没有换、状态文件有没有落盘、
 * crash.log 里的现场读起来是不是那个意思、`kill -9` 之后到底有没有人回来。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SupervisorState } from './utils/supervisorProtocol.js';

const SUPERVISOR_ENTRY = fileURLToPath(new URL('./supervisor.ts', import.meta.url));
const STUB_ENTRY = fileURLToPath(new URL('./__fixtures__/supervisedServerStub.mjs', import.meta.url));

/** 秒级节奏：否则崩溃循环用例要等 1+2+4+8+16 秒的真实退避。 */
const FAST_TIMING = {
  readyTimeoutMs: 5_000,
  healthIntervalMs: 200,
  healthProbeTimeoutMs: 150,
  wedgeFailures: 3,
  killGraceMs: 1_000,
  restartDelayMs: 50,
  crashResetMs: 60_000,
  maxConsecutiveCrashes: 5,
  backoffBaseMs: 30,
  backoffMaxMs: 200,
};

interface CrashEntry {
  ts: string;
  pid: number;
  role: string;
  event: string;
  detail?: string;
  signal?: string | null;
  exitCode?: number | null;
  serverPid?: number | null;
  version?: string | null;
  restartCommand?: string | null;
  consecutiveCrashes?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 占一个空闲端口再立刻放掉。窗口只有微秒级，且 stub 会把它写进 port 文件作实证。 */
async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

class SupervisorHarness {
  readonly home: string;
  readonly controlPath: string;
  readonly portPath: string;
  readonly healthUrl: string;
  readonly supervisor: ChildProcess;
  readonly stderr: string[] = [];
  exitCode: number | null = null;

  private constructor(home: string, port: number, supervisor: ChildProcess) {
    this.home = home;
    this.portPath = path.join(home, 'port');
    this.controlPath = path.join(home, 'control.json');
    this.healthUrl = `http://127.0.0.1:${port}/health`;
    this.supervisor = supervisor;
  }

  static async start(): Promise<SupervisorHarness> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-supervisor-'));
    const port = await reservePort();
    const preloadPath = path.join(home, 'preload.mjs');
    // 把 homedir 指到临时目录：supervisor 写的 supervisor.json / crash.log 全落在那里，
    // 既不碰真实 ~/.termdock，也让测试能按 pid 精确地杀——**不能猜 pid**。
    fs.writeFileSync(
      preloadPath,
      "import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';"
      + 'os.homedir = () => process.env.TERMDOCK_SUPERVISOR_TEST_HOME; syncBuiltinESMExports();',
    );

    const supervisor = spawn(process.execPath, [
      '--import', preloadPath,
      '--import', 'tsx',
      SUPERVISOR_ENTRY,
      '--health-url', `http://127.0.0.1:${port}/health`,
      '--child', STUB_ENTRY,
      '--version', '9.9.9-test',
      '--',
      '--control', path.join(home, 'control.json'),
      '--port-file', path.join(home, 'port'),
      '--port', String(port),
    ], {
      env: {
        ...process.env,
        TERMDOCK_SUPERVISOR_TEST_HOME: home,
        TERMDOCK_SUPERVISOR_TIMING: JSON.stringify(FAST_TIMING),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const harness = new SupervisorHarness(home, port, supervisor);
    supervisor.stderr?.on('data', (chunk) => { harness.stderr.push(String(chunk)); });
    supervisor.stdout?.resume();
    supervisor.on('exit', (code) => { harness.exitCode = code; });
    return harness;
  }

  get statePath(): string {
    return path.join(this.home, '.termdock', 'supervisor.json');
  }

  get crashLogPath(): string {
    return path.join(this.home, '.termdock', 'crash.log');
  }

  readState(): SupervisorState | null {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as SupervisorState;
    } catch {
      return null;
    }
  }

  readCrashLog(): CrashEntry[] {
    try {
      return fs.readFileSync(this.crashLogPath, 'utf8')
        .split('\n')
        .flatMap((line) => {
          try { return [JSON.parse(line) as CrashEntry]; } catch { return []; }
        });
    } catch {
      return [];
    }
  }

  writeControl(control: Record<string, unknown>): void {
    fs.writeFileSync(this.controlPath, JSON.stringify(control));
  }

  /** stub 绑定成功才会写这个文件——它比"进程还在"更能说明服务真的起来了。 */
  readBoundPort(): number | null {
    try { return Number(fs.readFileSync(this.portPath, 'utf8')); } catch { return null; }
  }

  async waitFor<T>(probe: () => T | null | undefined, label: string, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value !== null && value !== undefined && value !== false) return value;
      if (Date.now() > deadline) {
        throw new Error(`等待「${label}」超时（${timeoutMs}ms）。supervisor stderr:\n${this.stderr.join('')}`);
      }
      await delay(25);
    }
  }

  /** 等到某个 phase 带上一个非空 serverPid。 */
  async waitForRunning(label: string, timeoutMs = 15_000): Promise<SupervisorState> {
    return this.waitFor(() => {
      const state = this.readState();
      return state?.phase === 'running' && state.serverPid ? state : null;
    }, label, timeoutMs);
  }

  async waitForIncident(event: string, timeoutMs = 15_000): Promise<CrashEntry> {
    return this.waitFor(() => this.readCrashLog().find((entry) => entry.event === event), `crash.log 里的 ${event}`, timeoutMs);
  }

  async fetchHealth(timeoutMs = 1_000): Promise<string> {
    const response = await fetch(this.healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return response.text();
  }

  /**
   * 清理顺序很重要：先硬杀 supervisor（用 SIGKILL 而不是 SIGTERM，免得它的停止流程
   * 再拉一个子进程出来），再杀当前子进程，最后删目录。
   */
  async stop(): Promise<void> {
    if (this.supervisor.exitCode === null && this.supervisor.pid) {
      try { this.supervisor.kill('SIGKILL'); } catch { /* already gone */ }
    }
    const serverPid = this.readState()?.serverPid;
    if (serverPid && isRunning(serverPid)) {
      try { process.kill(serverPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await delay(50);
    fs.rmSync(this.home, { recursive: true, force: true });
  }
}

describe('supervisor 端到端', () => {
  it('服务被 SIGKILL 后自动拉起新的，并把这次死亡记进 crash.log', async () => {
    const harness = await SupervisorHarness.start();
    try {
      const first = await harness.waitForRunning('首个子进程就绪');
      expect(await harness.fetchHealth()).toContain('"status":"ok"');

      process.kill(first.serverPid as number, 'SIGKILL');

      const second = await harness.waitFor(() => {
        const state = harness.readState();
        return state?.phase === 'running' && state.serverPid && state.serverPid !== first.serverPid ? state : null;
      }, 'SIGKILL 之后服务被重新拉起');
      expect(second.restarts).toBe(1);
      // 不只是"状态文件说好了"——端口上真的有人在应答。
      expect(harness.readBoundPort()).toBeGreaterThan(0);
      expect(await harness.fetchHealth()).toContain('"status":"ok"');

      const killed = await harness.waitForIncident('killed');
      expect(killed.signal).toBe('SIGKILL');
      expect(killed.serverPid).toBe(first.serverPid);
      expect(killed.role).toBe('supervisor');
      expect(killed.version).toBe('9.9.9-test');
    } finally {
      await harness.stop();
    }
  }, 30_000);

  it('服务卡死（/health 不再应答）被杀掉重启，记录为 wedge', async () => {
    const harness = await SupervisorHarness.start();
    try {
      const first = await harness.waitForRunning('首个子进程就绪');
      await harness.waitFor(() => harness.readBoundPort(), '子进程开始监听');
      expect(await harness.fetchHealth()).toContain('"status":"ok"');

      // 跑着跑着卡住：进程还在，/health 不再应答（探测以 socket 超时收场）。
      harness.writeControl({ serve: false });

      const wedge = await harness.waitForIncident('wedge');
      expect(wedge.serverPid).toBe(first.serverPid);
      expect(wedge.signal).toBe('SIGTERM');

      // 恢复健康后应当被重新拉起来——卡死判定不能变成一次性的停机。
      harness.writeControl({ serve: true });
      const revived = await harness.waitFor(() => {
        const state = harness.readState();
        return state?.phase === 'running' && state.serverPid && state.serverPid !== first.serverPid ? state : null;
      }, 'wedge 之后服务被重新拉起');
      expect(revived.serverPid).not.toBe(first.serverPid);
      expect(await harness.fetchHealth()).toContain('"status":"ok"');
    } finally {
      await harness.stop();
    }
  }, 30_000);

  it('反复起不来 → 5 次之后停手，而不是无限重启', async () => {
    const harness = await SupervisorHarness.start();
    try {
      harness.writeControl({ bootExitCode: 1 });

      const gaveUp = await harness.waitForIncident('gave-up', 20_000);
      expect(gaveUp.detail).toContain('consecutive crashes');
      expect(gaveUp.restartCommand).toBe('npm i -g termdock@9.9.9-test');

      const crashes = harness.readCrashLog().filter((entry) => entry.event === 'startup-failure');
      expect(crashes).toHaveLength(FAST_TIMING.maxConsecutiveCrashes);
      expect(crashes.at(-1)?.consecutiveCrashes).toBe(FAST_TIMING.maxConsecutiveCrashes);

      // supervisor 自己也退了，且状态停在 gave-up（`td --status` 要能报出来）。
      await harness.waitFor(() => harness.exitCode === 1, 'supervisor 以 1 退出');
      expect(harness.readState()?.phase).toBe('gave-up');
    } finally {
      await harness.stop();
    }
  }, 30_000);

  it('SIGTERM supervisor = 主动停机：不重启、删状态、子进程一起走', async () => {
    const harness = await SupervisorHarness.start();
    try {
      const first = await harness.waitForRunning('首个子进程就绪');
      harness.supervisor.kill('SIGTERM');

      await harness.waitFor(() => !fs.existsSync(harness.statePath), '状态文件被清掉');
      await harness.waitFor(() => harness.exitCode === 0, 'supervisor 以 0 退出');
      await harness.waitFor(() => !isRunning(first.serverPid as number), '子进程退出');

      // 再等一会儿，确认没有"自己又回来了"。
      await delay(400);
      expect(fs.existsSync(harness.statePath)).toBe(false);
      expect(harness.readCrashLog().some((entry) => entry.event === 'stop')).toBe(true);
    } finally {
      await harness.stop();
    }
  }, 30_000);

  it('服务申请 restart-after-update 后退出 → 恰好重启一次，且不计入崩溃', async () => {
    const harness = await SupervisorHarness.start();
    try {
      harness.writeControl({ announceIntent: 'restart-after-update', announceAfterMs: 100, intentExitCode: 0 });
      const first = await harness.waitForRunning('首个子进程就绪');

      const update = await harness.waitForIncident('update-restart');
      expect(update.serverPid).toBe(first.serverPid);
      expect(update.exitCode).toBe(0);

      const second = await harness.waitFor(() => {
        const state = harness.readState();
        return state?.phase === 'running' && state.serverPid && state.serverPid !== first.serverPid ? state : null;
      }, '更新之后服务被重新拉起');

      // 「恰好一次」：新世代不该再申请一遍（stub 用标记文件表达"只申请一次"）。
      await delay(600);
      const settled = harness.readState();
      expect(settled?.serverPid).toBe(second.serverPid);
      expect(settled?.restarts).toBe(1);
      expect(settled?.consecutiveCrashes).toBe(0);
      expect(harness.readCrashLog().filter((entry) => entry.event === 'update-restart')).toHaveLength(1);
    } finally {
      await harness.stop();
    }
  }, 30_000);
});
