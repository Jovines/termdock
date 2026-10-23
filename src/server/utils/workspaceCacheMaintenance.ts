import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CacheCleanupEntry } from './clientSnapshotMaintenance.js';

const exec = promisify(execFile);
const DAY = 24 * 60 * 60_000;
const git = async (cwd: string, args: string[]) => (await exec('git', ['-C', cwd, ...args], {
  timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
})).stdout.trim();

// A separate Node process runs INSIDE Cargo's Linux flock. No shell evaluates
// paths. Source, node_modules, final binaries, bundles and unknown files stay.
const CARGO_CACHE_WORKER = String.raw`
const fs = await import('node:fs/promises');
const path = await import('node:path');
const { execFileSync } = await import('node:child_process');
const o = JSON.parse(process.argv[1]);
const result = [];
const real = async p => (await fs.lstat(p)).isDirectory() && await fs.realpath(p) === path.resolve(p);
const git = args => execFileSync('git', ['-C', o.workspace, ...args], { encoding: 'utf8', timeout: 15000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const busy = async () => {
  for (const e of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(e) || [process.pid, process.ppid].includes(Number(e))) continue;
    const p = '/proc/' + e;
    try {
      if ((await fs.stat(p)).uid !== process.getuid()) continue;
      for (const link of ['cwd', 'exe']) {
        let value; try { value = await fs.readlink(p + '/' + link); } catch { continue; }
        if (value === o.workspace || value.startsWith(o.workspace + path.sep)) return true;
      }
      const args = (await fs.readFile(p + '/cmdline', 'utf8')).split('\0');
      if (args.some(a => a.includes(o.workspace))) return true;
      // Protect libraries and executables mapped from an otherwise idle checkout.
      try { if ((await fs.readFile(p + '/maps', 'utf8')).includes(o.workspace + path.sep)) return true; } catch {}
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) return true; }
  }
  return false;
};
try {
  if (!await real(o.workspace) || !await real(o.target) || !await real(o.profile)) throw new Error('linked-or-missing-directory');
  if (git(['branch', '--show-current']) !== o.branch || git(['rev-parse', '--show-toplevel']) !== o.workspace) throw new Error('workspace-identity-changed');
  const lock = await fs.lstat(path.join(o.profile, '.cargo-lock'));
  if (!lock.isFile() || lock.ino !== o.lockIno || lock.dev !== o.lockDev) throw new Error('cargo-lock-changed');
  const tag = path.join(o.target, 'CACHEDIR.TAG');
  if (!(await fs.lstat(tag)).isFile() || !(await fs.readFile(tag, 'utf8')).startsWith('Signature: 8a477f597d28d172789f06886806bc55')) throw new Error('missing-cargo-cache-tag');
  const manifest = path.join(o.target, '..', 'Cargo.toml');
  if (!(await fs.lstat(manifest)).isFile()) throw new Error('missing-cargo-manifest');
  if (await busy()) throw new Error('workspace-in-use');
  for (const name of ['deps', 'incremental', 'build', '.fingerprint']) {
    const directory = path.join(o.profile, name);
    try {
      if (!await real(directory)) continue;
      const relative = path.relative(o.workspace, directory).split(path.sep).join('/');
      if (git(['ls-files', '--', relative])) throw new Error('tracked-files-in-cache');
      execFileSync('git', ['-C', o.workspace, 'check-ignore', '--quiet', '--', relative + '/'], { timeout: 15000 });
      const entries = await fs.readdir(directory, { withFileTypes: true });
      if (!entries.length) continue;
      if (entries.some(e => name === 'deps'
        ? !e.isFile() || !/^[A-Za-z0-9_.-]+-[a-f0-9]{8,32}(?:\.[A-Za-z0-9_.-]+)?$/.test(e.name)
        : !e.isDirectory() || !(name === 'incremental' ? /^[A-Za-z0-9_]+-[a-z0-9]+$/ : /^[A-Za-z0-9_.-]+-[a-f0-9]{8,32}$/).test(e.name))) throw new Error('unknown-cache-content');
      let bytes = 0, newest = 0, count = 0, observed = [];
      const identity = s => [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.isFile() ? s.atimeMs : 0].join(':');
      const walk = async p => {
        if (++count > 500000) throw new Error('cache-scan-limit');
        const s = await fs.lstat(p);
        if (!s.isFile() && !s.isDirectory()) throw new Error('linked-or-special-cache-content');
        if (name === 'build') {
          const parts = path.relative(directory, p).split(path.sep);
          if (parts.length === 2 && (s.isDirectory() ? parts[1] !== 'out'
            : !/^(?:invoked\.timestamp|output|stderr|root-output|build-script-build|build_script_build-[a-f0-9]+(?:\.d)?)$/.test(parts[1]))) throw new Error('unknown-cache-content');
        }
        observed.push([p,identity(s)]); newest = Math.max(newest,s.mtimeMs,s.isFile() ? s.atimeMs : 0);
        if (s.isFile()) {
          const file = path.basename(p);
          if (name === 'incremental' && !/\.(?:o|bin|rmeta|bc|lock)$/.test(file)) throw new Error('unknown-cache-content');
          if (name === '.fingerprint' && !/^(?:invoked\.timestamp|(?:lib|bin|test|bench|example|dep|run|build|output)[-_][A-Za-z0-9_.-]+)$/.test(file)) throw new Error('unknown-cache-content');
          bytes += s.size; return;
        }
        for (const e of await fs.readdir(p)) await walk(path.join(p,e));
      };
      const cold = [];
      for (const entry of entries) {
        bytes = 0; newest = 0; observed = [];
        const file = path.join(directory, entry.name); await walk(file);
        if (o.now - newest >= o.idleMs) cold.push({ file, bytes, observed });
      }
      if (!cold.length) throw new Error('recently-used-cache');
      if (await busy()) throw new Error('workspace-in-use');
      for (const item of cold) for (const [p,id] of item.observed) if (identity(await fs.lstat(p)) !== id) throw new Error('cache-changed-during-check');
      // Holding .cargo-lock keeps a new Cargo build from racing the deletion.
      // Reclaim cold units inside a mixed cache, leaving recently read units.
      if (!o.dryRun) {
        for (const item of cold) await fs.rm(item.file, { recursive: true });
        try { await fs.rmdir(directory); } catch (error) { if (!['ENOTEMPTY','EEXIST'].includes(error.code)) throw error; }
      }
      result.push({ path: directory, action: o.dryRun ? 'would-remove' : 'removed', reason: 'verified-idle-cargo-intermediates',
        bytes: cold.reduce((sum,item) => sum + item.bytes, 0), entriesRemoved: cold.length, entriesRetained: entries.length - cold.length });
    } catch (error) { result.push({ path: directory, action: 'retained', reason: error.message || 'cache-validation-failed', bytes: 0 }); }
  }
} catch (error) { result.push({ path: o.profile, action: 'retained', reason: error.message, bytes: 0 }); }
process.stdout.write(JSON.stringify(result));
`;

/** Only registered Termdock task worktrees and Cargo's disposable internals. */
export async function pruneWorkspaceCaches(options: {
  stateDirectory: string; dryRun?: boolean; now?: number; idleMs?: number;
}): Promise<CacheCleanupEntry[]> {
  const root = path.join(options.stateDirectory, 'task-workspaces'), result: CacheCleanupEntry[] = [];
  try {
    if (await fs.realpath(root) !== path.resolve(root) || !(await fs.lstat(root)).isDirectory()) return [];
    for (const goal of await fs.readdir(root, { withFileTypes: true })) {
      if (!goal.isDirectory() || !/^[a-f0-9]{32}$/.test(goal.name)) continue;
      for (const task of await fs.readdir(path.join(root, goal.name), { withFileTypes: true })) {
        if (!task.isDirectory()) continue;
        if (!/^[a-f0-9]{32}-[a-f0-9]{8}$/.test(task.name)) {
          result.push({ path: path.join(root, goal.name, task.name), action: 'retained', reason: 'unrecognized-workspace-name', bytes: 0 }); continue;
        }
        const workspace = path.join(root, goal.name, task.name), branch = `termdock/task/${task.name}`;
        try {
          if (await fs.realpath(workspace) !== workspace || !(await fs.lstat(path.join(workspace, '.git'))).isFile()
            || await git(workspace, ['rev-parse', '--show-toplevel']) !== workspace || await git(workspace, ['branch', '--show-current']) !== branch) continue;
          // Target paths come from tracked manifests, never user-configured output paths.
          const manifests = (await git(workspace, ['ls-files', '-z', '--', 'Cargo.toml', '**/Cargo.toml'])).split('\0').filter(Boolean);
          for (const manifest of manifests) {
            const target = path.join(workspace, path.dirname(manifest), 'target');
            for (const profile of ['debug', 'release']) {
              const directory = path.join(target, profile);
              try {
                const lock = await fs.lstat(path.join(directory, '.cargo-lock'));
                if (process.platform !== 'linux') { result.push({ path: directory, action: 'retained', reason: 'cargo-lock-check-unavailable', bytes: 0 }); continue; }
                if (!lock.isFile()) continue;
                const args = { workspace, branch, target, profile: directory, lockIno: lock.ino, lockDev: lock.dev,
                  now: options.now ?? Date.now(), idleMs: options.idleMs ?? 7 * DAY, dryRun: options.dryRun === true };
                const { stdout } = await exec('flock', ['-n', '-E', '75', '--', path.join(directory, '.cargo-lock'), process.execPath,
                  '--input-type=module', '-e', CARGO_CACHE_WORKER, JSON.stringify(args)], { timeout: 120_000, maxBuffer: 256 * 1024 });
                result.push(...JSON.parse(stdout));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.push({ path: directory, action: 'retained', reason: 'cargo-locked-or-check-unavailable', bytes: 0 });
              }
            }
          }
        } catch { result.push({ path: workspace, action: 'retained', reason: 'workspace-identity-unverified', bytes: 0 }); }
      }
    }
  } catch { /* An absent or unreadable state root is never a reason to delete. */ }
  return result;
}
