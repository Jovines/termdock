#!/usr/bin/env node
/**
 * termdock supervisor — 盯住服务子进程，挂了就重启，并把原因记下来。
 *
 * 它解决的是两件今天无人负责的事：
 *  1. 自动更新后新进程没起来（旧实现是发射后不管的 `node -e` bridge，不验证、不重试）；
 *  2. 运行中崩溃（全仓没有 uncaughtException 处理，server.log 连时间戳都没有）。
 *
 * 形态：一个**独立进程**，不是服务内的自重启。自重启活不过 SIGKILL/OOM，
 * 而那两种恰恰是最需要被兜住的。
 *
 * 架构：
 * ```
 * td / setsid          (launcher，短命)
 *  └─ supervisor       (detached 或前台，stdio 指向 server.log + ipc)
 *      └─ server       (同进程组，stdio 同样指向 server.log + ipc)
 * ```
 * 子进程刻意**不 detached**：同进程组便于整组 kill。但 supervisor 自己死掉时
 * 不连坐杀服务——丢监督好过丢服务。
 *
 * Standalone entry: 只依赖 node stdlib + utils/ 下几个轻量模块，
 * **绝不 import cli.ts / entry.ts**（那会拖进整个服务运行时）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backoffDelayMs } from './utils/backoff.js';
import { installCrashForensics, isOomSuspect, readRuntimeTail, readServerLogTail } from './utils/crashForensics.js';
import { probeHealthOnce, HEALTH_PROBE_TIMEOUT_MS } from './utils/healthProbe.js';
import { writeJsonLogSync } from './utils/serverLogger.js';
import {
  SUPERVISOR_STATE_VERSION,
  classifyChildExit,
  isReadyMessage,
  isStartupFailedMessage,
  isServerIntentMessage,
  shouldGiveUp,
  type ExitDecision,
  type ExitObservation,
  type RestartIntent,
  type SupervisorIncident,
  type SupervisorPhase,
  type SupervisorToLauncherMessage,
} from './utils/supervisorProtocol.js';
import {
  SUPERVISOR_STATE_PATH,
  STOP_GRACE_MS,
  isProcessRunning,
  removeJsonState,
  writeJsonStateAtomic,
} from './utils/termdockState.js';

export interface SupervisorTiming {
  /** 子进程必须在这个时间内 ready，否则按启动失败处理 */
  readyTimeoutMs: number;
  /** 健康探测间隔 */
  healthIntervalMs: number;
  /** 单次探测超时 */
  healthProbeTimeoutMs: number;
  /** 连续失败几次判定卡死 */
  wedgeFailures: number;
  /** SIGTERM 之后等多久 SIGKILL */
  killGraceMs: number;
  /** 更新重启的固定延迟（不进退避） */
  restartDelayMs: number;
  /** 连续健康运行多久把崩溃计数清零 */
  crashResetMs: number;
  /** 连续崩溃多少次后停手 */
  maxConsecutiveCrashes: number;
  /** 崩溃重启的退避基数/上限 */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_SUPERVISOR_TIMING: SupervisorTiming = {
  readyTimeoutMs: 30_000,
  healthIntervalMs: 30_000,
  healthProbeTimeoutMs: HEALTH_PROBE_TIMEOUT_MS,
  wedgeFailures: 3,
  killGraceMs: STOP_GRACE_MS,
  restartDelayMs: 250,
  crashResetMs: 60_000,
  maxConsecutiveCrashes: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
};

/**
 * 节奏可以由 `TERMDOCK_SUPERVISOR_TIMING`（JSON）覆盖。
 *
 * 存在的理由之一是测试：崩溃循环用例要么等 5 次真实退避（1+2+4+8+16 = 31s），
 * 要么把节奏变成可注入的。顺带它也是生产上的调参口子（探测密度、退避上限）。
 * 只接受**正数**：0 会让 setInterval 空转。
 */
export function resolveTimingFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<SupervisorTiming> {
  const raw = env.TERMDOCK_SUPERVISOR_TIMING;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write('[supervisor] TERMDOCK_SUPERVISOR_TIMING is not valid JSON; using defaults\n');
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const source = parsed as Record<string, unknown>;
  const overrides: Partial<SupervisorTiming> = {};
  for (const key of Object.keys(DEFAULT_SUPERVISOR_TIMING) as Array<keyof SupervisorTiming>) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) overrides[key] = value;
  }
  return overrides;
}

export interface SupervisorConfig {
  /** 子进程 entry（每次重启都从这里重新读盘，所以更新后拿到的永远是新的） */
  childEntry: string;
  /** 子进程参数（不含 entry 自己与 --foreground） */
  childArgs: string[];
  healthUrl: string;
  healthCaPath?: string;
  /** 版本标签，只用于记录 */
  version?: string | null;
  /** 测试注入：覆盖探测/退避节奏 */
  timing?: Partial<SupervisorTiming>;
}

/** supervisor 需要的最小 child 接口，测试可以拿假的顶替真进程。 */
export interface SupervisedChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
}

export interface SupervisorDeps {
  spawnChild: (config: SupervisorConfig) => SupervisedChild;
  probe: typeof probeHealthOnce;
  recordIncident: (entry: Record<string, unknown>) => void;
  /** supervisor 自己的一行日志（前缀 + 时间），走 stderr → server.log */
  log: (message: string) => void;
  exit: (code: number) => void;
  now: () => number;
  /** 状态文件的读写，测试可重定向 */
  writeState: (state: unknown) => void;
  clearState: () => void;
  /** 回报 launcher（`td` 后台模式在等这个）。没有 IPC 通道时是 no-op。 */
  notifyLauncher: (message: SupervisorToLauncherMessage) => void;
}

export function defaultSpawnChild(config: SupervisorConfig): SupervisedChild {
  const child = spawn(process.execPath, [config.childEntry, '--foreground', ...config.childArgs], {
    detached: false,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      TERMDOCK_SUPERVISED: '1',
      // 给子进程一个能指名道姓的 pid：它的 disconnect 处理器要靠这个说清
      // "是谁丢下了我"，`ps` 里也能直接认出来。
      TERMDOCK_SUPERVISOR_PID: String(process.pid),
    },
  });
  // spawn 失败（ENOENT / EACCES）只会在 'error' 里出现，不会走 'exit'。
  // 旧实现两个 spawn 都没挂 error 处理，于是"启动失败"表现为"什么都没发生"。
  return child as unknown as SupervisedChild;
}

export function defaultNotifyLauncher(message: SupervisorToLauncherMessage): void {
  if (process.connected) process.send?.(message);
}

export function defaultLog(message: string): void {
  // 走 stderr：它和子进程的 stdout/stderr 是同一个 fd（server.log），
  // 于是 `tail -f ~/.termdock/server.log` 能同时看到服务和监督者的叙述。
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

export interface SupervisionHandle {
  /** 当前 phase（供 launcher 读） */
  phase: () => SupervisorPhase;
  start: () => void;
  /** 停止监督：杀子进程、删状态、退出。 */
  stop: () => void;
  /** 重启一次子进程，但继续监督（`td --restart` / SIGHUP）。 */
  restart: () => void;
}

/**
 * 监督一台服务。返回对象由入口按需驱动；测试直接调 handlers。
 *
 * 这里不装全局进程处理器——入口（main）负责那些，本函数只管状态机。
 */
export function createSupervisor(config: SupervisorConfig, deps: SupervisorDeps): SupervisionHandle {
  const timing: SupervisorTiming = { ...DEFAULT_SUPERVISOR_TIMING, ...(config.timing ?? {}) };
  const now = deps.now ?? (() => Date.now());
  const supervisorStartedAt = now();

  let child: SupervisedChild | null = null;
  let childPid: number | null = null;
  let childStartedAt = 0;
  let becameReady = false;
  /** 本世代的 IPC 意图，随每次 spawn 重置 */
  let intent: RestartIntent | null = null;
  let portConflict = false;
  let wedgeKill = false;
  let stopRequested = false;
  let restartRequested = false;
  let consecutiveCrashes = 0;
  let restarts = 0;
  let lastIncident: SupervisorIncident | null = null;
  let lastHealthOkAt: number | null = null;
  let healthFailures = 0;
  let phase: SupervisorPhase = 'starting';
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let crashResetTimer: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  const clearTimers = () => {
    for (const timer of [readyTimer, healthTimer, crashResetTimer, restartTimer]) {
      if (timer) clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
    readyTimer = null;
    healthTimer = null;
    crashResetTimer = null;
    restartTimer = null;
  };

  const persistState = () => {
    deps.writeState({
      version: SUPERVISOR_STATE_VERSION,
      pid: process.pid,
      serverPid: childPid,
      phase,
      startedAt: supervisorStartedAt,
      restarts,
      consecutiveCrashes,
      lastIncident,
    });
  };

  const setPhase = (next: SupervisorPhase) => {
    phase = next;
    persistState();
  };

  function startChild(): void {
    intent = null;
    portConflict = false;
    wedgeKill = false;
    restartRequested = false;
    becameReady = false;
    healthFailures = 0;
    childStartedAt = now();
    setPhase('starting');

    let errored: Error | null = null;
    const spawned = deps.spawnChild(config);
    child = spawned;
    childPid = spawned.pid ?? null;

    spawned.on('error', (error: Error) => {
      errored = error;
      deps.log(`[supervisor] failed to spawn child: ${error.message}`);
      // 抢在 'exit' 之前记下原因；真正的出口统一走 handleExit。
      portConflict = false;
      handleExit(null, null, error);
    });

    spawned.on('message', (message: unknown) => {
      if (isReadyMessage(message)) {
        becameReady = true;
        lastHealthOkAt = now();
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
        setPhase('running');
        armCrashReset();
        deps.log(`[supervisor] server ready (pid ${childPid ?? 'unknown'}, restarts ${restarts})`);
        // 透传给 launcher：`td` 后台模式等的就是这个，而不是自己盲等 10 秒。
        deps.notifyLauncher({ type: 'termdock-ready' });
        return;
      }
      if (isStartupFailedMessage(message) && !becameReady) {
        portConflict = message.reason === 'port-conflict';
        return;
      }
      if (isServerIntentMessage(message)) {
        intent = message.intent;
        deps.log(`[supervisor] server declared intent: ${message.intent}`);
      }
    });

    spawned.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (errored) return;
      handleExit(code, signal, null);
    });

    readyTimer = setTimeout(() => {
      if (becameReady || stopping) return;
      deps.log(`[supervisor] server did not become ready within ${timing.readyTimeoutMs}ms; restarting`);
      wedgeKill = false;
      killChild('SIGTERM');
    }, timing.readyTimeoutMs);

    armHealthProbe();
  }

  /** 连续健康运行满 crashResetMs 就把崩溃计数清零——否则一天里零星崩 5 次也会被判"放弃"。 */
  function armCrashReset(): void {
    if (crashResetTimer) clearTimeout(crashResetTimer);
    const generation = childPid;
    crashResetTimer = setTimeout(() => {
      if (childPid !== generation || !becameReady) return;
      if (consecutiveCrashes !== 0) {
        deps.log(`[supervisor] server stayed healthy for ${timing.crashResetMs}ms; clearing crash counter`);
      }
      consecutiveCrashes = 0;
      persistState();
    }, timing.crashResetMs);
  }

  /**
   * 健康探测。卡死的事件循环不会应答任何请求，所以"超时"就是"卡死"，
   * 不需要额外的心跳协议。
   */
  function armHealthProbe(): void {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => {
      if (stopping || !becameReady || !child) return;
      void deps.probe(config.healthUrl, config.healthCaPath, timing.healthProbeTimeoutMs).then((result) => {
        if (stopping || !child) return;
        if (result.ok) {
          healthFailures = 0;
          lastHealthOkAt = now();
          return;
        }
        healthFailures += 1;
        deps.log(`[supervisor] health probe failed (${healthFailures}/${timing.wedgeFailures}): ${result.failure ?? 'unknown'}`);
        if (healthFailures < timing.wedgeFailures) return;
        healthFailures = 0;
        wedgeKill = true;
        deps.log('[supervisor] server looks wedged; killing it so it can be restarted');
        killChild('SIGTERM');
      });
    }, timing.healthIntervalMs);
  }

  function killChild(signal: NodeJS.Signals): void {
    if (!child) return;
    try {
      child.kill(signal);
    } catch {
      // 进程可能刚退出，'exit' 会跟上。
      return;
    }
    if (signal !== 'SIGTERM' || !childPid) return;
    const targetPid = childPid;
    const deadline = now() + timing.killGraceMs;
    const escalate = setInterval(() => {
      if (childPid !== targetPid || !isProcessRunning(targetPid)) {
        clearInterval(escalate);
        return;
      }
      if (now() >= deadline) {
        clearInterval(escalate);
        deps.log(`[supervisor] child ${targetPid} ignored SIGTERM; sending SIGKILL`);
        try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, Math.max(100, Math.min(1_000, timing.killGraceMs / 4)));
    // 该 interval 不该拖住 supervisor 的退出。
    (escalate as { unref?: () => void }).unref?.();
  }

  function handleExit(code: number | null, signal: NodeJS.Signals | null, spawnError: Error | null): void {
    // 停止请求不做提前返回：它要走的是分类表里的 `stop` 分支（记录 + 删状态 + 退出 0）。
    // 这里若直接 return，`--stop` 就会在 crash.log 里留下一段无法解释的空白。
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    if (crashResetTimer) { clearTimeout(crashResetTimer); crashResetTimer = null; }

    const uptimeMs = now() - childStartedAt;
    const exitedPid = childPid;
    child = null;
    childPid = null;

    const runtimeTail = readRuntimeTail(childStartedAt);
    const oomSuspect = isOomSuspect(runtimeTail);
    const observation: ExitObservation = {
      intent,
      exitCode: code,
      signal,
      becameReady,
      supervisorStopRequested: stopRequested,
      restartRequested,
      wedge: wedgeKill,
      portConflict,
      oomSuspect,
    };
    const decision = classifyChildExit(observation);

    // 计数先于记录：crash.log 里的 `consecutiveCrashes` 应当读作
    // "算上这一次的第几次"，否则五连崩会记成 0/1/2/3/4，而 gave-up 那条写 5。
    if (decision.resetBackoff) consecutiveCrashes = 0;
    else if (decision.countAsCrash) consecutiveCrashes += 1;

    lastIncident = {
      at: now(),
      event: decision.event,
      detail: spawnError ? `failed to spawn: ${spawnError.message}` : decision.detail,
      exitCode: code,
      signal,
      uptimeMs,
      version: config.version ?? null,
      oomSuspect,
      restartCount: restarts,
    };

    recordIncident(decision, observation, {
      serverPid: exitedPid,
      uptimeMs,
      runtimeTail,
      spawnError: spawnError?.message ?? null,
    });

    // 第一世代就没起来：立刻告诉 launcher，别让它空等到超时。
    // 之后 supervisor 仍会按退避继续重试，所以只说"这次没起来"，不说"放弃了"。
    if (restarts === 0 && !becameReady && !stopRequested) {
      deps.notifyLauncher({
        type: 'termdock-startup-failed',
        reason: spawnError ? 'spawn-failed' : decision.event,
        detail: spawnError ? spawnError.message : decision.detail,
      });
    }

    if (!decision.restart) {
      deps.log(`[supervisor] server ${decision.event} (${decision.detail}); not restarting`);
      setPhase('stopped');
      deps.clearState();
      deps.exit(0);
      return;
    }

    if (shouldGiveUp(consecutiveCrashes, timing.maxConsecutiveCrashes)) {
      deps.log(`[supervisor] ${consecutiveCrashes} consecutive crashes; giving up. Service is NOT running.`);
      recordApplicationGaveUp();
      setPhase('gave-up');
      deps.exit(1);
      return;
    }

    restarts += 1;
    const delayMs = decision.event === 'update-restart' || decision.event === 'manual-restart'
      ? timing.restartDelayMs
      : backoffDelayMs(consecutiveCrashes, { baseMs: timing.backoffBaseMs, maxMs: timing.backoffMaxMs });
    setPhase('restarting');
    deps.log(`[supervisor] restarting server in ${delayMs}ms (event=${decision.event}, restarts=${restarts})`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopping) return;
      startChild();
    }, delayMs);
  }

  function recordApplicationGaveUp(): void {
    deps.recordIncident({
      role: 'supervisor',
      event: 'gave-up',
      detail: `gave up after ${consecutiveCrashes} consecutive failures: ${lastIncident?.detail ?? 'unknown cause'}`,
      version: config.version ?? null,
      restarts,
      lastIncident,
      restartCommand: config.version ? `npm i -g termdock@${config.version}` : null,
    });
  }

  function recordIncident(
    decision: ExitDecision,
    observation: ExitObservation,
    extra: Record<string, unknown>,
  ): void {
    deps.recordIncident({
      role: 'supervisor',
      event: decision.event,
      detail: decision.detail,
      exitCode: observation.exitCode,
      signal: observation.signal,
      version: config.version ?? null,
      supervisorPid: process.pid,
      restartCount: restarts,
      consecutiveCrashes,
      lastHealthOkAt,
      ...extra,
      logTail: readServerLogTail(),
    });
  }

  /** launcher 发的停止请求：杀子进程、删状态、退出。收尾统一走 handleExit 的 `stop` 分支。 */
  function stop(): void {
    if (stopping) return;
    stopping = true;
    stopRequested = true;
    clearTimers();
    if (!child) {
      deps.clearState();
      deps.exit(0);
      return;
    }
    killChild('SIGTERM');
    // 兜底：子进程迟迟不退（僵尸、收不到信号）也不能让 --stop 挂住。
    setTimeout(() => {
      deps.clearState();
      deps.exit(0);
    }, timing.killGraceMs + 1_000).unref?.();
  }

  /** `td --restart`：不发停止请求，只让子进程重启一次。 */
  function restart(): void {
    if (stopping || !child) return;
    restartRequested = true;
    deps.log('[supervisor] manual restart requested');
    killChild('SIGTERM');
  }

  return {
    phase: () => phase,
    start: () => { startChild(); },
    stop,
    restart,
  };
}

/** 供 CLI 复用的 supervisor 入口地址（与 cli.js 同目录）。 */
export function resolveSupervisorEntry(): string {
  return fileURLToPath(new URL('./supervisor.js', import.meta.url));
}

// —— 独立入口 ——

interface ParsedSupervisorArgs {
  healthUrl: string;
  healthCaPath?: string;
  version?: string;
  childEntry: string;
  childArgs: string[];
}

function parseArgs(argv: string[]): ParsedSupervisorArgs | null {
  const separator = argv.indexOf('--');
  const own = separator >= 0 ? argv.slice(0, separator) : argv;
  const childArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  const value = (flag: string): string | undefined => {
    const index = own.indexOf(flag);
    return index >= 0 ? own[index + 1] : undefined;
  };
  const healthUrl = value('--health-url');
  const childEntry = value('--child');
  if (!healthUrl || !childEntry) return null;
  return {
    healthUrl,
    healthCaPath: value('--health-ca'),
    version: value('--version'),
    childEntry,
    childArgs,
  };
}

/**
 * 以**当前进程**作为 supervisor 启动监督（装全局处理器 + 信号处理 + 开跑）。
 *
 * 两条入口共用：`supervisor.js` 独立入口（`td` 后台模式 spawn 它），
 * 以及 `td --supervise`（cli.ts 进程自己当 supervisor，给 setsid/systemd 用）。
 */
export function runSupervisor(
  config: SupervisorConfig,
  overrides: Partial<SupervisorDeps> = {},
): SupervisionHandle {
  const forensics = installCrashForensics({ role: 'supervisor', version: config.version ?? null });
  const handle = createSupervisor(config, {
    spawnChild: defaultSpawnChild,
    probe: probeHealthOnce,
    recordIncident: (entry) => writeJsonLogSync('crash.log', entry),
    log: defaultLog,
    exit: (code) => {
      forensics.dispose();
      process.exit(code);
    },
    now: () => Date.now(),
    writeState: (state) => writeJsonStateAtomic(SUPERVISOR_STATE_PATH, state),
    clearState: () => removeJsonState(SUPERVISOR_STATE_PATH),
    notifyLauncher: defaultNotifyLauncher,
    ...overrides,
  });

  const stop = () => { handle.stop(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', () => handle.restart());

  // launcher 断了不该影响监督：它已经拿到了 ready/失败，之后 supervisor 自己活着。
  process.on('disconnect', () => { /* launcher 走了，继续盯 */ });

  handle.start();
  return handle;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write('Usage: supervisor --health-url <url> --child <entry> [--health-ca <path>] [--version <v>] -- [child args]\n');
    process.exit(2);
  }

  // realpath 一次，之后每次重启都用这个绝对路径：既绕开 `npm i -g` 删建符号链接
  // 窗口里的 ENOENT，也消除"重启落到了另一个安装"的歧义（PATH 按名字找会）。
  let childEntry: string;
  try {
    childEntry = fs.realpathSync(parsed.childEntry);
  } catch (error) {
    process.stderr.write(`[supervisor] child entry is not readable: ${parsed.childEntry} (${(error as Error).message})\n`);
    process.exit(2);
    return;
  }

  runSupervisor({
    childEntry,
    childArgs: parsed.childArgs,
    healthUrl: parsed.healthUrl,
    healthCaPath: parsed.healthCaPath,
    version: parsed.version,
    timing: resolveTimingFromEnv(),
  });
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main();
}
