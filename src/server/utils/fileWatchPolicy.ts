import path from 'path';
import fs from 'fs';

export const WATCH_IGNORED_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo', 'coverage', 'target', '.gradle', '.idea', '.DS_Store',
]);

export const WATCH_RESOURCE_BACKOFF_MS = 60_000;

export type NativeWatchEventType = 'create' | 'update' | 'delete';

export function enqueueLatestWatchEvent(
  pending: Map<string, NativeWatchEventType>,
  eventPath: string,
  eventType: NativeWatchEventType,
  maxPending: number,
): 'queued' | 'overflow' {
  if (!pending.has(eventPath) && pending.size >= maxPending) return 'overflow';
  pending.set(eventPath, eventType);
  return 'queued';
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Recursive watchers already cover every descendant. Keep only the shallowest
 * roots so expanding a folder inside an already watched folder cannot allocate
 * another overlapping native watcher.
 */
export function minimizeRecursiveWatchRoots(roots: string[]): string[] {
  const uniqueRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  uniqueRoots.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  const minimal: string[] = [];
  for (const root of uniqueRoots) {
    if (!minimal.some((parent) => isSameOrDescendant(parent, root))) minimal.push(root);
  }
  return minimal;
}

export function getWatchErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code.toUpperCase() : null;
}

export function isWatchResourceExhaustion(error: unknown): boolean {
  const code = getWatchErrorCode(error);
  if (code === 'EMFILE' || code === 'ENFILE' || code === 'ENOSPC') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:EMFILE|ENFILE|ENOSPC)\b|too many open files|inotify/i.test(message);
}

export interface InotifyUsageDiagnostics {
  maxUserInstances: number | null;
  maxUserWatches: number | null;
  observedUserInstances: number;
  observedUserWatches: number;
  topConsumers: Array<{ pid: number; command: string; instances: number; watches: number }>;
  partial: boolean;
}

export function countInotifyWatchDescriptors(fdInfo: string): number {
  return fdInfo.split('\n').filter((line) => line.startsWith('inotify wd:')).length;
}

/** Best-effort Linux-only snapshot. Call only on watcher failures, never on the hot path. */
export async function inspectLinuxInotifyUsage(): Promise<InotifyUsageDiagnostics | null> {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return null;
  const uid = process.getuid();
  let partial = false;
  let maxUserInstances: number | null = null;
  let maxUserWatches: number | null = null;
  try {
    const raw = await fs.promises.readFile('/proc/sys/fs/inotify/max_user_instances', 'utf8');
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed)) maxUserInstances = parsed;
  } catch {
    partial = true;
  }
  try {
    const raw = await fs.promises.readFile('/proc/sys/fs/inotify/max_user_watches', 'utf8');
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed)) maxUserWatches = parsed;
  } catch {
    partial = true;
  }

  let procEntries: fs.Dirent[];
  try {
    procEntries = await fs.promises.readdir('/proc', { withFileTypes: true });
  } catch {
    return { maxUserInstances, maxUserWatches, observedUserInstances: 0, observedUserWatches: 0, topConsumers: [], partial: true };
  }

  const consumers: Array<{ pid: number; command: string; instances: number; watches: number }> = [];
  for (const procEntry of procEntries) {
    if (!procEntry.isDirectory() || !/^\d+$/.test(procEntry.name)) continue;
    const pid = Number(procEntry.name);
    const procPath = `/proc/${procEntry.name}`;
    try {
      if ((await fs.promises.stat(procPath)).uid !== uid) continue;
      const fdEntries = await fs.promises.readdir(`${procPath}/fd`);
      let instances = 0;
      let watches = 0;
      for (const fd of fdEntries) {
        try {
          if ((await fs.promises.readlink(`${procPath}/fd/${fd}`)) !== 'anon_inode:inotify') continue;
          instances += 1;
          try {
            watches += countInotifyWatchDescriptors(await fs.promises.readFile(`${procPath}/fdinfo/${fd}`, 'utf8'));
          } catch {
            partial = true;
          }
        } catch {
          // Processes and descriptors can disappear while /proc is sampled.
        }
      }
      if (instances === 0) continue;
      let command = procEntry.name;
      try {
        const rawCommand = await fs.promises.readFile(`${procPath}/comm`, 'utf8');
        command = rawCommand.trim() || command;
      } catch {
        partial = true;
      }
      consumers.push({ pid, command, instances, watches });
    } catch (error) {
      const code = getWatchErrorCode(error);
      if (code !== 'ENOENT' && code !== 'ESRCH') partial = true;
    }
  }

  consumers.sort((a, b) => b.watches - a.watches || b.instances - a.instances || a.pid - b.pid);
  return {
    maxUserInstances,
    maxUserWatches,
    observedUserInstances: consumers.reduce((total, item) => total + item.instances, 0),
    observedUserWatches: consumers.reduce((total, item) => total + item.watches, 0),
    topConsumers: consumers.slice(0, 8),
    partial,
  };
}
