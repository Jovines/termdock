import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface RuntimeClientManifest {
  schemaVersion?: unknown;
  serverBundleHash?: unknown;
  clientEntrypoint?: unknown;
}

function readManifest(filePath: string): RuntimeClientManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RuntimeClientManifest;
  } catch {
    return null;
  }
}

function isCompleteSnapshot(clientDist: string, serverBundleHash: string): boolean {
  const marker = readManifest(path.join(clientDist, '..', '..', 'snapshot-manifest.json'));
  return marker?.schemaVersion === 1
    && marker.serverBundleHash === serverBundleHash
    && marker.clientEntrypoint === 'dist/client/index.html'
    && fs.existsSync(path.join(clientDist, 'index.html'));
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
      || manifest.clientEntrypoint !== 'dist/client/index.html'
      || !fs.existsSync(path.join(defaultClientDist, 'index.html'))
    ) {
      return defaultClientDist;
    }

    const snapshotKey = crypto
      .createHash('sha256')
      .update(manifest.serverBundleHash)
      .digest('hex')
      .slice(0, 24);
    const snapshotsRoot = path.join(homeDir, '.termdock', 'client-snapshots');
    const snapshotRoot = path.join(snapshotsRoot, snapshotKey);
    const snapshotClientDist = path.join(snapshotRoot, 'dist', 'client');
    if (isCompleteSnapshot(snapshotClientDist, manifest.serverBundleHash)) {
      return snapshotClientDist;
    }

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

    return isCompleteSnapshot(snapshotClientDist, manifest.serverBundleHash)
      ? snapshotClientDist
      : defaultClientDist;
  } catch {
    // A read-only home or interrupted snapshot must never block the server.
    return defaultClientDist;
  }
}

export function resolveRuntimeClientDist(
  defaultClientDist: string,
  homeDir = os.homedir(),
): string {
  try {
    const defaultPackageRoot = path.resolve(defaultClientDist, '..', '..');
    const runningManifest = readManifest(path.join(defaultPackageRoot, 'runtime-manifest.json'));
    if (
      runningManifest?.schemaVersion !== 1
      || typeof runningManifest.serverBundleHash !== 'string'
    ) {
      return defaultClientDist;
    }

    const runtimeRoot = path.join(homeDir, '.termdock', 'desktop-runtime');
    const versionsRoot = fs.realpathSync(path.join(runtimeRoot, 'versions'));
    const selectedVersionRoot = fs.realpathSync(path.join(runtimeRoot, 'client-current'));
    const relative = path.relative(versionsRoot, selectedVersionRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return defaultClientDist;

    const selectedPackageRoot = path.join(selectedVersionRoot, 'package');
    const selectedManifest = readManifest(path.join(selectedPackageRoot, 'runtime-manifest.json'));
    if (
      selectedManifest?.schemaVersion !== 1
      || selectedManifest.serverBundleHash !== runningManifest.serverBundleHash
      || selectedManifest.clientEntrypoint !== 'dist/client/index.html'
    ) {
      return defaultClientDist;
    }
    const selectedClientDist = path.join(selectedPackageRoot, 'dist', 'client');
    if (!fs.existsSync(path.join(selectedClientDist, 'index.html'))) return defaultClientDist;
    return selectedClientDist;
  } catch {
    return defaultClientDist;
  }
}
