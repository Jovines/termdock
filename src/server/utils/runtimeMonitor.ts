import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

const SAMPLE_INTERVAL_MS = 10_000;
const HISTORY_INTERVAL_MS = 60_000;
const MAX_HISTORY_SAMPLES = 24 * 60;

export type RuntimeHealthStatus = 'ok' | 'warning' | 'critical';

export interface RuntimeMetricSample {
  timestamp: number;
  uptimeSeconds: number;
  cpuProcessPercent: number;
  cpuHostCapacityPercent: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  eventLoopDelayP99Ms: number;
  diskReadBytesPerSecond: number;
  diskWriteBytesPerSecond: number;
  networkReadBytesPerSecond: number;
  networkWriteBytesPerSecond: number;
  activeConnections: number;
  requestsPerSecond: number;
  requestErrorRatio: number;
  requestLatencyP95Ms: number;
}

export interface RuntimeStorageSnapshot {
  root: string;
  totalBytes: number;
  fileCount: number;
  truncated: boolean;
  freeBytes: number | null;
  totalFilesystemBytes: number | null;
  topLevel: Array<{ name: string; bytes: number }>;
}

export interface RuntimeFinding {
  severity: Exclude<RuntimeHealthStatus, 'ok'>;
  code: string;
  message: string;
  value: number;
  threshold: number;
}

interface IoCounters { readBytes: number; writeBytes: number }
interface SocketCounters { read: number; written: number }

export interface RuntimeDiagnostics {
  status: RuntimeHealthStatus;
  generatedAt: number;
  current: RuntimeMetricSample;
  history: RuntimeMetricSample[];
  storage: RuntimeStorageSnapshot;
  findings: RuntimeFinding[];
  scopes: {
    cpu: 'termdock-process';
    memory: 'termdock-process';
    diskIo: 'termdock-process';
    networkIo: 'termdock-http-sockets';
    storage: 'termdock-state-directory';
  };
}

export interface RuntimeMonitorOptions {
  stateDirectory: string;
  historyPath?: string;
  sampleIntervalMs?: number;
  historyIntervalMs?: number;
  maxHistorySamples?: number;
}

function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * quantile))] ?? 0;
}

function readProcessIo(): IoCounters {
  if (process.platform !== 'linux') return { readBytes: 0, writeBytes: 0 };
  try {
    const values = new Map(
      fs.readFileSync('/proc/self/io', 'utf8').trim().split('\n').map((line) => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator), Number(line.slice(separator + 1).trim())] as const;
      }),
    );
    return { readBytes: values.get('read_bytes') ?? 0, writeBytes: values.get('write_bytes') ?? 0 };
  } catch {
    return { readBytes: 0, writeBytes: 0 };
  }
}

async function collectStorageSnapshot(root: string, maxEntries = 20_000): Promise<RuntimeStorageSnapshot> {
  const totals = new Map<string, number>();
  const queue = [root];
  let totalBytes = 0;
  let fileCount = 0;
  let visited = 0;
  while (queue.length > 0 && visited < maxEntries) {
    const directory = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (visited >= maxEntries) break;
      visited += 1;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) { queue.push(entryPath); continue; }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.stat(entryPath);
        totalBytes += stat.size;
        fileCount += 1;
        const topLevelName = path.relative(root, entryPath).split(path.sep)[0] || entry.name;
        totals.set(topLevelName, (totals.get(topLevelName) ?? 0) + stat.size);
      } catch { /* The file may disappear while diagnostics walk the directory. */ }
    }
  }
  let freeBytes: number | null = null;
  let totalFilesystemBytes: number | null = null;
  try {
    const stat = await fs.promises.statfs(root);
    freeBytes = stat.bavail * stat.bsize;
    totalFilesystemBytes = stat.blocks * stat.bsize;
  } catch { /* Not available on every supported filesystem. */ }
  return {
    root, totalBytes, fileCount, truncated: queue.length > 0 || visited >= maxEntries,
    freeBytes, totalFilesystemBytes,
    topLevel: [...totals.entries()].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, 20),
  };
}

export function evaluateRuntimeHealth(sample: RuntimeMetricSample, storage: RuntimeStorageSnapshot): RuntimeFinding[] {
  const findings: RuntimeFinding[] = [];
  const add = (severity: RuntimeFinding['severity'], code: string, message: string, value: number, threshold: number) => {
    findings.push({ severity, code, message, value: round(value), threshold });
  };
  if (sample.rssBytes >= 1024 ** 3) add('critical', 'PROCESS_RSS_HIGH', 'Termdock 内存占用超过 1 GiB', sample.rssBytes, 1024 ** 3);
  else if (sample.rssBytes >= 512 * 1024 ** 2) add('warning', 'PROCESS_RSS_HIGH', 'Termdock 内存占用超过 512 MiB', sample.rssBytes, 512 * 1024 ** 2);
  if (sample.eventLoopDelayP99Ms >= 500) add('critical', 'EVENT_LOOP_STALLED', 'Node.js 事件循环 P99 延迟过高', sample.eventLoopDelayP99Ms, 500);
  else if (sample.eventLoopDelayP99Ms >= 100) add('warning', 'EVENT_LOOP_SLOW', 'Node.js 事件循环 P99 延迟偏高', sample.eventLoopDelayP99Ms, 100);
  if (sample.diskWriteBytesPerSecond >= 25 * 1024 ** 2) add('critical', 'DISK_WRITE_RATE_HIGH', 'Termdock 持续磁盘写入速率过高', sample.diskWriteBytesPerSecond, 25 * 1024 ** 2);
  else if (sample.diskWriteBytesPerSecond >= 5 * 1024 ** 2) add('warning', 'DISK_WRITE_RATE_HIGH', 'Termdock 磁盘写入速率偏高', sample.diskWriteBytesPerSecond, 5 * 1024 ** 2);
  if (sample.activeConnections >= 1000) add('critical', 'CONNECTION_COUNT_HIGH', 'Termdock 活跃连接数过高', sample.activeConnections, 1000);
  else if (sample.activeConnections >= 200) add('warning', 'CONNECTION_COUNT_HIGH', 'Termdock 活跃连接数偏高', sample.activeConnections, 200);
  if (sample.requestsPerSecond >= 0.25 && sample.requestErrorRatio >= 0.25) add('critical', 'REQUEST_ERROR_RATIO_HIGH', '最近采样窗口请求错误率过高', sample.requestErrorRatio, 0.25);
  else if (sample.requestsPerSecond >= 0.25 && sample.requestErrorRatio >= 0.1) add('warning', 'REQUEST_ERROR_RATIO_HIGH', '最近采样窗口请求错误率偏高', sample.requestErrorRatio, 0.1);
  if (sample.requestLatencyP95Ms >= 5_000) add('critical', 'REQUEST_LATENCY_HIGH', '请求 P95 延迟超过 5 秒', sample.requestLatencyP95Ms, 5_000);
  else if (sample.requestLatencyP95Ms >= 1_000) add('warning', 'REQUEST_LATENCY_HIGH', '请求 P95 延迟超过 1 秒', sample.requestLatencyP95Ms, 1_000);
  if (storage.totalBytes >= 2 * 1024 ** 3) add('critical', 'STATE_DIRECTORY_LARGE', 'Termdock 状态目录超过 2 GiB', storage.totalBytes, 2 * 1024 ** 3);
  else if (storage.totalBytes >= 512 * 1024 ** 2) add('warning', 'STATE_DIRECTORY_LARGE', 'Termdock 状态目录超过 512 MiB', storage.totalBytes, 512 * 1024 ** 2);
  if (storage.freeBytes !== null && storage.totalFilesystemBytes) {
    const freeRatio = storage.freeBytes / storage.totalFilesystemBytes;
    if (storage.freeBytes <= 1024 ** 3 || freeRatio <= 0.05) add('critical', 'DISK_SPACE_LOW', 'Termdock 所在磁盘剩余空间严重不足', freeRatio, 0.05);
    else if (storage.freeBytes <= 5 * 1024 ** 3 || freeRatio <= 0.1) add('warning', 'DISK_SPACE_LOW', 'Termdock 所在磁盘剩余空间偏低', freeRatio, 0.1);
  }
  return findings;
}

export class RuntimeMonitor {
  private readonly stateDirectory: string;
  private readonly historyPath: string | null;
  private readonly sampleIntervalMs: number;
  private readonly historyIntervalMs: number;
  private readonly maxHistorySamples: number;
  private readonly sockets = new Map<Socket, SocketCounters>();
  private readonly eventLoopHistogram: IntervalHistogram;
  private history: RuntimeMetricSample[] = [];
  private current: RuntimeMetricSample | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private lastHistoryAt = 0;
  private previousAt = Date.now();
  private previousCpu = process.cpuUsage();
  private previousIo = readProcessIo();
  private closedSocketBytes: SocketCounters = { read: 0, written: 0 };
  private previousSocketBytes: SocketCounters = { read: 0, written: 0 };
  private requestDurations: number[] = [];
  private requestCount = 0;
  private requestErrors = 0;

  constructor(options: RuntimeMonitorOptions) {
    this.stateDirectory = options.stateDirectory;
    this.historyPath = options.historyPath ?? null;
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.historyIntervalMs = options.historyIntervalMs ?? HISTORY_INTERVAL_MS;
    this.maxHistorySamples = options.maxHistorySamples ?? MAX_HISTORY_SAMPLES;
    this.eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    this.loadHistory();
  }

  start(): void {
    if (this.sampleTimer) return;
    this.eventLoopHistogram.enable();
    this.sample();
    this.sampleTimer = setInterval(() => this.sample(), this.sampleIntervalMs);
    this.sampleTimer.unref?.();
  }

  stop(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    this.eventLoopHistogram.disable();
  }

  trackSocket(socket: Socket): void {
    if (this.sockets.has(socket)) return;
    this.sockets.set(socket, { read: socket.bytesRead, written: socket.bytesWritten });
    socket.once('close', () => {
      const baseline = this.sockets.get(socket);
      if (!baseline) return;
      this.closedSocketBytes.read += Math.max(0, socket.bytesRead - baseline.read);
      this.closedSocketBytes.written += Math.max(0, socket.bytesWritten - baseline.written);
      this.sockets.delete(socket);
    });
  }

  recordRequest(statusCode: number, durationMs: number): void {
    this.requestCount += 1;
    if (statusCode >= 400) this.requestErrors += 1;
    if (Number.isFinite(durationMs)) this.requestDurations.push(durationMs);
    if (this.requestDurations.length > 10_000) this.requestDurations.splice(0, this.requestDurations.length - 10_000);
  }

  sample(now = Date.now()): RuntimeMetricSample {
    const elapsedSeconds = Math.max(0.001, (now - this.previousAt) / 1000);
    const cpu = process.cpuUsage(this.previousCpu);
    const cpuProcessPercent = (cpu.user + cpu.system) / 1_000_000 / elapsedSeconds * 100;
    const io = readProcessIo();
    const socketBytes = this.getSocketBytes();
    const memory = process.memoryUsage();
    const requestCount = this.requestCount;
    const result: RuntimeMetricSample = {
      timestamp: now,
      uptimeSeconds: round(process.uptime()),
      cpuProcessPercent: round(cpuProcessPercent),
      cpuHostCapacityPercent: round(cpuProcessPercent / Math.max(1, os.availableParallelism())),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      eventLoopDelayP99Ms: round(this.eventLoopHistogram.percentile(99) / 1_000_000),
      diskReadBytesPerSecond: round(Math.max(0, io.readBytes - this.previousIo.readBytes) / elapsedSeconds),
      diskWriteBytesPerSecond: round(Math.max(0, io.writeBytes - this.previousIo.writeBytes) / elapsedSeconds),
      networkReadBytesPerSecond: round(Math.max(0, socketBytes.read - this.previousSocketBytes.read) / elapsedSeconds),
      networkWriteBytesPerSecond: round(Math.max(0, socketBytes.written - this.previousSocketBytes.written) / elapsedSeconds),
      activeConnections: this.sockets.size,
      requestsPerSecond: round(requestCount / elapsedSeconds),
      requestErrorRatio: round(requestCount > 0 ? this.requestErrors / requestCount : 0, 4),
      requestLatencyP95Ms: round(percentile(this.requestDurations, 0.95)),
    };
    this.current = result;
    this.previousAt = now;
    this.previousCpu = process.cpuUsage();
    this.previousIo = io;
    this.previousSocketBytes = socketBytes;
    this.requestCount = 0;
    this.requestErrors = 0;
    this.requestDurations = [];
    this.eventLoopHistogram.reset();
    if (now - this.lastHistoryAt >= this.historyIntervalMs) {
      this.history.push(result);
      this.history = this.history.slice(-this.maxHistorySamples);
      this.lastHistoryAt = now;
      this.appendHistory(result);
    }
    return result;
  }

  async diagnostics(): Promise<RuntimeDiagnostics> {
    const current = this.current ?? this.sample();
    const storage = await collectStorageSnapshot(this.stateDirectory);
    const findings = evaluateRuntimeHealth(current, storage);
    return {
      status: findings.some((item) => item.severity === 'critical') ? 'critical' : findings.length > 0 ? 'warning' : 'ok',
      generatedAt: Date.now(), current, history: [...this.history], storage, findings,
      scopes: { cpu: 'termdock-process', memory: 'termdock-process', diskIo: 'termdock-process', networkIo: 'termdock-http-sockets', storage: 'termdock-state-directory' },
    };
  }

  private getSocketBytes(): SocketCounters {
    let read = this.closedSocketBytes.read;
    let written = this.closedSocketBytes.written;
    for (const [socket, baseline] of this.sockets) {
      read += Math.max(0, socket.bytesRead - baseline.read);
      written += Math.max(0, socket.bytesWritten - baseline.written);
    }
    return { read, written };
  }

  private loadHistory(): void {
    if (!this.historyPath) return;
    try {
      this.history = fs.readFileSync(this.historyPath, 'utf8').trim().split('\n').flatMap((line) => {
        try { const item = JSON.parse(line) as RuntimeMetricSample; return Number.isFinite(item.timestamp) ? [item] : []; }
        catch { return []; }
      }).slice(-this.maxHistorySamples);
      this.lastHistoryAt = this.history.at(-1)?.timestamp ?? 0;
    } catch { /* First run or a missing/corrupt history file. */ }
  }

  private appendHistory(sample: RuntimeMetricSample): void {
    if (!this.historyPath) return;
    void fs.promises.mkdir(path.dirname(this.historyPath), { recursive: true })
      .then(() => fs.promises.appendFile(this.historyPath!, `${JSON.stringify(sample)}\n`, { mode: 0o600 }))
      .then(async () => {
        const stat = await fs.promises.stat(this.historyPath!);
        if (stat.size <= 2 * 1024 * 1024) return;
        const retained = this.history.map((item) => JSON.stringify(item)).join('\n') + '\n';
        const temporary = `${this.historyPath}.${process.pid}.tmp`;
        await fs.promises.writeFile(temporary, retained, { mode: 0o600 });
        await fs.promises.rename(temporary, this.historyPath!);
      })
      .catch(() => undefined);
  }
}
