import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pinBundledRuntimeClientDist, resolveRuntimeClientDist } from './runtimeClient.js';

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-runtime-client-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveRuntimeClientDist', () => {
  it('uses a dynamically selected client only when the server bundle matches', () => {
    const homeDir = tempDirectory();
    const packageRoot = path.join(tempDirectory(), 'package');
    const defaultClient = path.join(packageRoot, 'dist', 'client');
    fs.mkdirSync(defaultClient, { recursive: true });
    fs.writeFileSync(path.join(defaultClient, 'index.html'), 'bundled');
    writeJson(path.join(packageRoot, 'runtime-manifest.json'), {
      schemaVersion: 1,
      serverBundleHash: 'sha256-server-a',
      clientEntrypoint: 'dist/client/index.html',
    });

    const runtimeRoot = path.join(homeDir, '.termdock', 'desktop-runtime');
    const selectedRoot = path.join(runtimeRoot, 'versions', '1.4.47');
    const selectedPackage = path.join(selectedRoot, 'package');
    const selectedClient = path.join(selectedPackage, 'dist', 'client');
    fs.mkdirSync(selectedClient, { recursive: true });
    fs.writeFileSync(path.join(selectedClient, 'index.html'), 'updated');
    writeJson(path.join(selectedPackage, 'runtime-manifest.json'), {
      schemaVersion: 1,
      serverBundleHash: 'sha256-server-a',
      clientEntrypoint: 'dist/client/index.html',
    });
    fs.symlinkSync(path.join('versions', '1.4.47'), path.join(runtimeRoot, 'client-current'), 'dir');

    expect(resolveRuntimeClientDist(defaultClient, homeDir)).toBe(selectedClient);
    writeJson(path.join(selectedPackage, 'runtime-manifest.json'), {
      schemaVersion: 1,
      serverBundleHash: 'sha256-server-b',
      clientEntrypoint: 'dist/client/index.html',
    });
    expect(resolveRuntimeClientDist(defaultClient, homeDir)).toBe(defaultClient);
  });
});

describe('pinBundledRuntimeClientDist', () => {
  it('keeps serving the client paired with the running server after npm replaces package files', () => {
    const homeDir = tempDirectory();
    const packageRoot = path.join(tempDirectory(), 'package');
    const defaultClient = path.join(packageRoot, 'dist', 'client');
    fs.mkdirSync(path.join(defaultClient, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(defaultClient, 'index.html'), '<script src="/assets/app-old.js"></script>');
    fs.writeFileSync(path.join(defaultClient, 'assets', 'app-old.js'), 'old client');
    writeJson(path.join(packageRoot, 'runtime-manifest.json'), {
      schemaVersion: 1,
      serverBundleHash: 'sha256-running-server',
      clientEntrypoint: 'dist/client/index.html',
    });

    const pinnedClient = pinBundledRuntimeClientDist(defaultClient, homeDir);
    expect(pinnedClient).not.toBe(defaultClient);

    fs.writeFileSync(path.join(defaultClient, 'index.html'), '<script src="/assets/app-new.js"></script>');
    fs.rmSync(path.join(defaultClient, 'assets', 'app-old.js'));
    fs.writeFileSync(path.join(defaultClient, 'assets', 'app-new.js'), 'new client');

    expect(fs.readFileSync(path.join(pinnedClient, 'index.html'), 'utf8')).toContain('app-old.js');
    expect(fs.readFileSync(path.join(pinnedClient, 'assets', 'app-old.js'), 'utf8')).toBe('old client');
  });

  it('reuses the completed snapshot for the same server bundle', () => {
    const homeDir = tempDirectory();
    const packageRoot = path.join(tempDirectory(), 'package');
    const defaultClient = path.join(packageRoot, 'dist', 'client');
    fs.mkdirSync(defaultClient, { recursive: true });
    fs.writeFileSync(path.join(defaultClient, 'index.html'), 'bundled');
    writeJson(path.join(packageRoot, 'runtime-manifest.json'), {
      schemaVersion: 1,
      serverBundleHash: 'sha256-stable-server',
      clientEntrypoint: 'dist/client/index.html',
    });

    const first = pinBundledRuntimeClientDist(defaultClient, homeDir);
    const second = pinBundledRuntimeClientDist(defaultClient, homeDir);

    expect(second).toBe(first);
  });
});
