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
