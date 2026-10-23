import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const DAY = 24 * 60 * 60_000;
const KEY = /^[a-f0-9]{24}$/;
export interface CacheCleanupEntry { path: string; action: 'removed' | 'would-remove' | 'retained'; reason: string; bytes: number; entriesRemoved?: number; entriesRetained?: number }
interface Snapshot {
  key: string; directory: string; client: string; hash: string; touchedAt: number;
}

async function realDirectory(directory: string): Promise<boolean> {
  try { return (await fs.lstat(directory)).isDirectory() && await fs.realpath(directory) === path.resolve(directory); }
  catch { return false; }
}

async function snapshot(directory: string): Promise<Snapshot | null> {
  const key = path.basename(directory);
  if (!KEY.test(key) || !await realDirectory(directory)) return null;
  try {
    const names = await fs.readdir(directory);
    if (names.length !== 2 || !names.includes('dist') || !names.includes('snapshot-manifest.json')) return null;
    const manifestPath = path.join(directory, 'snapshot-manifest.json');
    if (!(await fs.lstat(manifestPath)).isFile()) return null;
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (Object.keys(manifest).sort().join() !== ['schemaVersion', 'serverBundleHash', 'clientBundleHash', 'clientEntrypoint'].sort().join()
      || manifest.schemaVersion !== 1 || manifest.clientEntrypoint !== 'dist/client/index.html'
      || typeof manifest.serverBundleHash !== 'string' || typeof manifest.clientBundleHash !== 'string'
      || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(manifest.clientBundleHash)
      || crypto.createHash('sha256').update(`${manifest.serverBundleHash}\0${manifest.clientBundleHash}`).digest('hex').slice(0, 24) !== key) return null;
    const dist = path.join(directory, 'dist'), client = path.join(dist, 'client');
    if (!await realDirectory(dist) || !await realDirectory(client) || (await fs.readdir(dist)).join() !== 'client') return null;
    if (!(await fs.lstat(path.join(client, 'index.html'))).isFile()) return null;
    return { key, directory, client, hash: manifest.clientBundleHash, touchedAt: (await fs.stat(directory)).mtimeMs };
  } catch { return null; }
}

/** Same byte/path hash as generate-runtime-manifest.mjs; links are never eligible. */
export async function hashGeneratedClient(directory: string): Promise<{ hash: string; bytes: number; unchanged: () => Promise<boolean> }> {
  const digest = crypto.createHash('sha256');
  const observed: Array<{ file: string; identity: string }> = [];
  let bytes = 0, visited = 0;
  const identity = (stat: syncFs.Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const visit = async (current: string, relative = ''): Promise<void> => {
    const stat = await fs.lstat(current);
    observed.push({ file: current, identity: identity(stat) });
    if (!stat.isDirectory()) throw new Error('Snapshot contains a link or special entry');
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 10_000) throw new Error('Snapshot entry limit reached');
      const file = path.join(current, entry.name), name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file, name);
      else if (entry.isFile()) {
        const before = await fs.lstat(file);
        observed.push({ file, identity: identity(before) });
        bytes += before.size;
        digest.update(name.split(path.sep).join('/')); digest.update('\0');
        for await (const chunk of syncFs.createReadStream(file)) digest.update(chunk);
        digest.update('\0');
      } else throw new Error('Snapshot contains a link or special entry');
    }
  };
  await visit(directory);
  return { hash: `sha256-${digest.digest('base64')}`, bytes, unchanged: async () => {
    for (const item of observed) {
      try { if (identity(await fs.lstat(item.file)) !== item.identity) return false; } catch { return false; }
    }
    return true;
  } };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function leasedKeys(stateDirectory: string, reapDead: boolean): Promise<Set<string>> {
  const result = new Set<string>(), directory = path.join(stateDirectory, 'client-snapshot-leases');
  try {
    try { await fs.lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
    if (!await realDirectory(directory)) throw new Error('Snapshot lease directory is not verified');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d+-[a-f0-9]{16}\.json$/.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      try {
        const lease = JSON.parse(await fs.readFile(file, 'utf8'));
        if (lease.kind !== 'termdock-client-snapshot-lease' || lease.version !== 1 || !KEY.test(lease.snapshotKey)
          || !Number.isSafeInteger(lease.pid) || lease.pid < 1 || !entry.name.startsWith(`${lease.pid}-`)) throw new Error('Unverified lease');
        if (alive(lease.pid)) result.add(lease.snapshotKey);
        else if (reapDead && Object.keys(lease).length === 4) await fs.unlink(file);
      } catch { throw new Error('Client snapshot leases could not be verified'); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return result;
}

/** Protect every live server's pinned client, including other local ports. */
export function leaseClientSnapshot(clientDirectory: string, stateDirectory: string): () => void {
  const root = path.join(stateDirectory, 'client-snapshots'), directory = path.resolve(clientDirectory, '..', '..');
  if (path.dirname(directory) !== path.resolve(root) || !KEY.test(path.basename(directory))) return () => {};
  const leases = path.join(stateDirectory, 'client-snapshot-leases');
  try {
    syncFs.mkdirSync(leases, { recursive: true, mode: 0o700 });
    if (syncFs.realpathSync(leases) !== path.resolve(leases)) return () => {};
    const file = path.join(leases, `${process.pid}-${crypto.randomBytes(8).toString('hex')}.json`);
    syncFs.writeFileSync(file, JSON.stringify({ kind: 'termdock-client-snapshot-lease', version: 1, pid: process.pid, snapshotKey: path.basename(directory) }), { mode: 0o600, flag: 'wx' });
    const remove = () => { try { syncFs.unlinkSync(file); } catch { /* already removed */ } };
    process.once('exit', remove);
    return () => { process.off('exit', remove); remove(); };
  } catch { return () => {}; }
}

export async function pruneClientSnapshots(options: {
  stateDirectory: string; clientDirectory: string; dryRun?: boolean; now?: number; graceMs?: number; keepNewest?: number;
}): Promise<CacheCleanupEntry[]> {
  const root = path.join(options.stateDirectory, 'client-snapshots');
  if (!await realDirectory(root)) return [];
  const snapshots: Snapshot[] = [], result: CacheCleanupEntry[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !KEY.test(entry.name)) continue;
    const directory = path.join(root, entry.name), candidate = await snapshot(directory);
    if (candidate) snapshots.push(candidate);
    else result.push({ path: directory, action: 'retained', reason: 'unrecognized-or-modified-snapshot', bytes: 0 });
  }
  snapshots.sort((a, b) => b.touchedAt - a.touchedAt);
  const current = path.resolve(options.clientDirectory, '..', '..');
  const newest = new Set(snapshots.slice(0, options.keepNewest ?? 3).map(item => item.key));
  for (const item of snapshots) {
    if (item.directory === current || newest.has(item.key) || (options.now ?? Date.now()) - item.touchedAt < (options.graceMs ?? 7 * DAY)) continue;
    try {
      // Validate the full original build before deleting any legacy directory.
      const original = await hashGeneratedClient(item.client);
      const fresh = await snapshot(item.directory);
      const protectedKeys = await leasedKeys(options.stateDirectory, !options.dryRun);
      if (!fresh || fresh.touchedAt !== item.touchedAt || fresh.hash !== item.hash || original.hash !== item.hash
        || !await original.unchanged() || protectedKeys.has(item.key)) {
        result.push({ path: item.directory, action: 'retained', reason: 'modified-in-use-or-unverified-snapshot', bytes: 0 }); continue;
      }
      if ((await fs.stat(item.directory)).mtimeMs !== item.touchedAt) continue;
      if (!options.dryRun) await fs.rm(item.directory, { recursive: true });
      result.push({ path: item.directory, action: options.dryRun ? 'would-remove' : 'removed', reason: 'verified-expired-generated-client', bytes: original.bytes });
    } catch { result.push({ path: item.directory, action: 'retained', reason: 'snapshot-validation-failed', bytes: 0 }); }
  }
  return result;
}
