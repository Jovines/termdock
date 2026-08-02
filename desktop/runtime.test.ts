import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  parseRuntimeManifest,
  resolvePackagedRuntime,
  rollbackDownloadedRuntime,
  runtimeCompatibilityError,
  updateRuntimeFromRegistry,
  validateTarEntries,
  verifyPackageIntegrity,
  verifyRegistrySignature,
  type RuntimeManifest,
} from './runtime.js';

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-runtime-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function manifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    schemaVersion: 1,
    packageName: 'termdock',
    version: '1.4.46',
    runtimeProtocolVersion: 1,
    minimumDesktopVersion: '1.4.46',
    nodeMajor: 22,
    dependencyHash: `sha256-${Buffer.alloc(32, 7).toString('base64')}`,
    serverBundleHash: `sha256-${Buffer.alloc(32, 9).toString('base64')}`,
    entrypoint: 'dist/server/cli.js',
    clientEntrypoint: 'dist/client/index.html',
    ...overrides,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('desktop runtime compatibility', () => {
  it('orders release and prerelease versions', () => {
    expect(compareVersions('1.4.46', '1.4.45')).toBeGreaterThan(0);
    expect(compareVersions('1.4.46-beta.2', '1.4.46-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.4.46', '1.4.46-beta.2')).toBeGreaterThan(0);
  });

  it('requires a desktop rebuild for runtime ABI changes', () => {
    const bundled = manifest();
    expect(runtimeCompatibilityError(manifest({ version: '1.4.47' }), bundled, '1.4.46')).toBeNull();
    expect(runtimeCompatibilityError(
      manifest({ version: '1.4.47', nodeMajor: 24 }),
      bundled,
      '1.4.46',
    )).toMatch(/Node 24/);
    expect(runtimeCompatibilityError(
      manifest({ version: '1.4.47', dependencyHash: `sha256-${Buffer.alloc(32, 8).toString('base64')}` }),
      bundled,
      '1.4.46',
    )).toMatch(/dependencies/);
  });

  it('rejects malformed manifests and unsafe tar entries', () => {
    expect(() => parseRuntimeManifest({ ...manifest(), entrypoint: '../../cli.js' })).toThrow();
    expect(() => validateTarEntries('package/dist/server/cli.js\npackage/package.json\n')).not.toThrow();
    expect(() => validateTarEntries('package/../../tmp/owned\n')).toThrow(/Unsafe/);
  });
});

describe('npm package verification', () => {
  it('checks SHA-512 integrity', () => {
    const data = Buffer.from('signed runtime bytes');
    const integrity = `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`;
    expect(verifyPackageIntegrity(data, integrity)).toBe(true);
    expect(verifyPackageIntegrity(Buffer.from('tampered'), integrity)).toBe(false);
  });

  it('checks npm registry ECDSA signatures', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const integrity = `sha512-${Buffer.alloc(64, 3).toString('base64')}`;
    const message = Buffer.from(`termdock@1.4.46:${integrity}`);
    const signature = crypto.sign('sha256', message, privateKey).toString('base64');
    const key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(verifyRegistrySignature({
      packageName: 'termdock',
      version: '1.4.46',
      integrity,
      signatures: [{ keyid: 'test-key', sig: signature }],
      keys: [{ keyid: 'test-key', key, keytype: 'ecdsa-sha2-nistp256', expires: null }],
    })).toBe(true);
    expect(verifyRegistrySignature({
      packageName: 'termdock',
      version: '1.4.47',
      integrity,
      signatures: [{ keyid: 'test-key', sig: signature }],
      keys: [{ keyid: 'test-key', key, keytype: 'ecdsa-sha2-nistp256', expires: null }],
    })).toBe(false);
  });
});

describe('downloaded runtime selection', () => {
  it('selects a compatible runtime and rolls back atomically', () => {
    const homeDir = tempDirectory();
    const resourcesPath = path.join(tempDirectory(), 'Resources');
    const bundled = manifest();
    writeJson(path.join(resourcesPath, 'server', 'runtime-manifest.json'), bundled);
    fs.mkdirSync(path.join(resourcesPath, 'server', 'node_modules'), { recursive: true });

    const root = path.join(homeDir, '.termdock', 'desktop-runtime');
    const versionRoot = path.join(root, 'versions', '1.4.47');
    const packageRoot = path.join(versionRoot, 'package');
    writeJson(path.join(packageRoot, 'runtime-manifest.json'), manifest({ version: '1.4.47' }));
    writeJson(path.join(packageRoot, 'package.json'), { version: '1.4.47', type: 'module' });
    fs.mkdirSync(path.join(packageRoot, 'dist', 'server'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'dist', 'client'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'dist', 'server', 'cli.js'), '');
    fs.writeFileSync(path.join(packageRoot, 'dist', 'client', 'index.html'), '');
    fs.symlinkSync(path.join('versions', '1.4.47'), path.join(root, 'current'), 'dir');
    writeJson(path.join(root, 'state.json'), {
      schemaVersion: 1,
      currentVersion: '1.4.47',
      previousVersion: null,
      activatedAt: new Date().toISOString(),
    });

    const selected = resolvePackagedRuntime({ appVersion: '1.4.46', resourcesPath, homeDir });
    expect(selected.version).toBe('1.4.47');
    expect(selected.source).toBe('downloaded');
    expect(fs.realpathSync(path.join(packageRoot, 'node_modules')))
      .toBe(fs.realpathSync(path.join(resourcesPath, 'server', 'node_modules')));

    expect(rollbackDownloadedRuntime({ appVersion: '1.4.46', resourcesPath, homeDir }, '1.4.47'))
      .toBe(true);
    expect(resolvePackagedRuntime({ appVersion: '1.4.46', resourcesPath, homeDir }).source)
      .toBe('bundled');
  });

  it.runIf(process.env.TERMDOCK_RUNTIME_INTEGRATION === '1')(
    'downloads, verifies, extracts, and activates the published npm runtime',
    async () => {
      const homeDir = tempDirectory();
      const resourcesPath = path.join(tempDirectory(), 'Resources');
      const published = parseRuntimeManifest(JSON.parse(
        fs.readFileSync(path.resolve('runtime-manifest.json'), 'utf8'),
      ));
      writeJson(
        path.join(resourcesPath, 'server', 'runtime-manifest.json'),
        { ...published, version: '1.4.45' },
      );
      fs.mkdirSync(path.join(resourcesPath, 'server', 'node_modules'), { recursive: true });

      const result = await updateRuntimeFromRegistry({
        appVersion: published.minimumDesktopVersion,
        resourcesPath,
        homeDir,
      });
      expect(result).toMatchObject({ status: 'updated', currentVersion: published.version });
      const selected = resolvePackagedRuntime({
        appVersion: published.minimumDesktopVersion,
        resourcesPath,
        homeDir,
      });
      expect(selected).toMatchObject({ source: 'downloaded', version: published.version });
      expect(fs.realpathSync(path.join(homeDir, '.termdock', 'desktop-runtime', 'client-current')))
        .toContain(path.join('versions', published.version));
    },
    120_000,
  );
});
