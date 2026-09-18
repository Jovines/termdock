/**
 * 进程内崩溃取证：进程在"运行中挂了"时，至少留下一份能说清原因的记录。
 *
 * 现状是反过来的——全仓没有 uncaughtException/unhandledRejection 处理，
 * 而 `~/.termdock/server.log` 连时间戳都没有；挂掉之后没人知道为什么。
 *
 * 职责边界：这里只负责**记录**，不负责重启（那是 supervisor 的事，见 supervisor.ts）。
 * 两者故意解耦：supervisor 覆盖不了"进程还在但内部已错乱"，进程内处理器覆盖不了
 * SIGKILL/OOM——两边各自记录，缺一边都不完整。
 *
 * 所有写盘都走 `writeJsonLogSync`：崩溃路径上事件循环已经停了，
 * 排队中的异步写永远不会落盘。
 */

import fs from 'fs';
import { getTermdockLogPath, writeJsonLogSync } from './serverLogger.js';
import { RUNTIME_METRICS_PATH, TERMDOCK_DIR } from './termdockState.js';
import { getTermdockVersion } from './version.js';

const CRASH_LOG_NAME = 'crash.log';
const LOG_TAIL_MAX_LINES = 40;
const LOG_TAIL_MAX_BYTES = 64 * 1024;
const CRASH_LOG_TAIL_LINES = 60;
const CRASH_LOG_TAIL_BYTES = 64 * 1024;
const RUNTIME_TAIL_MAX_SAMPLES = 3;
const RUNTIME_TAIL_MAX_BYTES = 32 * 1024;
const RUNTIME_TAIL_SCAN_LINES = 200;

/**
 * RSS 逼近这个值就标注 oomSuspect。与 runtimeMonitor 的 PROCESS_RSS_HIGH 临界阈值一致。
 * 这只是**启发式**：OOM killer 杀进程发的是普通 SIGKILL，和任意一次 kill -9 在信号上
 * 无法区分。它给出的是一份"当时内存有多高"的旁证，不是结论。
 */
export const OOM_SUSPECT_RSS_BYTES = 1024 ** 3;

export type CrashRole = 'server' | 'supervisor';

export interface RuntimeMarker {
  timestamp: number;
  uptimeSeconds: number;
  rssBytes: number;
  eventLoopDelayP99Ms: number;
  activeConnections: number;
}

/** 从文件尾部倒着读，最多 maxBytes，再按行切。避免为了 40 行读整个 2 MiB 日志。 */
function readTailLines(filePath: string, maxLines: number, maxBytes: number): string[] {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size === 0) return [];
    const readBytes = Math.min(stat.size, maxBytes);
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes);
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    // 起点若不是文件开头，首行大概率是被切断的半行，丢掉。
    if (readBytes < stat.size) lines.shift();
    return lines.filter((line) => line.length > 0).slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 已在错误路径上 */ }
    }
  }
}

/**
 * crash.log 尾部的记录（已解析，从旧到新）。解析不了的行直接跳过——
 * 崩溃现场写到一半被打断是常态，不能因为一行坏数据就让整份证据作废。
 */
export function readCrashLogTail(
  maxLines: number = CRASH_LOG_TAIL_LINES,
  crashLogPath: string = getTermdockLogPath(CRASH_LOG_NAME),
): Record<string, unknown>[] {
  return readTailLines(crashLogPath, maxLines, CRASH_LOG_TAIL_BYTES).flatMap((line) => {
    try {
      const entry = JSON.parse(line) as unknown;
      return entry && typeof entry === 'object' ? [entry as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/** server.log 尾部若干行，给人看的那一面（内容原样，不做解析）。 */
export function readServerLogTail(
  maxLines: number = LOG_TAIL_MAX_LINES,
  logDirectory: string = TERMDOCK_DIR,
): string[] {
  return readTailLines(getTermdockLogPath('server.log', logDirectory), maxLines, LOG_TAIL_MAX_BYTES);
}

/**
 * runtime-metrics.log 尾部若干条运行指标。样本里**没有 pid**，所以只能按时间戳过滤，
 * 并用 uptimeSeconds 交叉印证是不是同一世代。
 */
export function readRuntimeTail(
  sinceTimestamp?: number,
  maxSamples: number = RUNTIME_TAIL_MAX_SAMPLES,
  metricsPath: string = RUNTIME_METRICS_PATH,
): RuntimeMarker[] {
  const lines = readTailLines(metricsPath, RUNTIME_TAIL_SCAN_LINES, RUNTIME_TAIL_MAX_BYTES);
  return lines.flatMap((line) => {
    try {
      const sample = JSON.parse(line) as Partial<RuntimeMarker>;
      if (!Number.isFinite(sample.timestamp)) return [];
      if (sinceTimestamp !== undefined && (sample.timestamp as number) < sinceTimestamp) return [];
      return [{
        timestamp: sample.timestamp as number,
        uptimeSeconds: sample.uptimeSeconds ?? 0,
        rssBytes: sample.rssBytes ?? 0,
        eventLoopDelayP99Ms: sample.eventLoopDelayP99Ms ?? 0,
        activeConnections: sample.activeConnections ?? 0,
      }];
    } catch {
      return [];
    }
  }).slice(-maxSamples);
}

export function isOomSuspect(samples: RuntimeMarker[]): boolean {
  const last = samples.at(-1);
  return Boolean(last && last.rssBytes >= OOM_SUSPECT_RSS_BYTES);
}

export interface CrashEvidenceOptions {
  role: CrashRole;
  event: string;
  /** 本世代进程启动时刻，用于把运行指标限制在本世代 */
  startedAt?: number;
  version?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  /** 崩溃对象的可读化形态（栈等） */
  error?: unknown;
  extra?: Record<string, unknown>;
  /** 测试注入：证据来源目录 */
  logDirectory?: string;
  runtimeMetricsPath?: string;
}

function describeError(error: unknown): Record<string, unknown> | null {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  if (error === undefined) return null;
  return { name: 'NonError', message: String(error) };
}

/** 组装一条完整现场：进程身份 + 退出信息 + 错误 + server.log 尾部 + 运行指标尾部。 */
export function collectCrashEvidence(options: CrashEvidenceOptions): Record<string, unknown> {
  const runtimeTail = readRuntimeTail(options.startedAt, undefined, options.runtimeMetricsPath);
  return {
    role: options.role,
    event: options.event,
    version: options.version ?? null,
    uptimeMs: options.startedAt !== undefined ? Date.now() - options.startedAt : null,
    exitCode: options.exitCode ?? null,
    signal: options.signal ?? null,
    oomSuspect: isOomSuspect(runtimeTail),
    error: describeError(options.error),
    ...(options.extra ?? {}),
    runtimeTail,
    logTail: readServerLogTail(undefined, options.logDirectory),
  };
}

export interface CrashForensicsOptions {
  role: CrashRole;
  version?: string | null;
  /** 本世代进程启动时刻（ms） */
  startedAt?: number;
  /** 每次记录时补充的上下文字段 */
  context?: () => Record<string, unknown>;
  /** 注入点（测试用）。默认写 crash.log / console.error / process.exit。 */
  record?: (entry: Record<string, unknown>) => void;
  log?: (message: string, error?: unknown) => void;
  exit?: (code: number) => void;
  /** 是否把处理器挂到全局 process 上。测试用 false 取处理器直接调，避免污染测试进程。 */
  install?: boolean;
}

export interface CrashForensicsHandlers {
  onUncaughtException: (error: unknown) => void;
  onUnhandledRejection: (reason: unknown) => void;
  onExit: (code: number) => void;
}

export interface CrashForensics {
  /** 记一条非致命异常（如 supervisor 断链、端口冲突），不退出进程。 */
  recordIncident: (event: string, extra?: Record<string, unknown>) => void;
  /** 处理器本体。生产环境由 process.on 驱动；测试直接调用以免惊动 vitest 自己的处理器。 */
  handlers: CrashForensicsHandlers;
  /** 移除已安装的处理器（install:false 时无事可做）。 */
  dispose: () => void;
}

function defaultRecord(entry: Record<string, unknown>): void {
  writeJsonLogSync(CRASH_LOG_NAME, entry);
}

/**
 * 安装全局崩溃取证。返回的 `recordIncident` 供调用方记录已知的异常事件。
 *
 * 注意 `unhandledRejection`：装上监听器就等于**接管了 Node 默认的 crash-on-unhandled-rejection**。
 * 对一台会话服务器，这是有意的政策——一个没人 await 的 promise 不该干掉整台服务；
 * 真卡死了还有 supervisor 的健康探测兜底。代价是坏不变量可能带病存续，
 * 所以这里记录得足够响（crash.log + stderr），任何一条都不该被忽略。
 */
export function installCrashForensics(options: CrashForensicsOptions): CrashForensics {
  const record = options.record ?? defaultRecord;
  const log = options.log ?? ((message: string, error?: unknown) => console.error(message, error ?? ''));
  const exit = options.exit ?? ((code: number) => process.exit(code));

  // 崩溃处理器自己抛异常会再次进入处理器，这是经典死循环；守卫必须是闭包级的。
  let recording = false;
  // uncaughtException 已经记过一条完整的，退出处理器不要再记一条重复的。
  let fatalRecorded = false;

  const recordIncident = (event: string, extra: Record<string, unknown> = {}): void => {
    if (recording) return;
    recording = true;
    try {
      const { extra: nested, ...fields } = extra;
      record(collectCrashEvidence({
        role: options.role,
        event,
        startedAt: options.startedAt,
        version: options.version,
        ...fields,
        extra: { ...(options.context?.() ?? {}), ...(nested as Record<string, unknown> ?? {}) },
      }));
    } catch {
      // 取证失败绝不能变成第二个故障。
    } finally {
      recording = false;
    }
  };

  const handlers: CrashForensicsHandlers = {
    onUncaughtException: (error: unknown) => {
      fatalRecorded = true;
      recordIncident('uncaught-exception', { error });
      log('[termdock] uncaught exception:', error);
      exit(1);
    },
    onUnhandledRejection: (reason: unknown) => {
      recordIncident('unhandled-rejection', { error: reason });
      log('[termdock] unhandled rejection (service keeps running):', reason);
    },
    onExit: (code: number) => {
      if (code === 0 || fatalRecorded) return;
      // 这里事件循环已经停了：只能同步写。
      recordIncident('exit-nonzero', { exitCode: code });
    },
  };

  const installed = options.install !== false;
  if (installed) {
    process.on('uncaughtException', handlers.onUncaughtException);
    process.on('unhandledRejection', handlers.onUnhandledRejection);
    process.on('exit', handlers.onExit);
  }

  return {
    recordIncident,
    handlers,
    dispose: () => {
      if (!installed) return;
      process.off('uncaughtException', handlers.onUncaughtException);
      process.off('unhandledRejection', handlers.onUnhandledRejection);
      process.off('exit', handlers.onExit);
    },
  };
}

/**
 * supervisor 断链时由服务侧记录。**不自杀**：服务本身是健康的，
 * 丢监督好过丢服务。界面红点靠这条记录来提示"现在没人看着它了"。
 */
export function recordSupervisorLost(detail: string): void {
  writeJsonLogSync(CRASH_LOG_NAME, {
    role: 'server',
    event: 'supervisor-lost',
    detail,
    version: getTermdockVersion(),
    serverPid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1_000),
  });
}

export { CRASH_LOG_NAME };
