import fs from 'node:fs/promises';
import path from 'node:path';
import { leaseClientSnapshot, pruneClientSnapshots, type CacheCleanupEntry } from './clientSnapshotMaintenance.js';
import { pruneWorkspaceCaches } from './workspaceCacheMaintenance.js';

export interface StorageMaintenanceOptions {
  stateDirectory: string; clientDirectory: string; dryRun?: boolean;
}

/** The same conservative migration handles existing data and future upgrades. */
export async function maintainGeneratedStorage(options: StorageMaintenanceOptions) {
  const startedAt = Date.now();
  const entries: CacheCleanupEntry[] = [
    ...await pruneClientSnapshots(options),
    ...await pruneWorkspaceCaches(options),
  ];
  const report = { kind: 'termdock-generated-storage-maintenance', version: 1, startedAt, finishedAt: Date.now(), dryRun: options.dryRun === true,
    reclaimedBytes: entries.filter(item => item.action === 'removed').reduce((sum, item) => sum + item.bytes, 0), entries };
  if (!options.dryRun) {
    const file = path.join(options.stateDirectory, 'storage-maintenance.json');
    try {
      // Preserve a pre-existing foreign file instead of claiming its path.
      try { if (JSON.parse(await fs.readFile(file, 'utf8')).kind !== report.kind) return report; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return report; }
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, file);
    } catch { /* Cleanup must not turn diagnostic storage failure into downtime. */ }
  }
  return report;
}

export function startGeneratedStorageMaintenance(options: StorageMaintenanceOptions): () => void {
  if (process.env.NODE_ENV === 'test') return () => {};
  const release = leaseClientSnapshot(options.clientDirectory, options.stateDirectory);
  let stopped = false, running = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const report = await maintainGeneratedStorage(options);
      console.log(`[storage-maintenance] reclaimed ${report.reclaimedBytes} bytes; ${report.entries.filter(item => item.action === 'retained').length} paths retained`);
    } catch (error) { console.warn('[storage-maintenance] retained unverified data:', error instanceof Error ? error.message : 'check failed'); }
    finally { running = false; }
  };
  // Let the listener become healthy before migrating large legacy caches.
  const startup = setTimeout(() => { void run(); }, 5_000); startup.unref();
  const timer = setInterval(() => { void run(); }, 6 * 60 * 60_000); timer.unref();
  return () => { stopped = true; clearTimeout(startup); clearInterval(timer); release(); };
}
