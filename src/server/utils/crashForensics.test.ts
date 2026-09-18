import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// writeJsonLogSync 直接写 ~/.termdock，这里把 homedir 重定向到临时目录，
// 让"真的落盘了"这条能对着真实文件断言，而不是对着 mock 断言。
// 路径在 vi.hoisted 里手拼：工厂跑在 import 之前，此时 fs/path 都还在 TDZ。
const { fakeHome } = vi.hoisted(() => ({
  fakeHome: `${process.env.TMPDIR || '/tmp'}/termdock-forensics-${process.pid}`,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
});

const {
  collectCrashEvidence,
  installCrashForensics,
  isOomSuspect,
  readRuntimeTail,
  readServerLogTail,
  OOM_SUSPECT_RSS_BYTES,
} = await import('./crashForensics.js');
const { writeJsonLogSync } = await import('./serverLogger.js');

const temporaryDirectories: string[] = [fakeHome];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-forensics-case-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeRuntimeSamples(filePath: string, samples: Array<Record<string, unknown>>): void {
  fs.writeFileSync(filePath, samples.map((sample) => `${JSON.stringify(sample)}\n`).join(''));
}

describe('writeJsonLogSync', () => {
  it('同步落盘：函数返回时字节已经在磁盘上', () => {
    writeJsonLogSync('crash.log', { role: 'server', event: 'unit-test' });

    const logPath = path.join(fakeHome, '.termdock', 'crash.log');
    const [line] = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({ role: 'server', event: 'unit-test', pid: process.pid });
    expect(typeof entry.ts).toBe('string');
  });

  it('是 JSONL：追加而不是覆盖，且权限 0600', () => {
    writeJsonLogSync('crash.log', { event: 'first' });
    writeJsonLogSync('crash.log', { event: 'second' });

    const logPath = path.join(fakeHome, '.termdock', 'crash.log');
    const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).event);
    expect(events).toEqual(['first', 'second']);
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });
});

describe('readServerLogTail', () => {
  it('取尾部 N 行，并且在只读尾部时不把被截断的半行当数据', () => {
    const directory = makeTemporaryDirectory();
    fs.writeFileSync(path.join(directory, 'server.log'), ['a', 'b', 'c', 'd', 'e'].join('\n') + '\n');

    expect(readServerLogTail(3, directory)).toEqual(['c', 'd', 'e']);
  });

  it('文件不存在时返回空数组，不抛', () => {
    expect(readServerLogTail(5, makeTemporaryDirectory())).toEqual([]);
  });
});

describe('readRuntimeTail', () => {
  it('过滤掉上一世代的样本（按起止时间戳），并只取尾部 N 条', () => {
    const metricsPath = path.join(makeTemporaryDirectory(), 'runtime-metrics.log');
    writeRuntimeSamples(metricsPath, [
      { timestamp: 1_000, uptimeSeconds: 400, rssBytes: 100 },
      { timestamp: 2_000, uptimeSeconds: 1, rssBytes: 200 },
      { timestamp: 3_000, uptimeSeconds: 2, rssBytes: 300 },
      { timestamp: 4_000, uptimeSeconds: 3, rssBytes: 400 },
    ]);

    const tail = readRuntimeTail(2_000, 2, metricsPath);
    expect(tail.map((sample) => sample.timestamp)).toEqual([3_000, 4_000]);
    expect(tail[0]).toMatchObject({ rssBytes: 300, uptimeSeconds: 2 });
  });

  it('损坏行被跳过而不是让整次取证失败', () => {
    const metricsPath = path.join(makeTemporaryDirectory(), 'runtime-metrics.log');
    fs.writeFileSync(metricsPath, `{"timestamp":10,"rssBytes":1}\nnot-json\n{"timestamp":20,"rssBytes":2}\n`);

    expect(readRuntimeTail(undefined, 5, metricsPath).map((sample) => sample.timestamp)).toEqual([10, 20]);
  });

  it('文件不存在时返回空数组', () => {
    expect(readRuntimeTail(undefined, 3, path.join(makeTemporaryDirectory(), 'nope.log'))).toEqual([]);
  });
});

describe('isOomSuspect', () => {
  it('只看最后一条：RSS 逼近上限才标记', () => {
    expect(isOomSuspect([{ timestamp: 1, uptimeSeconds: 1, rssBytes: OOM_SUSPECT_RSS_BYTES, eventLoopDelayP99Ms: 0, activeConnections: 0 }])).toBe(true);
    expect(isOomSuspect([{ timestamp: 1, uptimeSeconds: 1, rssBytes: OOM_SUSPECT_RSS_BYTES - 1, eventLoopDelayP99Ms: 0, activeConnections: 0 }])).toBe(false);
    expect(isOomSuspect([])).toBe(false);
  });
});

describe('collectCrashEvidence', () => {
  it('汇总进程身份、错误栈与两侧尾部证据', () => {
    const directory = makeTemporaryDirectory();
    fs.writeFileSync(path.join(directory, 'server.log'), 'line-1\nline-2\n');
    const metricsPath = path.join(directory, 'runtime-metrics.log');
    writeRuntimeSamples(metricsPath, [{ timestamp: 5_000, uptimeSeconds: 9, rssBytes: OOM_SUSPECT_RSS_BYTES, activeConnections: 3 }]);

    const evidence = collectCrashEvidence({
      role: 'server',
      event: 'uncaught-exception',
      startedAt: 4_000,
      version: '1.4.261',
      error: new TypeError('boom'),
      logDirectory: directory,
      runtimeMetricsPath: metricsPath,
    });

    expect(evidence).toMatchObject({
      role: 'server',
      event: 'uncaught-exception',
      version: '1.4.261',
      oomSuspect: true,
      error: { name: 'TypeError', message: 'boom' },
    });
    expect(String((evidence.error as { stack: string }).stack)).toContain('boom');
    expect(evidence.logTail).toEqual(['line-1', 'line-2']);
    expect((evidence.runtimeTail as unknown[]).length).toBe(1);
  });

  it('非 Error 的 reject 值也能描述，且不会被丢成 null', () => {
    const directory = makeTemporaryDirectory();
    const evidence = collectCrashEvidence({
      role: 'server',
      event: 'unhandled-rejection',
      error: 'just a string',
      logDirectory: directory,
      runtimeMetricsPath: path.join(directory, 'none.log'),
    });

    expect(evidence.error).toEqual({ name: 'NonError', message: 'just a string' });
    expect(evidence.exitCode).toBeNull();
  });

  it('调用方给的上下文字段合并进记录，但不覆盖已经采集好的证据', () => {
    const directory = makeTemporaryDirectory();
    const evidence = collectCrashEvidence({
      role: 'server',
      event: 'port-conflict',
      logDirectory: directory,
      runtimeMetricsPath: path.join(directory, 'none.log'),
      extra: { port: 9834, host: '::' },
    });

    expect(evidence).toMatchObject({ port: 9834, host: '::', event: 'port-conflict' });
    expect(evidence.logTail).toEqual([]);
  });
});

describe('installCrashForensics 处理器', () => {
  function makeForensics(overrides: Partial<Parameters<typeof installCrashForensics>[0]> = {}) {
    const records: Record<string, unknown>[] = [];
    const exits: number[] = [];
    const logs: unknown[][] = [];
    const forensics = installCrashForensics({
      role: 'server',
      install: false,
      startedAt: Date.now() - 1_000,
      record: (entry) => records.push(entry),
      exit: (code) => exits.push(code),
      log: (...args: unknown[]) => logs.push(args),
      ...overrides,
    });
    return { forensics, records, exits, logs };
  }

  it('uncaughtException：记一条完整证据后以 1 退出', () => {
    const { forensics, records, exits } = makeForensics();

    forensics.handlers.onUncaughtException(new Error('boom'));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ role: 'server', event: 'uncaught-exception' });
    expect(exits).toEqual([1]);
  });

  it('unhandledRejection：记录但**不退出**（野 promise 不该干掉整台服务）', () => {
    const { forensics, records, exits, logs } = makeForensics();

    forensics.handlers.onUnhandledRejection(new Error('floating'));

    expect(records).toHaveLength(1);
    expect(records[0].event).toBe('unhandled-rejection');
    expect(exits).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it('exit 非 0：同步补记一条 exit-nonzero', () => {
    const { forensics, records } = makeForensics();

    forensics.handlers.onExit(3);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'exit-nonzero', exitCode: 3 });
  });

  it('exit 0 不记（正常停机不是异常）', () => {
    const { forensics, records } = makeForensics();

    forensics.handlers.onExit(0);

    expect(records).toEqual([]);
  });

  it('uncaughtException 之后的退出不再重复记一条', () => {
    const { forensics, records } = makeForensics();

    forensics.handlers.onUncaughtException(new Error('boom'));
    forensics.handlers.onExit(1);

    expect(records).toHaveLength(1);
    expect(records[0].event).toBe('uncaught-exception');
  });

  it('recordIncident：补上 context，且 record 自己抛异常时不炸穿', () => {
    const { forensics, records } = makeForensics({ context: () => ({ restarts: 2 }) });

    forensics.recordIncident('port-conflict', { extra: { port: 9834 } });

    expect(records[0]).toMatchObject({ event: 'port-conflict', port: 9834, restarts: 2 });

    const throwing = installCrashForensics({
      role: 'server',
      install: false,
      record: () => { throw new Error('disk full'); },
    });
    expect(() => throwing.recordIncident('port-conflict')).not.toThrow();
  });

  it('install:true 才挂全局处理器，dispose 后摘干净', () => {
    const before = process.listenerCount('uncaughtException');

    const forensics = installCrashForensics({ role: 'server', install: true, record: () => {} });
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(0);

    forensics.dispose();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });
});
