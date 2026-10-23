// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { hashGeneratedClient, leaseClientSnapshot, pruneClientSnapshots } from './clientSnapshotMaintenance.js';
import { indexRetainedClientModules, pinBundledRuntimeClientDist, resolveRetainedClientModule, touchRetainedClientModule } from './runtimeClient.js';
import { startGeneratedStorageMaintenance } from './storageMaintenance.js';

let home: string, sequence = 0;
const DAY = 24 * 60 * 60_000;
const releases: Array<() => void> = [];
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'td-cache-retention-')); });
afterEach(async () => { for (const release of releases.splice(0)) release(); await fs.rm(home, { recursive: true, force: true }); });
const state = () => path.join(home, '.termdock');
async function fixture(ageDays: number) {
  const id = ++sequence, packageRoot = path.join(home, `package-${id}`), client = path.join(packageRoot, 'dist', 'client');
  await fs.mkdir(path.join(client, 'assets'), { recursive: true });
  const asset = `chunk-${String(id).padStart(8, '0')}.js`;
  await fs.writeFile(path.join(client, 'index.html'), `<script type="module" src="/assets/${asset}"></script>`);
  await fs.writeFile(path.join(client, 'assets', asset), `export default ${id};`);
  await fs.writeFile(path.join(client, 'assets', 'shared-12345678.js'), 'export default "shared";');
  const clientBundleHash = (await hashGeneratedClient(client)).hash;
  await fs.writeFile(path.join(packageRoot, 'runtime-manifest.json'), JSON.stringify({ schemaVersion: 1,
    serverBundleHash: `sha256-server-${id}`, clientBundleHash, clientEntrypoint: 'dist/client/index.html' }));
  const pinned = pinBundledRuntimeClientDist(client, home), root = path.resolve(pinned, '..', '..');
  const timestamp = new Date(Date.now() - ageDays * DAY); await fs.utimes(root, timestamp, timestamp);
  return { client, pinned, root, asset, packageRoot };
}

it('migrates old pristine builds while keeping current, recent and the newest three versions', async () => {
  const expired = await fixture(50), recent = await fixture(2), current = await fixture(40);
  const newest = [await fixture(20), await fixture(21)];
  const results = await pruneClientSnapshots({ stateDirectory: state(), clientDirectory: current.pinned });
  expect(results).toContainEqual(expect.objectContaining({ path: expired.root, action: 'removed', bytes: expect.any(Number) }));
  await expect(fs.stat(expired.root)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const item of [recent, current, ...newest]) expect((await fs.stat(item.root)).isDirectory()).toBe(true);
  const modules = indexRetainedClientModules(home);
  expect(modules.has(`/assets/${expired.asset}`)).toBe(false);
  expect(await fs.readFile(modules.get(`/assets/${current.asset}`)!, 'utf8')).toContain('export default');
});

it('preserves modified snapshots, unknown files and symlinks even when their names look managed', async () => {
  const modified = await fixture(50), unknown = await fixture(50), linked = await fixture(50), current = await fixture(0);
  await fs.writeFile(path.join(modified.pinned, 'assets', modified.asset), 'user changes');
  await fs.writeFile(path.join(unknown.root, 'my-notes.txt'), 'keep these notes');
  const outside = path.join(home, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(linked.pinned, 'outside'));
  const result = await pruneClientSnapshots({ stateDirectory: state(), clientDirectory: current.pinned, keepNewest: 0 });
  expect(result.filter(item => item.action === 'removed')).toEqual([]);
  expect(await fs.readFile(path.join(modified.pinned, 'assets', modified.asset), 'utf8')).toBe('user changes');
  expect(await fs.readFile(path.join(unknown.root, 'my-notes.txt'), 'utf8')).toBe('keep these notes');
  expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
});

it('protects multiple live servers and reclaims an expired snapshot after its lease is released', async () => {
  const other = await fixture(50), current = await fixture(0);
  const release = leaseClientSnapshot(other.pinned, state()); releases.push(release);
  const options = { stateDirectory: state(), clientDirectory: current.pinned, keepNewest: 0 };
  await pruneClientSnapshots(options);
  expect((await fs.stat(other.root)).isDirectory()).toBe(true);
  release();
  await pruneClientSnapshots(options);
  await expect(fs.stat(other.root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('renews the grace period when a still-open old page imports a module', async () => {
  const old = await fixture(50), current = await fixture(0);
  touchRetainedClientModule(path.join(old.pinned, 'assets', old.asset));
  await pruneClientSnapshots({ stateDirectory: state(), clientDirectory: current.pinned, keepNewest: 0 });
  expect((await fs.stat(old.root)).isDirectory()).toBe(true);
});

it('serves a shared lazy module from a retained build after its first index entry expires', async () => {
  const expired = await fixture(50), retained = await fixture(0);
  const modules = new Map([['/assets/shared-12345678.js', path.join(expired.pinned, 'assets', 'shared-12345678.js')]]);
  await fs.rm(expired.root, { recursive: true });
  const found = resolveRetainedClientModule(modules, '/assets/shared-12345678.js', home);
  expect(found).toBe(path.join(retained.pinned, 'assets', 'shared-12345678.js'));
  expect(await fs.readFile(found!, 'utf8')).toBe('export default "shared";');
  expect(resolveRetainedClientModule(modules, '/assets/missing-12345678.js', home)).toBeUndefined();
});

it('previews cleanup without removing files and reuses the same client across server-only upgrades', async () => {
  const old = await fixture(50), current = await fixture(0);
  const result = await pruneClientSnapshots({ stateDirectory: state(), clientDirectory: current.pinned, keepNewest: 0, dryRun: true });
  expect(result).toContainEqual(expect.objectContaining({ path: old.root, action: 'would-remove' }));
  expect((await fs.stat(old.root)).isDirectory()).toBe(true);
  const file = path.join(current.packageRoot, 'runtime-manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')); manifest.serverBundleHash = 'sha256-new-server';
  await fs.writeFile(file, JSON.stringify(manifest));
  expect(pinBundledRuntimeClientDist(current.client, home)).toBe(current.pinned);
  expect((await fs.readdir(path.join(state(), 'client-snapshots'))).length).toBe(2);
});

it('preserves a modified cached client and copies a pristine client for the next server upgrade', async () => {
  const current = await fixture(0);
  const cachedAsset = path.join(current.pinned, 'assets', current.asset);
  await fs.writeFile(cachedAsset, 'user modifications');
  const file = path.join(current.packageRoot, 'runtime-manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')); manifest.serverBundleHash = 'sha256-another-server';
  await fs.writeFile(file, JSON.stringify(manifest));
  const upgraded = pinBundledRuntimeClientDist(current.client, home);
  expect(upgraded).not.toBe(current.pinned);
  expect(await fs.readFile(cachedAsset, 'utf8')).toBe('user modifications');
  expect(await fs.readFile(path.join(upgraded, 'assets', current.asset), 'utf8')).toContain('export default');
});

it('does not start production cleanup when a test boots an app using the real HOME', () => {
  const stop = startGeneratedStorageMaintenance({ stateDirectory: '/must-not-access-state', clientDirectory: '/must-not-access-client' });
  expect(stop()).toBeUndefined();
});
