/**
 * Lightweight git snapshot per working directory — current branch + working
 * tree diff size — pushed to tabs/sidebar so each session shows
 * `⎇ feat/x  +6 −5`. （设计移植自 tty7 terminal/git_status.rs，Apache-2.0）
 *
 * Snapshots are shared through a process-wide cache keyed by work-tree root:
 * every pane whose cwd resolves into the same repo reads the *same* entry, so
 * ten tabs in one repo show one truth, refreshed by whichever pane probed
 * last. Probes are per-trigger (cwd change, command end, agent tool activity)
 * but deduped in-flight and throttled per root, so simultaneous triggers cost
 * one `git` shell-out, not one per pane.
 *
 * Read-only — `GIT_OPTIONAL_LOCKS=0` keeps status polling from ever taking
 * `index.lock` and fighting a real git command the user is running.
 */

import { execFile } from 'node:child_process';

export interface GitStatus {
  /** Branch name, or short sha when HEAD is detached. Never empty. */
  branch: string;
  /** Lines added across the working tree vs HEAD. */
  added: number;
  /** Lines removed across the working tree vs HEAD. */
  removed: number;
}

interface CacheEntry {
  status: GitStatus | null;
  probedAt: number;
}

/** Default minimum interval between probes of the same work-tree root. */
const DEFAULT_MIN_INTERVAL_MS = 5_000;
/** One probe (two git invocations) must finish inside this budget. */
const PROBE_TIMEOUT_MS = 5_000;

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout) => {
        if (error) return rejectPromise(error);
        resolvePromise(stdout);
      },
    );
  });
}

/**
 * Probe the git snapshot for `cwd`, or null when it isn't inside a git work
 * tree. One `rev-parse` answers the root question (and gates non-repos), then
 * branch + numstat. `counts` failure (e.g. racing a concurrent git write) is
 * distinct from a clean tree: callers keep previous numbers.
 */
export async function probeGitStatus(cwd: string): Promise<GitStatus | null> {
  try {
    const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim();
    if (!root) return null;

    let branch = (await runGit(root, ['branch', '--show-current'])).trim();
    if (!branch) {
      // Detached HEAD: short sha
      branch = (await runGit(root, ['rev-parse', '--short', 'HEAD'])).trim();
    }

    let added = 0;
    let removed = 0;
    try {
      const numstat = await runGit(root, ['diff', '--numstat', 'HEAD']);
      for (const line of numstat.split('\n')) {
        if (!line) continue;
        const parts = line.split('\t');
        // Binary files report "-\t-\tpath" and don't contribute a line count.
        const a = parseInt(parts[0], 10);
        const r = parseInt(parts[1], 10);
        if (Number.isFinite(a)) added += a;
        if (Number.isFinite(r)) removed += r;
      }
    } catch {
      // diff raced a concurrent write: report branch-only rather than a
      // fake clean tree.
    }

    return { branch, added, removed };
  } catch {
    return null;
  }
}

/**
 * Process-wide cache keyed by work-tree root, with in-flight dedupe and
 * per-root throttling. Probes run through `beginProbe`; the caller decides
 * what to do with the result (cache it, broadcast it).
 */
export class GitStatusCache {
  private entries = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<GitStatus | null>>();

  get(root: string): GitStatus | null | undefined {
    return this.entries.get(root)?.status;
  }

  /**
   * Start a probe for `cwd` unless one is already in flight for the same
   * tree or the last probe finished less than `minIntervalMs` ago. Returns
   * null when the trigger was dropped (throttled/deduped).
   */
  beginProbe(cwd: string, minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS): Promise<GitStatus | null> | null {
    const key = cwd;
    const last = this.entries.get(key);
    if (last && Date.now() - last.probedAt < minIntervalMs) return null;
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const probe = probeGitStatus(cwd)
      .then((status) => {
        this.entries.set(key, { status, probedAt: Date.now() });
        return status;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, probe);
    return probe;
  }
}

export const gitStatusCache = new GitStatusCache();
