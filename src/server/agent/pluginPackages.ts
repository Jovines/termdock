import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ICON_FILE,
  MANIFEST_FILE,
  PLUGINS_DIR,
  SOURCE_METADATA_FILE,
  type AgentPluginManifest,
  type LoadedPlugin,
  type PluginSourceMetadata,
  validateManifest,
  writePluginSourceMetadata,
} from './plugins.js';

const execFileAsync = promisify(execFile);
const MAX_PACKAGE_FILES = 512;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 45_000;
const IGNORED_NAMES = new Set(['.git', '.github', 'node_modules', SOURCE_METADATA_FILE]);
function hardenedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  // Keep the service user's credential helpers, SSH agent/config, CA and
  // proxy settings. Only repository-local context inherited from a caller
  // must not redirect these operations into another working tree.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return env;
}

const GIT_OPTIONS = [
  '-c', `core.hooksPath=${os.devNull}`,
  '-c', 'protocol.allow=never',
  '-c', 'protocol.http.allow=always',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ssh.allow=always',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
];

export interface PreparedPluginPackage {
  manifest: AgentPluginManifest;
  packageDir: string;
  metadata: PluginSourceMetadata;
  cleanup: () => Promise<void>;
}

export interface PluginUpdateCheck {
  supported: boolean;
  updateAvailable: boolean;
  revision: string | null;
  latestRevision: string | null;
  checkedAt: number;
}

function gitHostAllowed(host: string): boolean {
  const configured = (process.env.TERMDOCK_PLUGIN_GIT_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  // An explicit administrative allowlist is optional. Self-hosted and
  // private-network hosts work without having to edit service environment.
  return configured.length === 0 || configured.includes(host.toLowerCase());
}

export function normalizeGitPluginSource(input: string): string | null {
  const source = input.trim();
  if (!source || source.startsWith('-') || /[\x00-\x20\x7f]/.test(source) || /^[A-Za-z]:[\\/]/.test(source)) return null;
  if (!source.includes('://')) {
    const scp = /^(?:[A-Za-z0-9_.-]+@)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9][A-Za-z0-9._-]*):([^?#\\]+)$/.exec(source);
    if (!scp || scp[2].startsWith('-') || !gitHostAllowed(scp[1])) return null;
    return source;
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash) return null;
  if (!url.hostname || url.hostname.startsWith('-') || !gitHostAllowed(url.hostname)) return null;
  if (url.pathname === '/' || /%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString();
}

async function packageTreeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;

  async function visit(directory: string, relative = ''): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Plugin packages may not contain symbolic links: ${path.join(relative, entry.name)}`);
      const absolute = path.join(directory, entry.name);
      const nextRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, nextRelative);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported plugin package entry: ${nextRelative}`);
      const stat = await fs.promises.stat(absolute);
      files += 1;
      bytes += stat.size;
      if (files > MAX_PACKAGE_FILES) throw new Error(`Plugin package exceeds ${MAX_PACKAGE_FILES} files`);
      if (stat.size > MAX_SINGLE_FILE_BYTES) throw new Error(`Plugin file is too large: ${nextRelative}`);
      if (bytes > MAX_PACKAGE_BYTES) throw new Error('Plugin package exceeds the 16 MB unpacked limit');
      hash.update(nextRelative.replaceAll(path.sep, '/'));
      hash.update('\0');
      hash.update(await fs.promises.readFile(absolute));
      hash.update('\0');
    }
  }

  await visit(root);
  return hash.digest('hex');
}

async function copyPackageTree(source: string, destination: string): Promise<void> {
  await packageTreeDigest(source); // validates limits and symlinks before any destination write
  await fs.promises.mkdir(destination, { recursive: true });

  async function copy(directory: string, output: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const from = path.join(directory, entry.name);
      const to = path.join(output, entry.name);
      if (entry.isDirectory()) {
        await fs.promises.mkdir(to, { recursive: true });
        await copy(from, to);
      } else {
        await fs.promises.copyFile(from, to);
        const stat = await fs.promises.stat(from);
        await fs.promises.chmod(to, stat.mode & 0o777);
      }
    }
  }

  await copy(source, destination);
}

function validateIcon(packageDir: string): void {
  const iconPath = path.join(packageDir, ICON_FILE);
  if (!fs.existsSync(iconPath)) return;
  const svg = fs.readFileSync(iconPath, 'utf8');
  if (!/^\s*<svg\b/i.test(svg)) throw new Error('icon.svg must contain an SVG document');
  if (/<(?:script|style|foreignObject|iframe|object|embed)\b/i.test(svg)
    || /<\?(?:xml|xml-stylesheet)\b|<!DOCTYPE\b/i.test(svg)
    || /\bon[a-z]+\s*=/i.test(svg)
    || /(?:href|src)\s*=\s*["']?\s*(?!#)[^"'\s>]+/i.test(svg)
    || /url\(\s*(?!["']?#)[^)]+\)/i.test(svg)) {
    throw new Error('icon.svg contains unsafe active content');
  }
}

async function readAndValidateManifest(packageDir: string, expectedSlug?: string): Promise<AgentPluginManifest> {
  const manifestPath = path.join(packageDir, MANIFEST_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Plugin package must contain a valid root manifest.json: ${(error as Error).message}`);
  }
  const validation = validateManifest(raw, packageDir);
  if ('error' in validation) {
    const error = new Error(validation.error.errors.join('\n')) as Error & { code?: string; migration?: unknown };
    error.code = validation.error.code ?? 'AGENT_PLUGIN_MANIFEST_INVALID';
    error.migration = validation.error.migration;
    throw error;
  }
  if (expectedSlug && validation.manifest.slug !== expectedSlug) {
    throw new Error(`Update source declares slug "${validation.manifest.slug}"; expected "${expectedSlug}"`);
  }
  validateIcon(packageDir);
  return validation.manifest;
}

export async function preparePluginPackage(sourceInput: string, expectedSlug?: string): Promise<PreparedPluginPackage> {
  const source = sourceInput.trim();
  if (!source) throw new Error('Plugin source is required');
  const remote = normalizeGitPluginSource(source);
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'termdock-plugin-'));
  let packageDir: string;
  let type: PluginSourceMetadata['type'];
  let normalizedSource: string;
  let revision: string;

  try {
    if (remote) {
      packageDir = path.join(temporaryRoot, 'repo');
      await execFileAsync('git', [
        ...GIT_OPTIONS,
        'clone', '--depth', '1', '--single-branch', '--no-recurse-submodules', '--', remote, packageDir,
      ], {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: hardenedGitEnv(),
      });
      const result = await execFileAsync('git', ['-C', packageDir, 'rev-parse', 'HEAD'], {
        timeout: 5000,
        maxBuffer: 128 * 1024,
        env: hardenedGitEnv(),
      });
      revision = result.stdout.trim();
      type = 'git';
      normalizedSource = remote;
    } else {
      if (source.includes('://') || /^(?:[^/]+@[^/]+:|[^/]+::)/.test(source)) {
        throw new Error('Unsupported Git source: use an HTTPS, HTTP or SSH repository URL, an scp-style Git address, or a local package directory');
      }
      const resolved = path.resolve(source === '~' ? os.homedir() : source.startsWith('~/') ? path.join(os.homedir(), source.slice(2)) : source);
      const stat = await fs.promises.stat(resolved).catch(() => null);
      if (!stat) throw new Error('Plugin source must be an existing local path or an accessible HTTPS, HTTP or SSH Git repository');
      packageDir = stat.isDirectory() ? resolved : path.dirname(resolved);
      if (!stat.isDirectory() && path.basename(resolved) !== MANIFEST_FILE) {
        throw new Error('A local plugin file must be named manifest.json');
      }
      type = 'local';
      normalizedSource = packageDir;
      revision = await packageTreeDigest(packageDir);
    }

    const manifest = await readAndValidateManifest(packageDir, expectedSlug);
    const previous = expectedSlug
      ? (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, expectedSlug, SOURCE_METADATA_FILE), 'utf8')) as Partial<PluginSourceMetadata>;
        } catch {
          return null;
        }
      })()
      : null;
    const now = Date.now();
    return {
      manifest,
      packageDir,
      metadata: {
        version: 1,
        type,
        source: normalizedSource,
        revision,
        latestRevision: revision,
        installedAt: typeof previous?.installedAt === 'number' ? previous.installedAt : now,
        updatedAt: now,
        checkedAt: now,
      },
      cleanup: () => fs.promises.rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function commitPreparedPlugin(prepared: PreparedPluginPackage, replace = false): Promise<string> {
  await fs.promises.mkdir(PLUGINS_DIR, { recursive: true });
  const target = path.join(PLUGINS_DIR, prepared.manifest.slug);
  if (!replace && fs.existsSync(target)) {
    await prepared.cleanup();
    throw new Error(`Plugin "${prepared.manifest.slug}" already exists`);
  }
  const stage = path.join(PLUGINS_DIR, `.stage-${prepared.manifest.slug}-${randomUUID()}`);
  const backup = path.join(PLUGINS_DIR, `.backup-${prepared.manifest.slug}-${randomUUID()}`);
  try {
    await copyPackageTree(prepared.packageDir, stage);
    await fs.promises.writeFile(path.join(stage, MANIFEST_FILE), JSON.stringify(prepared.manifest, null, 2), 'utf8');
    writePluginSourceMetadata(stage, prepared.metadata);
    if (fs.existsSync(target)) await fs.promises.rename(target, backup);
    try {
      await fs.promises.rename(stage, target);
    } catch (error) {
      if (fs.existsSync(backup)) await fs.promises.rename(backup, target);
      throw error;
    }
    await fs.promises.rm(backup, { recursive: true, force: true });
    return target;
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true });
    await prepared.cleanup();
  }
}

export async function checkPluginPackageUpdate(plugin: LoadedPlugin): Promise<PluginUpdateCheck> {
  const checkedAt = Date.now();
  const metadata = plugin.source;
  if (!metadata?.source || metadata.type === 'manifest') {
    return { supported: false, updateAvailable: false, revision: metadata?.revision ?? null, latestRevision: null, checkedAt };
  }
  let latestRevision: string;
  if (metadata.type === 'git') {
    const remote = normalizeGitPluginSource(metadata.source);
    if (!remote) throw new Error('The stored Git source is invalid or excluded by TERMDOCK_PLUGIN_GIT_HOSTS');
    const { stdout } = await execFileAsync('git', [
      ...GIT_OPTIONS,
      'ls-remote', '--', remote, 'HEAD',
    ], {
      timeout: 15_000,
      maxBuffer: 128 * 1024,
      env: hardenedGitEnv(),
    });
    latestRevision = stdout.trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{40,64}$/i.test(latestRevision)) throw new Error('Unable to resolve the plugin repository HEAD');
  } else {
    latestRevision = await packageTreeDigest(metadata.source);
  }
  const next: PluginSourceMetadata = { ...metadata, latestRevision, checkedAt };
  writePluginSourceMetadata(plugin.dir, next);
  return {
    supported: true,
    updateAvailable: Boolean(metadata.revision && latestRevision !== metadata.revision),
    revision: metadata.revision,
    latestRevision,
    checkedAt,
  };
}
