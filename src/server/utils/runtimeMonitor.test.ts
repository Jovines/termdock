import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateRuntimeHealth,
  RuntimeMonitor,
  type RuntimeMetricSample,
  type RuntimeStorageSnapshot,
} from './runtimeMonitor.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function sample(overrides: Partial<RuntimeMetricSample> = {}): RuntimeMetricSample {
  return {
    timestamp: Date.now(), uptimeSeconds: 1, cpuProcessPercent: 1, cpuHostCapacityPercent: 1,
    rssBytes: 64 * 1024 ** 2, heapUsedBytes: 16 * 1024 ** 2, heapTotalBytes: 32 * 1024 ** 2,
    externalBytes: 0, eventLoopDelayP99Ms: 1, diskReadBytesPerSecond: 0, diskWriteBytesPerSecond: 0,
    networkReadBytesPerSecond: 0, networkWriteBytesPerSecond: 0, activeConnections: 1,
    requestsPerSecond: 1, requestErrorRatio: 0, requestLatencyP95Ms: 10, ...overrides,
  };
}

function storage(overrides: Partial<RuntimeStorageSnapshot> = {}): RuntimeStorageSnapshot {
  return {
    root: '/tmp', totalBytes: 1, fileCount: 1, truncated: false,
    freeBytes: 100 * 1024 ** 3, totalFilesystemBytes: 200 * 1024 ** 3, topLevel: [], ...overrides,
  };
}

describe('RuntimeMonitor', () => {
  it('aggregates requests and reports bounded state-directory storage', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-runtime-monitor-'));
    directories.push(directory);
    fs.mkdirSync(path.join(directory, 'session-search'));
    fs.writeFileSync(path.join(directory, 'session-search', 'one.log'), '12345');
    const monitor = new RuntimeMonitor({ stateDirectory: directory, historyIntervalMs: 1, maxHistorySamples: 2 });
    monitor.recordRequest(200, 10);
    monitor.recordRequest(500, 100);
    monitor.sample(Date.now() + 1_000);

    const diagnostics = await monitor.diagnostics();

    expect(diagnostics.current.requestsPerSecond).toBeGreaterThan(0);
    expect(diagnostics.current.requestErrorRatio).toBe(0.5);
    expect(diagnostics.storage.totalBytes).toBe(5);
    expect(diagnostics.storage.topLevel[0]).toEqual({ name: 'session-search', bytes: 5 });
    expect(diagnostics.scopes.networkIo).toBe('termdock-http-sockets');
  });

  it('classifies resource pressure without hiding the measured value', () => {
    const findings = evaluateRuntimeHealth(
      sample({ rssBytes: 600 * 1024 ** 2, eventLoopDelayP99Ms: 600 }),
      storage(),
    );

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', code: 'PROCESS_RSS_HIGH', value: 600 * 1024 ** 2 }),
      expect.objectContaining({ severity: 'critical', code: 'EVENT_LOOP_STALLED', value: 600 }),
    ]));
  });
});
