import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';
const TERMDOCK_PACKAGE = 'termdock';
const NPM_QUERY_TIMEOUT_MS = 30_000;

export interface NpmUpdateResult {
  status: 'current' | 'updated' | 'newer-than-registry';
  currentVersion: string;
  latestVersion: string;
  source: 'official' | 'configured';
}

export type NpmUpdateFallbackStage = 'query' | 'install';
export type NpmUpdateLatestCallback = (
  latestVersion: string,
  source: NpmUpdateResult['source'],
) => void;

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

export function buildNpmViewArgs(registry: string | null = OFFICIAL_NPM_REGISTRY): string[] {
  const args = [
    'view',
    `${TERMDOCK_PACKAGE}@latest`,
    'version',
    '--json',
  ];
  if (registry) args.push('--registry', registry);
  return args;
}

export function buildNpmInstallArgs(
  version: string,
  registry: string | null = OFFICIAL_NPM_REGISTRY,
  prefix?: string,
): string[] {
  if (!parseVersion(version)) throw new Error(`Invalid Termdock version from npm: ${version}`);
  const args = [
    'install',
    '--global',
    `${TERMDOCK_PACKAGE}@${version}`,
  ];
  if (prefix) args.push('--prefix', prefix);
  if (registry) args.push('--registry', registry);
  args.push('--foreground-scripts');
  return args;
}


export interface TermdockInstallation { packageRoot: string; prefix: string }

function installedVersion(installation: TermdockInstallation): string {
  // Fresh filesystem reads: npm replaces this package while this process keeps
  // running old JS. Neither require/import caches nor TERMDOCK_VERSION attest it.
  if (fs.realpathSync(installation.packageRoot) !== installation.packageRoot) {
    throw new Error('Running Termdock installation changed location; check for updates again.');
  }
  const value: unknown = JSON.parse(fs.readFileSync(path.join(installation.packageRoot, 'package.json'), 'utf8'));
  if (!value || typeof value !== 'object' || !('name' in value) || value.name !== TERMDOCK_PACKAGE
    || !('version' in value) || typeof value.version !== 'string' || !parseVersion(value.version)) {
    throw new Error('Running Termdock installation has invalid package metadata.');
  }
  return value.version;
}

/** Resolve the module which is actually running, never PATH's unrelated npm root. */
export function resolveRunningTermdockInstallation(moduleUrl = import.meta.url, runningEntry = process.argv[1]): TermdockInstallation {
  const moduleFile = fs.realpathSync(fileURLToPath(moduleUrl));
  const packageRoot = path.resolve(path.dirname(moduleFile), '../../..');
  const nodeModules = path.dirname(packageRoot);
  if (path.basename(packageRoot) !== TERMDOCK_PACKAGE || path.basename(nodeModules) !== 'node_modules') {
    throw new Error('Automatic updates require a supported global Termdock installation.');
  }
  const parent = path.dirname(nodeModules);
  let prefix: string;
  if (process.platform === 'win32') prefix = parent;
  else if (path.basename(parent) === 'lib') prefix = path.dirname(parent);
  else throw new Error('Automatic updates require a supported global Termdock installation.');
  const installation = { packageRoot, prefix };
  // supervisor resolves and reuses this child's argv entry. A module loaded
  // from another installation must never approve that different restart root.
  if (!runningEntry || fs.realpathSync(runningEntry) !== path.join(packageRoot, 'dist/server/cli.js')) {
    throw new Error('Running Termdock entry does not match its update installation.');
  }
  installedVersion(installation);
  return installation;
}

export function verifyRunningTermdockInstallation(version: string, installation = resolveRunningTermdockInstallation()): void {
  if (compareVersions(installedVersion(installation), version) < 0) {
    throw new Error('Running Termdock installation has not completed this update; check for updates again.');
  }
}

export function parseNpmVersionOutput(output: string): string {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('The official npm registry returned invalid version metadata.');
  }
  if (typeof value !== 'string' || !parseVersion(value)) {
    throw new Error('The official npm registry returned an invalid Termdock version.');
  }
  return value;
}

export function npmRuntimeEnvironment(execPath = process.execPath, env = process.env, platform = process.platform): NodeJS.ProcessEnv {
  const systemBins=platform==='darwin'?['/opt/homebrew/bin','/usr/local/bin']:[];
  return { ...env, PATH: [path.dirname(execPath), ...systemBins, env.PATH].filter(Boolean).join(path.delimiter) };
}

async function installEnvironment(): Promise<NodeJS.ProcessEnv> {
  const env = npmRuntimeEnvironment();
  if (process.platform === 'darwin') {
    // New CLT releases can leave node-gyp's implicit libc++ search path stale.
    // Use the SDK selected by xcrun without changing the user's global setup.
    const { stdout } = await execFileAsync('/usr/bin/xcrun', ['--show-sdk-path'], { timeout: 5000, env });
    const sdk = stdout.trim();
    const headers = path.join(sdk, 'usr/include/c++/v1');
    if (!path.isAbsolute(sdk) || !fs.existsSync(path.join(headers, 'functional'))) {
      throw new Error('macOS C++ SDK headers are unavailable. Install or repair Command Line Tools, then retry.');
    }
    env.SDKROOT = sdk;
    env.CPLUS_INCLUDE_PATH = [headers, env.CPLUS_INCLUDE_PATH].filter(Boolean).join(path.delimiter);
  }
  return env;
}

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function fetchLatestVersion(registry: string | null): Promise<string> {
  let stdout: string;
  try {
    const result = await execFileAsync(npmExecutable(), buildNpmViewArgs(registry), {
      timeout: NPM_QUERY_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      env: npmRuntimeEnvironment(),
    });
    stdout = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const source = registry ?? 'the configured npm registry';
    throw new Error(`Unable to query ${source}: ${detail}`);
  }
  return parseNpmVersionOutput(stdout);
}

export async function installTermdockVersion(version: string, registry: string | null, installation: TermdockInstallation, executable = npmExecutable()): Promise<void> {
  if (compareVersions(installedVersion(installation), version) > 0) {
    throw new Error('Running Termdock location already contains a newer version; restart that installation manually.');
  }
  const env = await installEnvironment();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, buildNpmInstallArgs(version, registry, installation.prefix), {
      stdio: 'inherit',
      env,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      reject(new Error(`npm failed to install Termdock (${reason}).`));
    });
  });
  if (installedVersion(installation) !== version) {
    throw new Error('npm did not install the requested version at the running Termdock location.');
  }
}

export async function updateTermdockFromOfficialRegistry(
  currentVersion: string,
  onFallback?: (stage: NpmUpdateFallbackStage, error: Error) => void,
  onLatest?: NpmUpdateLatestCallback,
): Promise<NpmUpdateResult> {
  if (!parseVersion(currentVersion)) throw new Error(`Invalid installed Termdock version: ${currentVersion}`);
  let source: NpmUpdateResult['source'] = 'official';
  let latestVersion: string;
  try {
    latestVersion = await fetchLatestVersion(OFFICIAL_NPM_REGISTRY);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    onFallback?.('query', cause);
    source = 'configured';
    latestVersion = await fetchLatestVersion(null);
  }
  onLatest?.(latestVersion, source);
  const comparison = compareVersions(currentVersion, latestVersion);
  if (comparison === 0) return { status: 'current', currentVersion, latestVersion, source };
  if (comparison > 0) return { status: 'newer-than-registry', currentVersion, latestVersion, source };

  const installation = resolveRunningTermdockInstallation();
  try {
    await installTermdockVersion(latestVersion, source === 'official' ? OFFICIAL_NPM_REGISTRY : null, installation);
  } catch (error) {
    if (source === 'configured') throw error;
    const cause = error instanceof Error ? error : new Error(String(error));
    onFallback?.('install', cause);
    source = 'configured';
    await installTermdockVersion(latestVersion, null, installation);
  }
  return { status: 'updated', currentVersion, latestVersion, source };
}
