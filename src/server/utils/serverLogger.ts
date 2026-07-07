import fs from 'fs';
import os from 'os';
import path from 'path';

const TERMDOCK_DIR = path.join(os.homedir(), '.termdock');
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const writeChains = new Map<string, Promise<void>>();
const rotateInProgress = new Set<string>();

async function rotateIfNeeded(filePath: string, maxBytes: number): Promise<void> {
  if (rotateInProgress.has(filePath)) return;
  rotateInProgress.add(filePath);
  try {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || stat.size < maxBytes) return;
    const rotatedPath = `${filePath}.1`;
    await fs.promises.rm(rotatedPath, { force: true }).catch(() => undefined);
    await fs.promises.rename(filePath, rotatedPath).catch(() => undefined);
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
