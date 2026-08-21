import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

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
): string[] {
  if (!parseVersion(version)) throw new Error(`Invalid Termdock version from npm: ${version}`);
  const args = [
    'install',
    '--global',
    `${TERMDOCK_PACKAGE}@${version}`,
  ];
  if (registry) args.push('--registry', registry);
  args.push('--foreground-scripts');
  return args;
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

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function fetchLatestVersion(registry: string | null): Promise<string> {
  let stdout: string;
  try {
    const result = await execFileAsync(npmExecutable(), buildNpmViewArgs(registry), {
      timeout: NPM_QUERY_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      env: process.env,
    });
    stdout = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const source = registry ?? 'the configured npm registry';
    throw new Error(`Unable to query ${source}: ${detail}`);
  }
  return parseNpmVersionOutput(stdout);
}

function installVersion(version: string, registry: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(npmExecutable(), buildNpmInstallArgs(version, registry), {
      stdio: 'inherit',
      env: process.env,
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
}

export async function updateTermdockFromOfficialRegistry(
  currentVersion: string,
  onFallback?: (stage: NpmUpdateFallbackStage, error: Error) => void,
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
  const comparison = compareVersions(currentVersion, latestVersion);
  if (comparison === 0) return { status: 'current', currentVersion, latestVersion, source };
  if (comparison > 0) return { status: 'newer-than-registry', currentVersion, latestVersion, source };

  try {
    await installVersion(latestVersion, source === 'official' ? OFFICIAL_NPM_REGISTRY : null);
  } catch (error) {
    if (source === 'configured') throw error;
    const cause = error instanceof Error ? error : new Error(String(error));
    onFallback?.('install', cause);
    source = 'configured';
    await installVersion(latestVersion, null);
  }
  return { status: 'updated', currentVersion, latestVersion, source };
}
