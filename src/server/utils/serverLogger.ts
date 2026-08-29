import fs from 'fs';
import os from 'os';
import path from 'path';

const TERMDOCK_DIR = path.join(os.homedir(), '.termdock');
const MIB = 1024 * 1024;
const DEFAULT_MAX_BYTES = 4 * MIB;
const SERVER_LOG_MAX_BYTES = 2 * MIB;
const TOTAL_LOG_MAX_BYTES = 24 * MIB;
const LOG_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
const MANAGED_LOG_NAMES = [
  'access.log',
  'client.log',
  'diff-trace.log',
  'errors.log',
  'fs-io.log',
  'server.log',
] as const;

const writeChains = new Map<string, Promise<void>>();
const rotateInProgress = new Set<string>();
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let maintenanceScheduled = false;

function retainFileTail(filePath: string, maxBytes: number): void {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size <= maxBytes) return;

  const readBytes = Math.min(stat.size, maxBytes + 8 * 1024);
  const fd = fs.openSync(filePath, 'r');
  let tail: Buffer;
  try {
    tail = Buffer.allocUnsafe(readBytes);
    fs.readSync(fd, tail, 0, readBytes, stat.size - readBytes);
  } finally {
    fs.closeSync(fd);
  }

  if (tail.length > maxBytes) {
    const overflow = tail.length - maxBytes;
    const startsAtLineBoundary = tail[overflow - 1] === 0x0a;
    const newline = startsAtLineBoundary ? -1 : tail.indexOf(0x0a, overflow);
    tail = tail.subarray(startsAtLineBoundary ? overflow : newline >= 0 ? newline + 1 : overflow);
  }

  // Keep the inode: server.log may already be held open as stdout/stderr by
  // the daemon, so replacing the path would make later output invisible.
  fs.truncateSync(filePath, 0);
  fs.appendFileSync(filePath, tail);
}

interface ManagedLogFile {
  path: string;
  size: number;
  mtimeMs: number;
  rotated: boolean;
}

function listManagedLogs(directory: string): ManagedLogFile[] {
  const files: ManagedLogFile[] = [];
  for (const name of MANAGED_LOG_NAMES) {
    for (const suffix of ['', '.1']) {
      const filePath = path.join(directory, `${name}${suffix}`);
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, rotated: suffix === '.1' });
    }
  }
  return files;
}

export function enforceTermdockLogBudget(options: {
  directory?: string;
  structuredLogMaxBytes?: number;
  serverLogMaxBytes?: number;
  totalLogMaxBytes?: number;
} = {}): void {
  const directory = options.directory ?? TERMDOCK_DIR;
  const structuredLogMaxBytes = options.structuredLogMaxBytes ?? DEFAULT_MAX_BYTES;
  const serverLogMaxBytes = options.serverLogMaxBytes ?? SERVER_LOG_MAX_BYTES;
  const totalLogMaxBytes = options.totalLogMaxBytes ?? TOTAL_LOG_MAX_BYTES;

  try {
    for (const name of MANAGED_LOG_NAMES) {
      retainFileTail(
        path.join(directory, name),
        name === 'server.log' ? serverLogMaxBytes : structuredLogMaxBytes,
      );
    }

    const files = listManagedLogs(directory);
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const rotationsByAge = files
      .filter((file) => file.rotated)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of rotationsByAge) {
      if (totalBytes <= totalLogMaxBytes) break;
      fs.rmSync(file.path, { force: true });
      totalBytes -= file.size;
    }
  } catch {
    // Diagnostics must never make the application unavailable.
  }
}

function scheduleLogBudgetMaintenance(): void {
  if (maintenanceScheduled) return;
  maintenanceScheduled = true;
  const timer = setTimeout(() => {
    maintenanceScheduled = false;
    enforceTermdockLogBudget();
  }, 100);
  timer.unref?.();
}

export function startTermdockLogMaintenance(): () => void {
  enforceTermdockLogBudget();
  if (!maintenanceTimer) {
    maintenanceTimer = setInterval(enforceTermdockLogBudget, LOG_MAINTENANCE_INTERVAL_MS);
    maintenanceTimer.unref?.();
  }
  return () => {
    if (!maintenanceTimer) return;
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  };
}

async function rotateIfNeeded(filePath: string, maxBytes: number): Promise<void> {
  if (rotateInProgress.has(filePath)) return;
  rotateInProgress.add(filePath);
  try {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || stat.size < maxBytes) return;
    const rotatedPath = `${filePath}.1`;
    await fs.promises.rm(rotatedPath, { force: true }).catch(() => undefined);
    await fs.promises.rename(filePath, rotatedPath).catch(() => undefined);
    scheduleLogBudgetMaintenance();
  } finally {
    rotateInProgress.delete(filePath);
  }
}

function enqueueWrite(filePath: string, line: string, maxBytes: number): void {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.promises.mkdir(TERMDOCK_DIR, { recursive: true });
      await rotateIfNeeded(filePath, maxBytes);
      await fs.promises.appendFile(filePath, line, 'utf8');
    })
    .catch(() => undefined);
  writeChains.set(filePath, next);
}

export function getTermdockLogPath(name: string): string {
  return path.join(TERMDOCK_DIR, name);
}

export function writeJsonLog(name: string, entry: Record<string, unknown>, maxBytes = DEFAULT_MAX_BYTES): void {
  const filePath = getTermdockLogPath(name);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    ...entry,
  }) + '\n';
  enqueueWrite(filePath, line, maxBytes);
}

export function writeTextLog(name: string, line: string, maxBytes = DEFAULT_MAX_BYTES): void {
  const filePath = getTermdockLogPath(name);
  enqueueWrite(filePath, `${line.replace(/\n$/, '')}\n`, maxBytes);
}

export function writeErrorLog(entry: Record<string, unknown>): void {
  writeJsonLog('errors.log', entry);
}

export function writeDiffTraceLog(entry: Record<string, unknown>): void {
  writeJsonLog('diff-trace.log', entry);
}
