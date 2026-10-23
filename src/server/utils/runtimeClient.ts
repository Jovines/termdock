import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface RuntimeClientManifest {
  schemaVersion?: unknown;
  serverBundleHash?: unknown;
  clientBundleHash?: unknown;
  clientEntrypoint?: unknown;
}

function readManifest(filePath: string): RuntimeClientManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RuntimeClientManifest;
  } catch {
    return null;
  }
}

function isCompleteSnapshot(
  clientDist: string,
  serverBundleHash: string,
  clientBundleHash: string,
): boolean {
  const marker = readManifest(path.join(clientDist, '..', '..', 'snapshot-manifest.json'));
  return marker?.schemaVersion === 1
    && marker.serverBundleHash === serverBundleHash
    && marker.clientBundleHash === clientBundleHash
    && marker.clientEntrypoint === 'dist/client/index.html'
    && fs.existsSync(path.join(clientDist, 'index.html'));
}

function hasExactClientContents(directory: string, expected: string): boolean {
  try {
    const hash = crypto.createHash('sha256');
    let entries = 0;
    const visit = (current: string, relative = '') => {
      if (!fs.lstatSync(current).isDirectory()) throw new Error('Linked snapshot');
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++entries > 10_000) throw new Error('Snapshot entry limit');
        const file = path.join(current, entry.name), name = path.join(relative, entry.name);
        if (entry.isDirectory()) visit(file, name);
        else if (entry.isFile()) hash.update(name.split(path.sep).join('/')).update('\0').update(fs.readFileSync(file)).update('\0');
        else throw new Error('Linked snapshot');
      }
    };
    visit(directory);
    return `sha256-${hash.digest('base64')}` === expected;
  } catch { return false; }
}

/**
 * Keep the browser bundle served by this process immutable for its lifetime.
 *
 * `npm install --global` replaces files underneath a still-running Termdock
 * process. Without a snapshot, Express immediately starts serving the new
 * index/assets while the in-memory server is still the old version. That can
 * pair a newer terminal protocol client with an older WebSocket server until
 * the user confirms the restart.
 */
export function pinBundledRuntimeClientDist(
  defaultClientDist: string,
  homeDir = os.homedir(),
): string {
  try {
    const packageRoot = path.resolve(defaultClientDist, '..', '..');
    const manifest = readManifest(path.join(packageRoot, 'runtime-manifest.json'));
    if (
      manifest?.schemaVersion !== 1
      || typeof manifest.serverBundleHash !== 'string'
      || typeof manifest.clientBundleHash !== 'string'
      || manifest.clientEntrypoint !== 'dist/client/index.html'
      || !fs.existsSync(path.join(defaultClientDist, 'index.html'))
    ) {
      return defaultClientDist;
    }

    const snapshotKey = crypto
      .createHash('sha256')
      .update(`${manifest.serverBundleHash}\0${manifest.clientBundleHash}`)
      .digest('hex')
      .slice(0, 24);
    const snapshotsRoot = path.join(homeDir, '.termdock', 'client-snapshots');
    const snapshotRoot = path.join(snapshotsRoot, snapshotKey);
    const snapshotClientDist = path.join(snapshotRoot, 'dist', 'client');
    if (isCompleteSnapshot(snapshotClientDist, manifest.serverBundleHash, manifest.clientBundleHash)) {
      try { fs.utimesSync(snapshotRoot, new Date(), new Date()); } catch { /* Read-only caches remain usable. */ }
      return snapshotClientDist;
    }

    // Server-only upgrades do not need another full copy of the same client.
    try {
      for (const entry of fs.readdirSync(snapshotsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
        const candidate = path.join(snapshotsRoot, entry.name, 'dist', 'client');
        const marker = readManifest(path.join(snapshotsRoot, entry.name, 'snapshot-manifest.json'));
        if (typeof marker?.serverBundleHash === 'string' && marker.clientBundleHash === manifest.clientBundleHash
          && isCompleteSnapshot(candidate, marker.serverBundleHash, manifest.clientBundleHash)
          && hasExactClientContents(candidate, manifest.clientBundleHash)) {
          try { fs.utimesSync(path.join(snapshotsRoot, entry.name), new Date(), new Date()); } catch { /* Read-only caches remain usable. */ }
          return candidate;
        }
      }
    } catch { /* First run or an unavailable cache; copy the installed bundle. */ }

    fs.mkdirSync(snapshotsRoot, { recursive: true, mode: 0o700 });
    const temporaryRoot = fs.mkdtempSync(path.join(snapshotsRoot, `.${snapshotKey}-`));
    const temporaryClientDist = path.join(temporaryRoot, 'dist', 'client');
    try {
      fs.cpSync(defaultClientDist, temporaryClientDist, {
        recursive: true,
        preserveTimestamps: true,
      });
      fs.writeFileSync(
        path.join(temporaryRoot, 'snapshot-manifest.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          serverBundleHash: manifest.serverBundleHash,
          clientBundleHash: manifest.clientBundleHash,
          clientEntrypoint: 'dist/client/index.html',
        })}\n`,
        { mode: 0o600 },
      );
      try {
        fs.renameSync(temporaryRoot, snapshotRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      if (fs.existsSync(temporaryRoot)) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }

    return isCompleteSnapshot(snapshotClientDist, manifest.serverBundleHash, manifest.clientBundleHash)
      ? snapshotClientDist
      : defaultClientDist;
  } catch {
    // A read-only home or interrupted snapshot must never block the server.
    return defaultClientDist;
  }
}

/** Old open pages still import their content-hashed lazy chunks after a restart.
 * Only expose public JS/CSS build assets from complete, locally pinned snapshots;
 * never serve an old entry page, service worker, or arbitrary filesystem path.
 */
export function indexRetainedClientModules(homeDir = os.homedir()): Map<string, string> {
  const modules = new Map<string, string>();
  const root = path.join(homeDir, '.termdock', 'client-snapshots');
  try {
    for (const snapshot of fs.readdirSync(root, { withFileTypes: true })) {
      if (!snapshot.isDirectory() || !/^[a-f0-9]{24}$/.test(snapshot.name)) continue;
      const snapshotRoot = path.join(root, snapshot.name);
      const manifest = readManifest(path.join(snapshotRoot, 'snapshot-manifest.json'));
      const clientDist = path.join(snapshotRoot, 'dist', 'client');
      if (typeof manifest?.serverBundleHash !== 'string'
        || typeof manifest.clientBundleHash !== 'string'
        || !isCompleteSnapshot(clientDist, manifest.serverBundleHash, manifest.clientBundleHash)) continue;
      try {
        const assets = path.join(clientDist, 'assets');
        for (const file of fs.readdirSync(assets, { withFileTypes: true })) {
          if (!file.isFile() || !/^[\w.-]+-[\w-]{8,}\.(?:js|css)$/.test(file.name)) continue;
          const url = `/assets/${file.name}`;
          if (!modules.has(url)) modules.set(url, path.join(assets, file.name));
        }
      } catch { /* An incomplete or removed snapshot must not prevent startup. */ }
    }
  } catch { /* No retained snapshots on first install. */ }
  return modules;
}

const touchedSnapshots = new Map<string, number>();
/** Refresh expired index entries without losing a module kept by another build. */
export function resolveRetainedClientModule(modules: Map<string, string>, url: string, homeDir = os.homedir()): string | undefined {
  let retainedPath = modules.get(url);
  if (retainedPath && !fs.existsSync(retainedPath)) {
    modules.clear();
    for (const [key, file] of indexRetainedClientModules(homeDir)) modules.set(key, file);
    retainedPath = modules.get(url);
  }
  if (retainedPath) touchRetainedClientModule(retainedPath);
  return retainedPath;
}

/** A page that still loads an older module renews that snapshot's grace period. */
export function touchRetainedClientModule(modulePath: string): void {
  const directory = path.resolve(modulePath, '..', '..', '..', '..');
  if (path.basename(path.dirname(directory)) !== 'client-snapshots' || !/^[a-f0-9]{24}$/.test(path.basename(directory))) return;
  const now = Date.now();
  if (now - (touchedSnapshots.get(directory) ?? 0) < 60_000) return;
  touchedSnapshots.set(directory, now);
  if (touchedSnapshots.size > 1024) touchedSnapshots.delete(touchedSnapshots.keys().next().value!);
  try { fs.utimesSync(directory, new Date(now), new Date(now)); } catch { /* Already expired or read-only. */ }
}
