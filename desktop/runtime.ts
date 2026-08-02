import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REGISTRY_PACKAGE_URL = 'https://registry.npmjs.org/termdock/latest';
const REGISTRY_KEYS_URL = 'https://registry.npmjs.org/-/npm/v1/keys';
const UPDATE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_RUNTIME_ARCHIVE_BYTES = 128 * 1024 * 1024;

export interface RuntimeManifest {
  schemaVersion: number;
  packageName: string;
  version: string;
  runtimeProtocolVersion: number;
  minimumDesktopVersion: string;
  nodeMajor: number;
  dependencyHash: string;
  serverBundleHash: string;
  entrypoint: string;
  clientEntrypoint: string;
}

export interface DesktopRuntimePaths {
  serverRoot: string;
  cli: string;
  version: string;
  source: 'bundled' | 'downloaded' | 'development';
}

export interface RuntimeUpdateResult {
  status: 'disabled' | 'current' | 'updated' | 'requires-desktop';
  currentVersion: string;
  latestVersion?: string;
  reason?: string;
}

interface RegistrySignature {
  keyid: string;
  sig: string;
}

interface RegistryMetadata {
  name?: unknown;
  version?: unknown;
  dist?: {
    integrity?: unknown;
    tarball?: unknown;
    signatures?: unknown;
  };
}

interface RegistryKey {
  keyid?: unknown;
  key?: unknown;
  keytype?: unknown;
  expires?: unknown;
}

interface RuntimeState {
  schemaVersion: 1;
  currentVersion: string | null;
  previousVersion: string | null;
  activatedAt: string;
}

interface RuntimeContext {
  appVersion: string;
  resourcesPath: string;
  homeDir?: string;
}

function parseVersion(value: string): { numbers: number[]; prerelease: string | null } | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Invalid version comparison: ${left} / ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  const manifest = value as Partial<RuntimeManifest> | null;
  if (
    !manifest
    || manifest.schemaVersion !== 1
    || manifest.packageName !== 'termdock'
    || typeof manifest.version !== 'string'
    || !parseVersion(manifest.version)
    || typeof manifest.runtimeProtocolVersion !== 'number'
    || typeof manifest.minimumDesktopVersion !== 'string'
    || !parseVersion(manifest.minimumDesktopVersion)
    || typeof manifest.nodeMajor !== 'number'
    || !Number.isInteger(manifest.nodeMajor)
    || typeof manifest.dependencyHash !== 'string'
    || !/^sha256-[A-Za-z0-9+/]+={0,2}$/.test(manifest.dependencyHash)
    || typeof manifest.serverBundleHash !== 'string'
    || !/^sha256-[A-Za-z0-9+/]+={0,2}$/.test(manifest.serverBundleHash)
    || manifest.entrypoint !== 'dist/server/cli.js'
    || manifest.clientEntrypoint !== 'dist/client/index.html'
  ) {
    throw new Error('Runtime manifest is missing or malformed.');
  }
  return manifest as RuntimeManifest;
}

export function runtimeCompatibilityError(
  candidate: RuntimeManifest,
  bundled: RuntimeManifest,
  appVersion: string,
): string | null {
  if (candidate.runtimeProtocolVersion !== bundled.runtimeProtocolVersion) {
    return `runtime protocol ${candidate.runtimeProtocolVersion} requires a desktop update`;
  }
  if (compareVersions(appVersion, candidate.minimumDesktopVersion) < 0) {
    return `desktop ${candidate.minimumDesktopVersion} or newer is required`;
  }
  if (candidate.nodeMajor !== bundled.nodeMajor) {
    return `Node ${candidate.nodeMajor} requires a desktop runtime rebuild`;
  }
  if (candidate.dependencyHash !== bundled.dependencyHash) {
    return 'production dependencies changed and require a desktop runtime rebuild';
  }
  return null;
}

export function verifyPackageIntegrity(data: Buffer, integrity: string): boolean {
  const candidate = integrity.split(/\s+/).find((entry) => entry.startsWith('sha512-'));
  if (!candidate) return false;
  const expected = Buffer.from(candidate.slice('sha512-'.length), 'base64');
  const actual = crypto.createHash('sha512').update(data).digest();
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function verifyRegistrySignature(input: {
  packageName: string;
  version: string;
  integrity: string;
  signatures: RegistrySignature[];
  keys: RegistryKey[];
  now?: number;
}): boolean {
  const message = Buffer.from(`${input.packageName}@${input.version}:${input.integrity}`);
  const now = input.now ?? Date.now();
  return input.signatures.some((signature) => {
    const key = input.keys.find((candidate) => candidate.keyid === signature.keyid);
    if (!key || typeof key.key !== 'string' || key.keytype !== 'ecdsa-sha2-nistp256') return false;
    if (typeof key.expires === 'string' && Date.parse(key.expires) < now) return false;
    try {
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(key.key, 'base64'),
        format: 'der',
        type: 'spki',
      });
      return crypto.verify('sha256', message, publicKey, Buffer.from(signature.sig, 'base64'));
    } catch {
      return false;
    }
  });
}

export function validateTarEntries(output: string): void {
  const entries = output.split('\n').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('Runtime archive is empty.');
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    if (
      !normalized.startsWith('package/')
      || normalized.startsWith('/')
      || normalized.split('/').includes('..')
    ) {
      throw new Error(`Unsafe runtime archive entry: ${entry}`);
    }
  }
}

function runtimeRoot(homeDir = os.homedir()): string {
  return path.join(homeDir, '.termdock', 'desktop-runtime');
}

function bundledManifest(resourcesPath: string): RuntimeManifest {
  return parseRuntimeManifest(readJson(path.join(resourcesPath, 'server', 'runtime-manifest.json')));
}

function ensureBundledDependencies(packageRoot: string, resourcesPath: string): void {
  const nodeModulesPath = path.join(packageRoot, 'node_modules');
  const bundledNodeModules = path.join(resourcesPath, 'server', 'node_modules');
  try {
    const stat = fs.lstatSync(nodeModulesPath);
    if (stat.isSymbolicLink() && fs.realpathSync(nodeModulesPath) === fs.realpathSync(bundledNodeModules)) {
      return;
    }
    fs.rmSync(nodeModulesPath, { recursive: true, force: true });
  } catch {
    // Missing or stale links are recreated below.
  }
  fs.symlinkSync(bundledNodeModules, nodeModulesPath, 'dir');
}

function downloadedRuntime(context: RuntimeContext): DesktopRuntimePaths | null {
  const root = runtimeRoot(context.homeDir);
  const currentPath = path.join(root, 'current');
  try {
    const resolved = fs.realpathSync(currentPath);
    const versionsRoot = fs.realpathSync(path.join(root, 'versions'));
    const relative = path.relative(versionsRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const packageRoot = path.join(resolved, 'package');
    const manifest = parseRuntimeManifest(readJson(path.join(packageRoot, 'runtime-manifest.json')));
    const bundled = bundledManifest(context.resourcesPath);
    if (runtimeCompatibilityError(manifest, bundled, context.appVersion)) return null;
    const packageJson = readJson(path.join(packageRoot, 'package.json')) as { version?: unknown };
    if (packageJson.version !== manifest.version) return null;
    const cli = path.join(packageRoot, manifest.entrypoint);
    const client = path.join(packageRoot, manifest.clientEntrypoint);
    if (!fs.existsSync(cli) || !fs.existsSync(client)) return null;
    ensureBundledDependencies(packageRoot, context.resourcesPath);
    return { serverRoot: packageRoot, cli, version: manifest.version, source: 'downloaded' };
  } catch {
    return null;
  }
}

export function resolvePackagedRuntime(context: RuntimeContext): DesktopRuntimePaths {
  const downloaded = downloadedRuntime(context);
  if (downloaded) return downloaded;
  const manifest = bundledManifest(context.resourcesPath);
  return {
    serverRoot: path.join(context.resourcesPath, 'server'),
    cli: path.join(context.resourcesPath, 'server', manifest.entrypoint),
    version: manifest.version,
    source: 'bundled',
  };
}

function writeRuntimeState(root: string, state: RuntimeState): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const statePath = path.join(root, 'state.json');
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, statePath);
}

function readRuntimeState(root: string): RuntimeState | null {
  try {
    const value = readJson(path.join(root, 'state.json')) as Partial<RuntimeState>;
    if (value.schemaVersion !== 1) return null;
    return value as RuntimeState;
  } catch {
    return null;
  }
}

function switchCurrent(root: string, version: string | null): void {
  const currentPath = path.join(root, 'current');
  const nextPath = `${currentPath}.${process.pid}.next`;
  fs.rmSync(nextPath, { recursive: true, force: true });
  if (version === null) {
    fs.rmSync(currentPath, { recursive: true, force: true });
    return;
  }
  fs.symlinkSync(path.join('versions', version), nextPath, 'dir');
  fs.renameSync(nextPath, currentPath);
}

function switchClient(root: string, version: string | null): void {
  const clientPath = path.join(root, 'client-current');
  const nextPath = `${clientPath}.${process.pid}.next`;
  fs.rmSync(nextPath, { recursive: true, force: true });
  if (version === null) {
    fs.rmSync(clientPath, { recursive: true, force: true });
    return;
  }
  fs.symlinkSync(path.join('versions', version), nextPath, 'dir');
  fs.renameSync(nextPath, clientPath);
}

function activateRuntime(
  root: string,
  currentVersion: string,
  nextVersion: string,
  activateClient: boolean,
): void {
  const currentIsDownloaded = fs.existsSync(path.join(root, 'current'));
  switchCurrent(root, nextVersion);
  if (activateClient) switchClient(root, nextVersion);
  writeRuntimeState(root, {
    schemaVersion: 1,
    currentVersion: nextVersion,
    previousVersion: currentIsDownloaded ? currentVersion : null,
    activatedAt: new Date().toISOString(),
  });
}

export function rollbackDownloadedRuntime(context: RuntimeContext, failedVersion: string): boolean {
  const root = runtimeRoot(context.homeDir);
  const state = readRuntimeState(root);
  if (!state || state.currentVersion !== failedVersion) return false;
  const previous = state.previousVersion;
  if (previous && !fs.existsSync(path.join(root, 'versions', previous, 'package'))) return false;
  switchCurrent(root, previous);
  try {
    const clientVersion = path.basename(fs.realpathSync(path.join(root, 'client-current')));
    if (clientVersion === failedVersion) switchClient(root, previous);
  } catch {
    // A missing client pointer means the running server uses its own fallback.
  }
  writeRuntimeState(root, {
    schemaVersion: 1,
    currentVersion: previous,
    previousVersion: null,
    activatedAt: new Date().toISOString(),
  });
  return true;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Termdock-Desktop-Runtime-Updater' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Update metadata returned HTTP ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function download(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'registry.npmjs.org') {
    throw new Error(`Unexpected runtime package host: ${parsed.hostname}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetch(parsed, {
      headers: { 'User-Agent': 'Termdock-Desktop-Runtime-Updater' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Runtime download returned HTTP ${response.status}.`);
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_RUNTIME_ARCHIVE_BYTES) {
      throw new Error(`Runtime package is unexpectedly large (${declaredSize} bytes).`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_RUNTIME_ARCHIVE_BYTES) {
      throw new Error(`Runtime package exceeds ${MAX_RUNTIME_ARCHIVE_BYTES} bytes.`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function parseRegistryMetadata(value: unknown): {
  version: string;
  integrity: string;
  tarball: string;
  signatures: RegistrySignature[];
} {
  const metadata = value as RegistryMetadata;
  const signatures = Array.isArray(metadata.dist?.signatures)
    ? metadata.dist.signatures.filter((entry): entry is RegistrySignature => {
      const candidate = entry as Partial<RegistrySignature>;
      return typeof candidate.keyid === 'string' && typeof candidate.sig === 'string';
    })
    : [];
  if (
    metadata.name !== 'termdock'
    || typeof metadata.version !== 'string'
    || !parseVersion(metadata.version)
    || typeof metadata.dist?.integrity !== 'string'
    || typeof metadata.dist.tarball !== 'string'
    || signatures.length === 0
  ) {
    throw new Error('npm returned incomplete Termdock update metadata.');
  }
  return {
    version: metadata.version,
    integrity: metadata.dist.integrity,
    tarball: metadata.dist.tarball,
    signatures,
  };
}

export async function updateRuntimeFromRegistry(context: RuntimeContext): Promise<RuntimeUpdateResult> {
  const current = resolvePackagedRuntime(context);
  if (process.env.TERMDOCK_RUNTIME_UPDATE === '0') {
    return { status: 'disabled', currentVersion: current.version };
  }
  const metadata = parseRegistryMetadata(await fetchJson(REGISTRY_PACKAGE_URL));
  if (compareVersions(metadata.version, current.version) <= 0) {
    return { status: 'current', currentVersion: current.version, latestVersion: metadata.version };
  }

  const keysResponse = await fetchJson(REGISTRY_KEYS_URL) as { keys?: unknown };
  const keys = Array.isArray(keysResponse.keys) ? keysResponse.keys as RegistryKey[] : [];
  if (!verifyRegistrySignature({
    packageName: 'termdock',
    version: metadata.version,
    integrity: metadata.integrity,
    signatures: metadata.signatures,
    keys,
  })) {
    throw new Error('npm registry signature verification failed.');
  }

  const archive = await download(metadata.tarball);
  if (!verifyPackageIntegrity(archive, metadata.integrity)) {
    throw new Error('Runtime package SHA-512 verification failed.');
  }

  const root = runtimeRoot(context.homeDir);
  const versionsRoot = path.join(root, 'versions');
  const stagingRoot = path.join(root, `.staging-${process.pid}-${crypto.randomUUID()}`);
  const archivePath = path.join(stagingRoot, 'runtime.tgz');
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    const { stdout } = await execFileAsync('/usr/bin/tar', ['-tzf', archivePath], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    validateTarEntries(stdout);
    await execFileAsync('/usr/bin/tar', ['-xzf', archivePath, '-C', stagingRoot]);
    const packageRoot = path.join(stagingRoot, 'package');
    const manifest = parseRuntimeManifest(readJson(path.join(packageRoot, 'runtime-manifest.json')));
    if (manifest.version !== metadata.version) {
      throw new Error('Runtime manifest version does not match npm metadata.');
    }
    const compatibilityError = runtimeCompatibilityError(
      manifest,
      bundledManifest(context.resourcesPath),
      context.appVersion,
    );
    if (compatibilityError) {
      return {
        status: 'requires-desktop',
        currentVersion: current.version,
        latestVersion: metadata.version,
        reason: compatibilityError,
      };
    }
    const packageJson = readJson(path.join(packageRoot, 'package.json')) as { version?: unknown };
    if (packageJson.version !== manifest.version) {
      throw new Error('Runtime package version does not match its manifest.');
    }
    if (
      !fs.existsSync(path.join(packageRoot, manifest.entrypoint))
      || !fs.existsSync(path.join(packageRoot, manifest.clientEntrypoint))
    ) {
      throw new Error('Runtime package is missing its server or client entrypoint.');
    }

    fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
    const versionRoot = path.join(versionsRoot, manifest.version);
    fs.rmSync(versionRoot, { recursive: true, force: true });
    fs.mkdirSync(versionRoot, { mode: 0o700 });
    fs.renameSync(packageRoot, path.join(versionRoot, 'package'));
    ensureBundledDependencies(path.join(versionRoot, 'package'), context.resourcesPath);
    const currentManifest = parseRuntimeManifest(
      readJson(path.join(current.serverRoot, 'runtime-manifest.json')),
    );
    activateRuntime(
      root,
      current.version,
      manifest.version,
      currentManifest.serverBundleHash === manifest.serverBundleHash,
    );
    return {
      status: 'updated',
      currentVersion: manifest.version,
      latestVersion: manifest.version,
    };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}
