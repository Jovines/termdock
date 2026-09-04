import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import type { Dirent } from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import busboy from 'busboy';
import { pathValidator } from '../utils/pathValidator.js';
import { isAuthEnabled, isRequestAuthenticated } from '../utils/authProtection.js';
import { getImageDimensions, parseImageDimensions } from '../utils/imageDimensions.js';
import { writeDiffTraceLog, writeErrorLog, writeJsonLog } from '../utils/serverLogger.js';
import { clearBranchAuditRecords, clearChangeAuditRecords, listBranchAuditRecords, listChangeAuditRecords, buildChangeAuditFingerprint } from '../utils/changeAuditStore.js';
import { getLanIPv4Addresses } from '../utils/localAccess.js';
import { inspectBinaryFile } from '../utils/binaryFile.js';
import { GitApplyError, HUNK_APPLY_MODES, runGitApply, validateHunkPatch, type HunkApplyMode } from '../utils/hunkApply.js';
import { deleteFilesystemFile } from '../utils/deleteFilesystemFile.js';
import { inspectKicadBoardPoint } from '../utils/kicadBoardInspection.js';
import { appendRipgrepExcludeArgs, createExcludeMatcher, normalizeExcludePatterns } from '../utils/fileSearchOptions.js';
import { EdaPreviewCache, requestAcceptsEtag } from '../utils/edaPreviewCache.js';
import { convertHeicPreview, HEIC_PREVIEW_MIME_TYPES, isHeicPreviewPath } from '../utils/heicPreview.js';
import {
  getWatchErrorCode,
  diffWatchSnapshots,
  enqueueLatestWatchEvent,
  inspectLinuxInotifyUsage,
  isWatchResourceExhaustion,
  normalizeDirectoryWatchRoots,
  resolveDirectWatchEventPath,
  WATCH_IGNORED_NAMES,
  WATCH_RESOURCE_BACKOFF_MS,
} from '../utils/fileWatchPolicy.js';
import { isResponseWritable, writeResponseChunk } from '../utils/httpResponse.js';

const router = Router();

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_IMAGE_PREVIEW_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_HTML_PREVIEW_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_VIDEO_PREVIEW_SIZE = 4 * 1024 * 1024 * 1024; // 4GB
const MAX_DOWNLOAD_SIZE = 200 * 1024 * 1024; // 200MB
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB per file
const MAX_UPLOAD_FILES = 50; // max 50 files per upload
const GIT_TIMEOUT_MS = 5000;
const GIT_UNTRACKED_TIMEOUT_MS = 800;
const GIT_BUNDLE_CACHE_TTL_MS = 60_000;
const MAX_DIRECTORY_ENTRIES = 1000;
const MAX_FALLBACK_SEARCH_VISITED = 30_000;
// Content (full-text) search caps so a broad query can't flood the stream/UI.
const MAX_CONTENT_SEARCH_FILES = 1_000;
const MAX_CONTENT_MATCHES_PER_FILE = 50;
const MAX_CONTENT_MATCH_LINE_LENGTH = 400;
const MAX_GIT_CONTEXT_CHANGED_FILES = 200;
const MAX_RECENT_COMMITS_LIMIT = 50;
const MAX_DIFF_BYTES = 1024 * 1024; // 1MB
const MAX_BRANCH_DIFF_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_BRANCH_DIFF_STAT_BYTES = 128 * 1024;
const MAX_BRANCH_DIFF_NAME_BYTES = 256 * 1024;
const MAX_BRANCH_DIFF_LOG_BYTES = 256 * 1024;
const MAX_UNTRACKED_DIFF_FILE_BYTES = 1024 * 1024; // 1MB
const MAX_NESTED_GIT_REPOS = 32;
const NESTED_GIT_DISCOVERY_TIMEOUT_MS = 1_000;
const NESTED_GIT_DISCOVERY_CACHE_TTL_MS = 60_000;
const FS_ROUTE_TIMEOUT_MS = 6_000;
const HEIC_PREVIEW_TIMEOUT_MS = 30_000;
const EDA_PREVIEW_TIMEOUT_MS = 30_000;
const EDA_PREVIEW_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const GIT_ROUTE_TIMEOUT_MS = 8_000;
const GIT_FILE_DIFF_ROUTE_TIMEOUT_MS = 45_000;
const GIT_ACTION_TIMEOUT_MS = 10 * 60_000;
const GIT_APPLY_TIMEOUT_MS = 30_000;
const RESTORE_CONFIRM_PHRASES = new Set(['丢弃改动', 'discard changes']);
const FS_IO_LOG_NAME = 'fs-io.log';
const activeDiffSlots = new Map<string, { controller: AbortController; requestId: number }>();
const activeIoSlots = new Map<string, { controller: AbortController; requestId: number; op: string }>();
// ── Shared file-watch subscriptions ──────────────────────────────────────
// The explorer only needs direct children of directories that are currently
// visible. A recursive watcher here would allocate one Linux inotify watch per
// descendant and scan the whole subtree before becoming ready. Keep one shared
// non-recursive fs.watch per visible directory instead. If the host has already
// exhausted native watcher resources, retain live refresh through a bounded,
// low-frequency snapshot poll rather than terminating the client stream.
interface SharedWatchClient {
  closed: boolean;
  enqueue: (event: FileWatchEvent) => void;
  degrade: (reason: string) => void;
}
interface SharedWatchEntry {
  refs: number;
  nativeWatcher: fs.FSWatcher | null;
  mode: 'starting' | 'native' | 'polling';
  failure: string | null;
  clients: Set<SharedWatchClient>;
  inFlight: Promise<boolean> | null;
  evictTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  pollSnapshot: Map<string, DirectorySnapshotItem> | null;
  pendingEvents: Map<string, 'create' | 'update' | 'delete'>;
  statWorkers: number;
  eventGeneration: number;
  needsRescanOnAttach: boolean;
}
interface DirectorySnapshotItem {
  signature: string;
  entry: FileSearchEntry;
}
const sharedWatchRegistry = new Map<string, SharedWatchEntry>();
const SHARED_WATCH_EVICT_DELAY_MS = 60_000;
const WATCH_STAT_CONCURRENCY = 8;
const WATCH_POLL_INTERVAL_MS = 4_000;
const MAX_NATIVE_DIRECTORY_WATCHES = 256;
let watchAdmissionBlockedUntil = 0;

function countActiveSharedWatches(): number {
  let count = 0;
  for (const entry of sharedWatchRegistry.values()) {
    if (entry.nativeWatcher) count += 1;
  }
  return count;
}

function broadcastSharedWatchEvent(entry: SharedWatchEntry, event: FileWatchEvent): void {
  for (const client of entry.clients) {
    if (!client.closed) client.enqueue(event);
  }
}

function drainSharedWatchEvents(entry: SharedWatchEntry): void {
  if (entry.failure || entry.clients.size === 0) return;
  while (entry.statWorkers < WATCH_STAT_CONCURRENCY && entry.pendingEvents.size > 0) {
    const next = entry.pendingEvents.entries().next().value as [string, 'create' | 'update' | 'delete'] | undefined;
    if (!next) return;
    const [changedPath, eventType] = next;
    entry.pendingEvents.delete(changedPath);
    if (eventType === 'delete') {
      broadcastSharedWatchEvent(entry, { type: 'deleted', path: changedPath });
      continue;
    }

    const generation = entry.eventGeneration;
    entry.statWorkers += 1;
    void fs.promises.lstat(changedPath)
      .then((stat) => {
        if (entry.failure || generation !== entry.eventGeneration) return;
        broadcastSharedWatchEvent(entry, {
          type: eventType === 'create' ? 'created' : 'updated',
          path: changedPath,
          entry: toFileEntry(changedPath, stat),
        });
      })
      .catch(() => {
        if (entry.failure || generation !== entry.eventGeneration) return;
        broadcastSharedWatchEvent(entry, { type: 'deleted', path: changedPath });
      })
      .finally(() => {
        entry.statWorkers -= 1;
        drainSharedWatchEvents(entry);
      });
  }
}

function enqueueSharedNativeEvent(rootPath: string, entry: SharedWatchEntry, filename: string | Buffer | null): void {
  if (!filename) {
    entry.pendingEvents.clear();
    entry.eventGeneration += 1;
    broadcastSharedWatchEvent(entry, { type: 'rescan-required', path: rootPath, reason: 'directory-rescan' });
    return;
  }
  const changedPath = resolveDirectWatchEventPath(rootPath, filename);
  if (!changedPath || isIgnoredWatchPath(rootPath, changedPath)) return;
  if (entry.clients.size === 0) {
    entry.needsRescanOnAttach = true;
    return;
  }
  if (enqueueLatestWatchEvent(entry.pendingEvents, changedPath, 'update', WATCH_EVENT_STORM_LIMIT) === 'overflow') {
    entry.pendingEvents.clear();
    entry.eventGeneration += 1;
    broadcastSharedWatchEvent(entry, { type: 'rescan-required', path: rootPath, reason: 'event-storm' });
    return;
  }
  drainSharedWatchEvents(entry);
}

async function readDirectorySnapshot(rootPath: string): Promise<Map<string, DirectorySnapshotItem>> {
  const dirents = await fs.promises.readdir(rootPath, { withFileTypes: true });
  const visible = dirents.filter((dirent) => !WATCH_IGNORED_NAMES.has(dirent.name));
  const snapshot = new Map<string, DirectorySnapshotItem>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(WATCH_STAT_CONCURRENCY, visible.length) }, async () => {
    while (cursor < visible.length) {
      const dirent = visible[cursor++];
      const entryPath = path.join(rootPath, dirent.name);
      try {
        const stat = await fs.promises.lstat(entryPath);
        snapshot.set(entryPath, {
          signature: `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
          entry: toFileEntry(entryPath, stat, dirent.isSymbolicLink()),
        });
      } catch (error) {
        if (getWatchErrorCode(error) !== 'ENOENT') throw error;
      }
    }
  });
  await Promise.all(workers);
  return snapshot;
}

function scheduleSharedWatchPoll(rootPath: string, entry: SharedWatchEntry, delay = WATCH_POLL_INTERVAL_MS): void {
  if (entry.pollTimer || entry.mode !== 'polling' || entry.refs === 0) return;
  entry.pollTimer = setTimeout(() => {
    entry.pollTimer = null;
    void pollSharedWatch(rootPath, entry);
  }, delay);
  entry.pollTimer.unref?.();
}

async function pollSharedWatch(rootPath: string, entry: SharedWatchEntry): Promise<void> {
  if (entry.mode !== 'polling' || entry.refs === 0) return;
  try {
    const next = await readDirectorySnapshot(rootPath);
    const previous = entry.pollSnapshot;
    entry.pollSnapshot = next;
    entry.failure = null;
    if (previous) {
      for (const change of diffWatchSnapshots(previous, next)) {
        broadcastSharedWatchEvent(entry, {
          type: change.type === 'delete' ? 'deleted' : change.type === 'create' ? 'created' : 'updated',
          path: change.path,
          entry: change.value?.entry,
        });
      }
    }
  } catch (error) {
    entry.failure = error instanceof Error ? error.message : String(error);
    if (getWatchErrorCode(error) === 'ENOENT') {
      for (const client of [...entry.clients]) if (!client.closed) client.degrade(entry.failure);
      return;
    }
    console.warn('[file-watch] Polling refresh failed; will retry', { rootPath, error: entry.failure });
  }
  scheduleSharedWatchPoll(rootPath, entry);
}

async function startPollingWatch(rootPath: string, entry: SharedWatchEntry, reason: string): Promise<boolean> {
  entry.nativeWatcher?.close();
  entry.nativeWatcher = null;
  entry.mode = 'polling';
  entry.pendingEvents.clear();
  entry.eventGeneration += 1;
  try {
    entry.pollSnapshot = await readDirectorySnapshot(rootPath);
    entry.failure = null;
  } catch (error) {
    entry.failure = error instanceof Error ? error.message : String(error);
    return false;
  }
  scheduleSharedWatchPoll(rootPath, entry);
  console.warn('[file-watch] Using polling fallback', { rootPath, intervalMs: WATCH_POLL_INTERVAL_MS, reason });
  return true;
}

async function acquireSharedWatch(rootPath: string, client: SharedWatchClient): Promise<string | null> {
  let entry = sharedWatchRegistry.get(rootPath);
  if (!entry) {
    entry = {
      refs: 0,
      nativeWatcher: null,
      mode: 'starting',
      failure: null,
      clients: new Set(),
      inFlight: null,
      evictTimer: null,
      pollTimer: null,
      pollSnapshot: null,
      pendingEvents: new Map(),
      statWorkers: 0,
      eventGeneration: 0,
      needsRescanOnAttach: false,
    };
    sharedWatchRegistry.set(rootPath, entry);
  }
  if (entry.evictTimer) {
    clearTimeout(entry.evictTimer);
    entry.evictTimer = null;
  }
  entry.refs += 1;
  entry.clients.add(client);
  if (entry.needsRescanOnAttach) {
    entry.needsRescanOnAttach = false;
    client.enqueue({ type: 'rescan-required', path: rootPath, reason: 'reconnected' });
  }
  if (entry.mode === 'polling' && entry.pollSnapshot) {
    scheduleSharedWatchPoll(rootPath, entry, 0);
    return rootPath;
  }
  if (entry.nativeWatcher) return rootPath;
  if (!entry.inFlight) {
    const now = Date.now();
    const activeSubscriptions = countActiveSharedWatches();
    entry.inFlight = (async () => {
      if (now < watchAdmissionBlockedUntil || activeSubscriptions >= MAX_NATIVE_DIRECTORY_WATCHES) {
        const reason = now < watchAdmissionBlockedUntil ? 'native watcher resource backoff' : 'native watcher process budget reached';
        return startPollingWatch(rootPath, entry!, reason);
      }
      try {
        const nativeWatcher = fs.watch(rootPath, { persistent: false }, (_eventType, filename) => {
          enqueueSharedNativeEvent(rootPath, entry!, filename);
        });
        entry!.nativeWatcher = nativeWatcher;
        entry!.mode = 'native';
        entry!.failure = null;
        nativeWatcher.on('error', (error) => {
          if (entry!.mode !== 'native') return;
          const resourceExhausted = isWatchResourceExhaustion(error);
          if (resourceExhausted) watchAdmissionBlockedUntil = Date.now() + WATCH_RESOURCE_BACKOFF_MS;
          if (resourceExhausted) void inspectLinuxInotifyUsage().then((diagnostics) => {
            if (diagnostics) console.warn('[file-watch] Linux inotify usage after watcher failure', diagnostics);
          }).catch(() => undefined);
          void startPollingWatch(rootPath, entry!, error.message || 'native watcher error').then((started) => {
            if (!started) {
              const reason = entry!.failure ?? 'watch-unavailable';
              for (const client of [...entry!.clients]) if (!client.closed) client.degrade(reason);
            }
          });
        });
        console.info('[file-watch] Native directory watch ready', {
          rootPath,
          activeSubscriptions: activeSubscriptions + 1,
          registrySize: sharedWatchRegistry.size,
        });
        return true;
      } catch (error) {
        const resourceExhausted = isWatchResourceExhaustion(error);
        if (resourceExhausted) watchAdmissionBlockedUntil = Date.now() + WATCH_RESOURCE_BACKOFF_MS;
        if (resourceExhausted) void inspectLinuxInotifyUsage().then((diagnostics) => {
          if (diagnostics) console.warn('[file-watch] Linux inotify usage after watcher admission failure', diagnostics);
        }).catch(() => undefined);
        return startPollingWatch(rootPath, entry!, error instanceof Error ? error.message : String(error));
      }
    })()
      .finally(() => {
        const current = sharedWatchRegistry.get(rootPath);
        if (current) current.inFlight = null;
      });
  }
  await entry.inFlight;
  const current = sharedWatchRegistry.get(rootPath);
  return current && !current.failure ? rootPath : null;
}

function releaseSharedWatch(rootPath: string, client: SharedWatchClient): void {
  client.closed = true;
  const entry = sharedWatchRegistry.get(rootPath);
  if (!entry) return;
  entry.clients.delete(client);
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.needsRescanOnAttach = entry.needsRescanOnAttach
    || entry.pendingEvents.size > 0
    || entry.statWorkers > 0;
  entry.pendingEvents.clear();
  entry.eventGeneration += 1;
  if (entry.pollTimer) {
    clearTimeout(entry.pollTimer);
    entry.pollTimer = null;
  }
  if (!entry.nativeWatcher && !entry.inFlight && entry.mode !== 'polling') {
    sharedWatchRegistry.delete(rootPath);
    return;
  }
  if (entry.evictTimer) clearTimeout(entry.evictTimer);
  entry.evictTimer = setTimeout(() => {
    const current = sharedWatchRegistry.get(rootPath);
    if (!current || current.refs > 0) return;
    sharedWatchRegistry.delete(rootPath);
    if (current.pollTimer) clearTimeout(current.pollTimer);
    current.nativeWatcher?.close();
    current.nativeWatcher = null;
  }, SHARED_WATCH_EVICT_DELAY_MS);
  entry.evictTimer.unref?.();
}
const untrackedJobs = new Map<string, {
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  files?: GitChangedFile[];
  error?: string;
  code?: string;
  promise?: Promise<void>;
}>();
interface GitActionJob {
  id: string;
  key: string;
  status: 'running' | 'done' | 'error';
  action: GitAction;
  cwd: string;
  gitRoot: string;
  startedAt: number;
  finishedAt?: number;
  message?: string;
  output?: string;
  error?: string;
  code?: string;
  bundle?: GitBundlePayload;
  promise?: Promise<void>;
}
const nestedGitRootsCache = new Map<string, {
  result: { repositories: DiscoveredGitRepository[]; truncated: boolean };
  expiresAt: number;
  promise?: Promise<{ repositories: DiscoveredGitRepository[]; truncated: boolean }>;
}>();
const gitActionJobs = new Map<string, GitActionJob>();
let gitActionJobSeq = 0;

type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'unknown';

type GitAction = 'stage-file' | 'stage-all' | 'unstage-file' | 'stash-file' | 'stash-all' | 'restore-worktree-file' | 'commit' | 'push' | 'pull' | 'switch-branch';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

interface GitChangedFile {
  path: string;
  absolutePath: string;
  repoRoot?: string;
  repoRelativeRoot?: string;
  repoName?: string;
  status: GitChangeStatus;
  oldPath?: string;
  indexStatus?: string;
  worktreeStatus?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  tracked: boolean;
  canStage: boolean;
  canUnstage: boolean;
  canStash: boolean;
  canRestoreWorktree: boolean;
}

interface GitBundlePayload {
  available: boolean;
  files: GitChangedFile[];
  context: {
    available: boolean;
    cwd?: string;
    root?: string;
    branch?: string | null;
    remotes?: string[];
    branches?: string[];
    remoteBranches?: string[];
    upstream?: string | null;
    upstreamRemote?: string | null;
    upstreamBranch?: string | null;
    ahead?: number | null;
    behind?: number | null;
    status?: string;
    recentCommits?: string[];
    changedFiles?: Array<{ path: string; absolutePath: string; status: string }>;
    truncated?: boolean;
    error?: string;
    code?: string;
  } | null;
  repositories?: GitRepositoryBundle[];
  repoFilters?: GitRepositoryFilter[];
  truncatedRepositories?: boolean;
  cached?: boolean;
  stale?: boolean;
  cacheAgeMs?: number;
  cacheUpdatedAt?: number;
  nestedDeferred?: boolean;
  untrackedDeferred?: boolean;
  error?: string;
  code?: string;
}

interface GitRepositoryFilter {
  root: string;
  label: string;
  branch?: string | null;
  count: number;
  staged: number;
}

interface GitRepositoryBundle {
  id: string;
  root: string;
  displayRoot?: string;
  relativeRoot: string;
  name: string;
  depth: number;
  nested: boolean;
  available: boolean;
  files: GitChangedFile[];
  context: GitBundlePayload['context'];
  untrackedDeferred?: boolean;
  error?: string;
}

interface DiscoveredGitRepository {
  root: string;
  displayRoot: string;
}

interface DiffSkippedFile {
  path: string;
  reason: string;
  size?: number;
  maxBytes?: number;
}

interface DiffResponsePayload {
  path: string | null;
  diff: string;
  error?: string;
  truncated?: boolean;
  tooLarge?: boolean;
  size?: number;
  maxBytes?: number;
  skippedFiles?: DiffSkippedFile[];
}

interface GitCommandResult {
  stdout: string;
  truncated: boolean;
}

interface ChangedFilesResult {
  files: GitChangedFile[];
  untrackedDeferred: boolean;
}

interface UntrackedFilesPayload {
  status: 'running' | 'done' | 'error';
  files: GitChangedFile[];
  error?: string;
  code?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface BranchDiffPayload {
  available: boolean;
  repoRoot?: string;
  workspaceRoot?: string;
  baseRef?: string;
  baseBranch?: string;
  currentBranch?: string | null;
  headRef?: string | null;
  diffFingerprint?: string;
  stat?: string;
  files?: string[];
  skippedFiles?: DiffSkippedFile[];
  hunks?: BranchDiffHunk[];
  commits?: string[];
  commitCount?: number;
  diff?: string;
  truncated?: boolean;
  error?: string;
}

interface BranchDiffHunk {
  filePath: string;
  oldPath?: string | null;
  newPath?: string | null;
  hunkHeader: string;
  hunkIndex: number;
  fingerprint: string;
  additions: number;
  deletions: number;
  diff: string;
  source?: 'committed' | 'uncommitted' | 'unknown';
  commit?: string | null;
}

let fsIoRequestSeq = 0;
const fsIoInflightByOp = new Map<string, number>();

class OperationTimeoutError extends Error {
  constructor(message: string, public code = 'OPERATION_TIMEOUT') {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

class GitCommandAbortError extends Error {
  constructor(message = 'git command aborted', public code = 'GIT_COMMAND_ABORTED') {
    super(message);
    this.name = 'GitCommandAbortError';
  }
}

class SupersededRequestError extends Error {
  constructor(public op: string) {
    super(`${op} request was cancelled because a newer request replaced it.`);
    this.name = 'SupersededRequestError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, code?: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new OperationTimeoutError(message, code);
      onTimeout?.();
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function getErrorPayload(error: unknown, fallback = 'Unknown error'): { error: string; code?: string } {
  if (error instanceof OperationTimeoutError) {
    return { error: error.message, code: error.code };
  }
  if (error instanceof SupersededRequestError) {
    return { error: error.message, code: 'IO_REQUEST_CANCELLED' };
  }
  if (error instanceof GitCommandAbortError) {
    return { error: error.message, code: error.code };
  }
  return { error: error instanceof Error ? error.message : fallback };
}

function truncateLogValue(value: string | undefined, maxLength = 500): string | undefined {
  if (value === undefined) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function writeFsIoLog(entry: Record<string, unknown>): void {
  writeJsonLog(FS_IO_LOG_NAME, entry);
}

function updateInflight(op: string, delta: 1 | -1): number {
  const next = Math.max(0, (fsIoInflightByOp.get(op) ?? 0) + delta);
  if (next === 0) fsIoInflightByOp.delete(op);
  else fsIoInflightByOp.set(op, next);
  return next;
}

function logFsIoEvent(entry: {
  id?: number;
  action: string;
  op: string;
  event: string;
  path?: string;
  cwd?: string;
  repoRoot?: string | null;
  requestClosed?: boolean;
  childPid?: number;
  args?: string[];
  code?: string;
  error?: string;
  extra?: Record<string, unknown>;
}): void {
  writeFsIoLog({
    id: entry.id,
    action: entry.action,
    op: entry.op,
    event: entry.event,
    path: truncateLogValue(entry.path),
    cwd: truncateLogValue(entry.cwd),
    repoRoot: truncateLogValue(entry.repoRoot ?? undefined),
    requestClosed: entry.requestClosed,
    childPid: entry.childPid,
    args: entry.args,
    code: entry.code,
    error: truncateLogValue(entry.error),
    inflight: Object.fromEntries(fsIoInflightByOp.entries()),
    ...entry.extra,
  });
  if (entry.code || entry.error || entry.event.includes('abort') || entry.event.includes('timeout')) {
    writeErrorLog({
      source: 'fs-io',
      id: entry.id,
      action: entry.action,
      op: entry.op,
      event: entry.event,
      path: truncateLogValue(entry.path),
      cwd: truncateLogValue(entry.cwd),
      repoRoot: truncateLogValue(entry.repoRoot ?? undefined),
      requestClosed: entry.requestClosed,
      childPid: entry.childPid,
      args: entry.args,
      code: entry.code,
      error: truncateLogValue(entry.error),
      ...entry.extra,
    });
  }
}

function logFsIo(entry: {
  id?: number;
  action: string;
  op: string;
  startedAt: number;
  status: 'ok' | 'error';
  path?: string;
  cwd?: string;
  repoRoot?: string | null;
  code?: string;
  error?: string;
  count?: number;
  total?: number;
  bytes?: number;
  truncated?: boolean;
  extra?: Record<string, unknown>;
}): void {
  const extra = entry.extra ?? {};
  writeFsIoLog({
    id: entry.id,
    action: entry.action,
    op: entry.op,
    status: entry.status,
    durationMs: Date.now() - entry.startedAt,
    path: truncateLogValue(entry.path),
    cwd: truncateLogValue(entry.cwd),
    repoRoot: truncateLogValue(entry.repoRoot ?? undefined),
    code: entry.code,
    error: truncateLogValue(entry.error),
    count: entry.count,
    total: entry.total,
    bytes: entry.bytes,
    truncated: entry.truncated,
    ...extra,
  });
  if (entry.status === 'error' || entry.code || entry.error) {
    writeErrorLog({
      source: 'fs-io',
      id: entry.id,
      action: entry.action,
      op: entry.op,
      status: entry.status,
      durationMs: Date.now() - entry.startedAt,
      path: truncateLogValue(entry.path),
      cwd: truncateLogValue(entry.cwd),
      repoRoot: truncateLogValue(entry.repoRoot ?? undefined),
      code: entry.code,
      error: truncateLogValue(entry.error),
      ...extra,
    });
  }
}

function registerIoSlot(options: {
  requestId: number;
  op: string;
  action: string;
  slotId: string | undefined;
  controller: AbortController;
  path?: string;
  cwd?: string;
  repoRoot?: string | null;
  extra?: Record<string, unknown>;
}): void {
  if (!options.slotId) return;
  const previous = activeIoSlots.get(options.slotId);
  if (previous && previous.requestId !== options.requestId) {
    previous.controller.abort(new SupersededRequestError(previous.op));
    logFsIoEvent({
      id: options.requestId,
      action: options.action,
      op: options.op,
      event: 'slot-cancel-previous',
      path: options.path,
      cwd: options.cwd,
      repoRoot: options.repoRoot,
      extra: {
        requestSlotId: options.slotId,
        previousRequestId: previous.requestId,
        previousOp: previous.op,
        ...options.extra,
      },
    });
  }
  activeIoSlots.set(options.slotId, { controller: options.controller, requestId: options.requestId, op: options.op });
}

function releaseIoSlot(slotId: string | undefined, requestId: number): void {
  if (!slotId) return;
  if (activeIoSlots.get(slotId)?.requestId === requestId) {
    activeIoSlots.delete(slotId);
  }
}

function throwIfAborted(signal: AbortSignal, op: string): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new SupersededRequestError(op);
}

function getRequestAction(req: Request, fallback: string): string {
  const raw = req.query.action;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || !/^[a-z][a-z0-9_:-]{0,80}$/.test(value)) return fallback;
  return value;
}

type GitDiffAlgorithm = 'default' | 'myers' | 'minimal' | 'patience' | 'histogram';
type GitDiffWhitespaceMode = 'default' | 'trim' | 'ignore' | 'ignore-blank-lines';
// 'all' maps to a very large -U value so the whole file becomes visible.
type GitDiffContextLines = 'default' | 'all' | number;

function getGitDiffAlgorithm(value: unknown): GitDiffAlgorithm {
  return value === 'myers' || value === 'minimal' || value === 'patience' || value === 'histogram'
    ? value
    : 'default';
}

function getGitDiffWhitespaceMode(value: unknown): GitDiffWhitespaceMode {
  return value === 'trim' || value === 'ignore' || value === 'ignore-blank-lines'
    ? value
    : 'default';
}

function getGitDiffContextLines(value: unknown): GitDiffContextLines {
  if (value === 'all') return 'all';
  if (typeof value === 'string' && /^\d{1,3}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 999) return parsed;
  }
  return 'default';
}

function buildGitDiffOptionArgs(options: { algorithm: GitDiffAlgorithm; whitespace: GitDiffWhitespaceMode; context: GitDiffContextLines }): string[] {
  const args: string[] = [];
  if (options.algorithm !== 'default') args.push(`--diff-algorithm=${options.algorithm}`);
  if (options.whitespace === 'trim') args.push('--ignore-space-at-eol');
  if (options.whitespace === 'ignore') args.push('--ignore-all-space');
  if (options.whitespace === 'ignore-blank-lines') args.push('--ignore-blank-lines');
  if (options.context === 'all') args.push('--unified=100000');
  else if (typeof options.context === 'number') args.push(`--unified=${options.context}`);
  return args;
}

interface FileSearchEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  isSymlink?: boolean;
  modified?: string;
}

interface FileSearchPayload {
  path: string;
  query: string;
  entries: FileSearchEntry[];
  truncated: boolean;
  total: number;
  engine: 'rg' | 'fallback';
  limited?: boolean;
}

interface ContentMatchLine {
  line: number;
  text: string;
}

interface ContentSearchEntry {
  name: string;
  path: string;
  matches: ContentMatchLine[];
}

interface FileWatchEvent {
  type: 'created' | 'deleted' | 'updated' | 'rescan-required';
  path: string;
  entry?: FileSearchEntry;
  reason?: string;
}

function compareDirents(a: Dirent, b: Dirent): number {
  if (a.isDirectory() && !b.isDirectory()) return -1;
  if (!a.isDirectory() && b.isDirectory()) return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

const NESTED_GIT_DISCOVERY_IGNORED_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo', 'coverage', 'target', '.gradle', '.idea', '.DS_Store',
  '.cache', '.parcel-cache', '.yarn', '.pnpm-store', 'vendor',
]);
const WATCH_BATCH_MS = 120;
const WATCH_EVENT_STORM_LIMIT = 1200;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  ...HEIC_PREVIEW_MIME_TYPES,
};

function getImageMimeType(filePath: string): string | null {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

// Video files play in the right sidebar through the /video route, which
// streams with HTTP Range support so the browser <video> element can seek
// without loading the whole file into memory. Keep the map to formats the
// browser can actually decode (mkv/avi intentionally excluded).
const VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
};

function getVideoMimeType(filePath: string): string | null {
  return VIDEO_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

type VideoRangeResult =
  | { kind: 'full' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

// Single-range `Range: bytes=start-end` / `bytes=-N` parsing. Malformed or
// multi-range headers fall back to a full 200 response, which browsers accept
// (they just cannot seek until the file is buffered).
function parseVideoRange(rangeHeader: string | undefined, total: number): VideoRangeResult {
  if (!rangeHeader || total <= 0) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { kind: 'full' };
  const rawStart = match[1];
  const rawEnd = match[2];
  if (rawStart === '' && rawEnd === '') return { kind: 'full' };
  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, total - suffixLength), end: total - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0 || start >= total) return { kind: 'unsatisfiable' };
  const end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
  if (!Number.isInteger(end) || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}

// MIME types for the right-sidebar HTML preview route. The route mirrors the
// absolute filesystem path in the URL, so every relative resource referenced
// by a previewed document (css/js/fonts/images/...) is served by the same
// route with a type the browser can render.
const HTML_PREVIEW_MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function getHtmlPreviewMimeType(filePath: string): string | null {
  return HTML_PREVIEW_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

function toContentDispositionFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_');
}

function toRfc5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildContentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const fallback = toContentDispositionFilename(filename) || 'download';
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${toRfc5987ValueChars(filename)}`;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function isWorkspaceGitRepositoryRoot(workspaceRoot: string, repoRoot: string, signal?: AbortSignal): Promise<boolean> {
  if (isPathInside(workspaceRoot, repoRoot)) return true;
  const { repositories } = await getCachedNestedGitRoots(workspaceRoot, { refresh: false, signal });
  return repositories.some((repo) => repo.root === repoRoot && isPathInside(workspaceRoot, repo.displayRoot));
}

async function toGitPathspec(gitRoot: string, requestedPath: string): Promise<string> {
  const absoluteCandidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(gitRoot, requestedPath);

  let candidate = absoluteCandidate;
  try {
    candidate = await pathValidator.validatePathAsync(absoluteCandidate);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('does not exist')) {
      throw error;
    }
  }

  if (!isPathInside(gitRoot, candidate)) {
    throw new Error('Path is outside git repository');
  }

  return path.relative(gitRoot, candidate).split(path.sep).join('/');
}

function getDiffByteLength(diff: string): number {
  return Buffer.byteLength(diff, 'utf8');
}

function truncateDiffIfNeeded(payload: DiffResponsePayload): DiffResponsePayload {
  const size = getDiffByteLength(payload.diff);
  if (size <= MAX_DIFF_BYTES) {
    return { ...payload, size };
  }
  return {
    ...payload,
    diff: '',
    size,
    maxBytes: MAX_DIFF_BYTES,
    truncated: true,
    tooLarge: true,
  };
}

async function getRelativeFileSize(gitRoot: string, filePath: string): Promise<number | null> {
  try {
    const absolutePath = path.resolve(gitRoot, filePath);
    if (!isPathInside(gitRoot, absolutePath)) return null;
    const stat = await fs.promises.stat(absolutePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function makeSkippedUntracked(pathspec: string, size: number | null): DiffSkippedFile {
  return {
    path: pathspec,
    reason: 'untracked-file-too-large',
    size: size ?? undefined,
    maxBytes: MAX_UNTRACKED_DIFF_FILE_BYTES,
  };
}

function makeSkippedBinary(pathspec: string, size: number): DiffSkippedFile {
  return {
    path: pathspec,
    reason: 'binary-file',
    size,
  };
}

async function appendUntrackedDiffs(
  gitRoot: string,
  baseDiff: string,
  signal: AbortSignal,
  options: { maxBytes: number; perFileMaxBytes: number },
): Promise<{ diff: string; files: string[]; skippedFiles: DiffSkippedFile[]; truncated: boolean }> {
  const output = await execGit(['ls-files', '--others', '--exclude-standard', '-z'], gitRoot, signal).catch(emptyOnNonAbortGitError);
  const files = output.split('\0').filter(Boolean);
  const skippedFiles: DiffSkippedFile[] = [];
  let diff = baseDiff;
  let truncated = false;
  for (const filePath of files) {
    const size = await getRelativeFileSize(gitRoot, filePath);
    if (size !== null && size > options.perFileMaxBytes) {
      skippedFiles.push(makeSkippedUntracked(filePath, size));
      truncated = true;
      continue;
    }
    const partial = await execGitLimited(['diff', '--no-index', '--', '/dev/null', filePath], gitRoot, options.perFileMaxBytes, true, signal)
      .then((result) => {
        if (result.truncated) truncated = true;
        return result.stdout;
      })
      .catch(emptyOnNonAbortGitError);
    if (!partial) continue;
    const nextDiff = diff ? `${diff}\n${partial}` : partial;
    if (getDiffByteLength(nextDiff) > options.maxBytes) {
      skippedFiles.push({ path: filePath, reason: 'diff-byte-limit-exceeded', size: getDiffByteLength(partial), maxBytes: options.maxBytes });
      truncated = true;
      continue;
    }
    diff = nextDiff;
  }
  return { diff, files, skippedFiles, truncated };
}

function normalizeNameStatus(status: string): GitChangeStatus {
  if (status.startsWith('R')) return 'renamed';
  if (status.startsWith('C')) return 'copied';
  if (status.startsWith('A')) return 'added';
  if (status.startsWith('D')) return 'deleted';
  if (status.startsWith('U')) return 'conflicted';
  if (status.includes('U')) return 'conflicted';
  if (status.startsWith('?')) return 'untracked';
  if (status.startsWith('M') || status.startsWith('T')) return 'modified';
  return 'modified';
}

function combineChangeStatus(file: GitChangedFile): GitChangeStatus {
  const statuses = [file.indexStatus, file.worktreeStatus].filter(Boolean) as string[];
  if (statuses.some((status) => normalizeNameStatus(status) === 'conflicted')) return 'conflicted';
  if (file.untracked) return 'untracked';
  if (statuses.some((status) => status.startsWith('R'))) return 'renamed';
  if (statuses.some((status) => status.startsWith('C'))) return 'copied';
  if (statuses.some((status) => status.startsWith('D'))) return 'deleted';
  if (statuses.some((status) => status.startsWith('A'))) return 'added';
  if (statuses.some((status) => status.startsWith('M') || status.startsWith('T'))) return 'modified';
  return file.status === 'unknown' ? 'modified' : file.status;
}

function emptyChangedFile(gitRoot: string, filePath: string): GitChangedFile {
  return {
    path: filePath,
    absolutePath: path.join(gitRoot, filePath),
    repoRoot: gitRoot,
    status: 'unknown',
    staged: false,
    unstaged: false,
    untracked: false,
    tracked: true,
    canStage: false,
    canUnstage: false,
    canStash: false,
    canRestoreWorktree: false,
  };
}

function mergeNameStatus(
  files: Map<string, GitChangedFile>,
  gitRoot: string,
  output: string,
  source: 'staged' | 'unstaged',
) {
  const tokens = output.split('\0').filter(Boolean);
  for (let i = 0; i < tokens.length;) {
    const rawStatus = tokens[i++];
    if (!rawStatus) break;

    let oldPath: string | undefined;
    let filePath: string | undefined;
    if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
      oldPath = tokens[i++];
      filePath = tokens[i++];
    } else {
      filePath = tokens[i++];
    }
    if (!filePath) continue;

    const current = files.get(filePath) ?? emptyChangedFile(gitRoot, filePath);
    current.status = normalizeNameStatus(rawStatus);
    if (oldPath) current.oldPath = oldPath;
    if (source === 'staged') {
      current.staged = true;
      current.indexStatus = rawStatus;
    } else {
      current.unstaged = true;
      current.worktreeStatus = rawStatus;
    }
    current.tracked = true;
    files.set(filePath, current);
  }
}

function finalizeChangedFiles(files: Map<string, GitChangedFile>): GitChangedFile[] {
  return Array.from(files.values())
    .map((file) => ({
      ...file,
      status: combineChangeStatus(file),
      canStage: file.unstaged || file.untracked,
      canUnstage: file.staged,
      canStash: file.unstaged || file.untracked,
      canRestoreWorktree: file.tracked && file.unstaged && !file.untracked,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function countStagedFiles(files: GitChangedFile[]): number {
  return files.reduce((count, file) => count + (file.staged ? 1 : 0), 0);
}

async function getChangedFiles(gitRoot: string, signal?: AbortSignal, options: { includeUntracked?: boolean; untrackedTimeoutMs?: number; gitTimeoutMs?: number | null } = {}): Promise<ChangedFilesResult> {
  const includeUntracked = options.includeUntracked !== false;
  const [stagedOutput, unstagedOutput, untrackedResult] = await Promise.all([
    execGit(['diff', '--cached', '--name-status', '-M', '-z'], gitRoot, signal, options.gitTimeoutMs).catch(emptyOnNonAbortGitError),
    execGit(['diff', '--name-status', '-M', '-z'], gitRoot, signal, options.gitTimeoutMs).catch(emptyOnNonAbortGitError),
    includeUntracked
      ? execGit(['ls-files', '--others', '--exclude-standard', '-z'], gitRoot, signal, options.untrackedTimeoutMs ?? GIT_UNTRACKED_TIMEOUT_MS)
        .then((output) => ({ output, deferred: false }))
        .catch((error) => {
          if (error instanceof GitCommandAbortError || error instanceof OperationTimeoutError || error instanceof SupersededRequestError) {
            throw error;
          }
          return { output: '', deferred: true };
        })
      : Promise.resolve({ output: '', deferred: false }),
  ]);

  const files = new Map<string, GitChangedFile>();
  mergeNameStatus(files, gitRoot, stagedOutput, 'staged');
  mergeNameStatus(files, gitRoot, unstagedOutput, 'unstaged');

  for (const p of untrackedResult.output.split('\0').filter(Boolean)) {
    const current = files.get(p) ?? emptyChangedFile(gitRoot, p);
    current.status = 'untracked';
    current.untracked = true;
    current.unstaged = true;
    current.tracked = false;
    files.set(p, current);
  }

  return { files: finalizeChangedFiles(files), untrackedDeferred: includeUntracked ? untrackedResult.deferred : true };
}

function toContextFiles(files: GitChangedFile[]) {
  return files
    .slice(0, MAX_GIT_CONTEXT_CHANGED_FILES)
    .map((file) => ({ path: file.path, absolutePath: file.absolutePath, status: file.status }));
}

function uniqueSortedLines(output: string): string[] {
  return Array.from(new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )).sort((a, b) => a.localeCompare(b));
}

function splitUpstream(upstream: string | null, remotes: string[]): { remote: string | null; branch: string | null } {
  if (!upstream) return { remote: null, branch: null };
  const remote = remotes
    .filter((candidate) => upstream === candidate || upstream.startsWith(`${candidate}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!remote || upstream === remote) return { remote: null, branch: null };
  return { remote, branch: upstream.slice(remote.length + 1) || null };
}

function parseAheadBehind(output: string, hasUpstream: boolean): { ahead: number | null; behind: number | null } {
  if (!hasUpstream) return { ahead: null, behind: null };
  const [behindRaw, aheadRaw] = output.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? '', 10);
  const ahead = Number.parseInt(aheadRaw ?? '', 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

function emptyOnNonAbortGitError(error: unknown): string {
  if (error instanceof GitCommandAbortError || error instanceof OperationTimeoutError || error instanceof SupersededRequestError) {
    throw error;
  }
  return '';
}

function normalizeGitTimeoutError(error: unknown, message: string, code: string): unknown {
  if (error instanceof Error && error.message === 'git command timed out') {
    return new OperationTimeoutError(message, code);
  }
  return error;
}

function buildUntrackedFiles(gitRoot: string, output: string, nestedDisplayRoots: Set<string> = new Set()): GitChangedFile[] {
  return finalizeChangedFiles(new Map(output.split('\0').filter(Boolean).map((p) => {
    const file = emptyChangedFile(gitRoot, p);
    file.status = 'untracked';
    file.untracked = true;
    file.unstaged = true;
    file.tracked = false;
    return [p, file] as const;
  }).filter(([, file]) => !isNestedRepoPlaceholderFile(file, nestedDisplayRoots))));
}

function startUntrackedJob(gitRoot: string, nestedDisplayRoots: Set<string> = new Set()): UntrackedFilesPayload {
  const cacheKey = nestedDisplayRoots.size > 0
    ? `${gitRoot}\0${Array.from(nestedDisplayRoots).sort().join('\0')}`
    : gitRoot;
  const current = untrackedJobs.get(cacheKey);
  if (current?.status === 'running') {
    return { status: 'running', files: [], startedAt: current.startedAt };
  }
  if (current?.status === 'done' && current.finishedAt && Date.now() - current.finishedAt < GIT_BUNDLE_CACHE_TTL_MS) {
    return { status: 'done', files: current.files ?? [], startedAt: current.startedAt, finishedAt: current.finishedAt };
  }
  if (current?.status === 'error' && current.finishedAt && Date.now() - current.finishedAt < GIT_BUNDLE_CACHE_TTL_MS) {
    return {
      status: 'error',
      files: [],
      error: current.error,
      code: current.code,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
    };
  }

  const startedAt = Date.now();
  const job: NonNullable<ReturnType<typeof untrackedJobs.get>> = {
    status: 'running',
    startedAt,
  };
  const promise = execGit(['ls-files', '--others', '--exclude-standard', '-z'], gitRoot, undefined, null)
    .then((output) => {
      job.status = 'done';
      job.files = buildUntrackedFiles(gitRoot, output, nestedDisplayRoots);
      updateGitBundleCachesWithUntracked(gitRoot, job.files);
      job.finishedAt = Date.now();
    })
    .catch((error) => {
      const payload = getErrorPayload(normalizeGitTimeoutError(
        error,
        'Untracked file scan took too long. The scan is still separate from the main Git refresh; try again later.',
        'GIT_UNTRACKED_TIMEOUT',
      ));
      job.status = 'error';
      job.error = payload.error;
      job.code = payload.code;
      job.files = [];
      job.finishedAt = Date.now();
  });
  job.promise = promise;
  untrackedJobs.set(cacheKey, job);
  void promise;
  return { status: 'running', files: [], startedAt };
}

async function getGitPushTargets(gitRoot: string, signal?: AbortSignal) {
  const [remotesOutput, branchesOutput, remoteBranchesOutput, upstreamOutput, aheadBehindOutput] = await Promise.all([
    execGit(['remote'], gitRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], gitRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], gitRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], gitRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['rev-list', '--left-right', '--count', '@{u}...HEAD'], gitRoot, signal).catch(emptyOnNonAbortGitError),
  ]);
  const remotes = uniqueSortedLines(remotesOutput);
  const branches = uniqueSortedLines(branchesOutput);
  const remoteBranches = uniqueSortedLines(remoteBranchesOutput)
    .filter((branch) => !branch.endsWith('/HEAD'));
  const upstream = upstreamOutput.trim() || null;
  const { remote: upstreamRemote, branch: upstreamBranch } = splitUpstream(upstream, remotes);
  const { ahead, behind } = parseAheadBehind(aheadBehindOutput, Boolean(upstream));
  return { remotes, branches, remoteBranches, upstream, upstreamRemote, upstreamBranch, ahead, behind };
}

function getRepoRelativeRoot(workspaceRoot: string, repoRoot: string, displayRoot: string = repoRoot): string {
  const relative = path.relative(workspaceRoot, displayRoot).split(path.sep).join('/');
  return relative || '.';
}

function getRepoDepth(workspaceRoot: string, repoRoot: string, displayRoot: string = repoRoot): number {
  const relative = path.relative(workspaceRoot, displayRoot);
  if (!relative) return 0;
  return relative.split(path.sep).filter(Boolean).length;
}

function annotateRepoFiles(files: GitChangedFile[], workspaceRoot: string, repoRoot: string, displayRoot: string = repoRoot): GitChangedFile[] {
  const relativeRoot = getRepoRelativeRoot(workspaceRoot, repoRoot, displayRoot);
  const repoName = relativeRoot === '.' ? path.basename(displayRoot) || displayRoot : relativeRoot;
  return files.map((file) => ({
    ...file,
    repoRoot,
    repoRelativeRoot: relativeRoot,
    repoName,
    absolutePath: path.join(repoRoot, file.path),
  }));
}

function isNestedRepoPlaceholderFile(file: GitChangedFile, nestedDisplayRoots: Set<string>): boolean {
  if (!file.untracked || file.tracked) return false;
  const normalizedPath = file.path.replace(/\/+$/, '');
  return nestedDisplayRoots.has(normalizedPath);
}

function buildNestedRepoDisplayRootSet(workspaceRoot: string, repositories: DiscoveredGitRepository[]): Set<string> {
  return new Set(repositories.map((repo) => (
    path.relative(workspaceRoot, repo.displayRoot).split(path.sep).join('/').replace(/\/+$/, '')
  )));
}

async function buildGitBundle(resolvedCwd: string, gitRoot: string, signal?: AbortSignal, options: { gitTimeoutMs?: number | null } = {}): Promise<GitBundlePayload> {
  const [branchOutput, changedResult] = await Promise.all([
    execGit(['branch', '--show-current'], gitRoot, signal, options.gitTimeoutMs).catch(emptyOnNonAbortGitError),
    getChangedFiles(gitRoot, signal, { includeUntracked: true, gitTimeoutMs: options.gitTimeoutMs }),
  ]);
  const files = changedResult.files;
  const annotatedFiles = annotateRepoFiles(files, gitRoot, gitRoot);
  const changedFiles = toContextFiles(annotatedFiles);

  return {
    available: true,
    files: annotatedFiles,
    context: {
      available: true,
      cwd: resolvedCwd,
      root: gitRoot,
      branch: branchOutput.trim() || null,
      remotes: [],
      branches: [],
      upstream: null,
      upstreamRemote: null,
      upstreamBranch: null,
      ahead: null,
      behind: null,
      status: '',
      changedFiles,
      truncated: changedFiles.length >= MAX_GIT_CONTEXT_CHANGED_FILES,
    },
    untrackedDeferred: changedResult.untrackedDeferred,
  };
}

async function buildGitRepositoryBundle(workspaceRoot: string, resolvedCwd: string, repoRoot: string, displayRoot: string = repoRoot, signal?: AbortSignal, options: { gitTimeoutMs?: number | null } = {}): Promise<GitRepositoryBundle> {
  try {
    if (signal) throwIfAborted(signal, 'git.bundle');
    const bundle = await buildGitBundle(repoRoot === workspaceRoot ? resolvedCwd : repoRoot, repoRoot, signal, options);
    if (signal) throwIfAborted(signal, 'git.bundle');
    const relativeRoot = getRepoRelativeRoot(workspaceRoot, repoRoot, displayRoot);
    const files = annotateRepoFiles(bundle.files, workspaceRoot, repoRoot, displayRoot);
    const changedFiles = toContextFiles(files);
    return {
      id: repoRoot,
      root: repoRoot,
      displayRoot,
      relativeRoot,
      name: relativeRoot === '.' ? path.basename(displayRoot) || displayRoot : relativeRoot,
      depth: getRepoDepth(workspaceRoot, repoRoot, displayRoot),
      nested: repoRoot !== workspaceRoot,
      available: true,
      files,
      context: bundle.context ? {
        ...bundle.context,
        cwd: repoRoot === workspaceRoot ? resolvedCwd : repoRoot,
        root: repoRoot,
        changedFiles,
        truncated: changedFiles.length >= MAX_GIT_CONTEXT_CHANGED_FILES,
      } : null,
      untrackedDeferred: bundle.untrackedDeferred,
    };
  } catch (error) {
    if (error instanceof GitCommandAbortError || error instanceof OperationTimeoutError || error instanceof SupersededRequestError) {
      throw error;
    }
    const relativeRoot = getRepoRelativeRoot(workspaceRoot, repoRoot, displayRoot);
    return {
      id: repoRoot,
      root: repoRoot,
      displayRoot,
      relativeRoot,
      name: relativeRoot === '.' ? path.basename(displayRoot) || displayRoot : relativeRoot,
      depth: getRepoDepth(workspaceRoot, repoRoot, displayRoot),
      nested: repoRoot !== workspaceRoot,
      available: false,
      files: [],
      context: { available: false, cwd: repoRoot, root: repoRoot, error: error instanceof Error ? error.message : 'Unknown error' },
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function buildGitRepositoryFilters(workspaceRoot: string, repositories: GitRepositoryBundle[]): GitRepositoryFilter[] {
  return repositories
    .map((repo) => ({
      root: repo.root,
      label: repo.relativeRoot === '.' ? path.basename(workspaceRoot) || workspaceRoot : (repo.relativeRoot || repo.name || path.basename(repo.root) || repo.root),
      branch: repo.context?.branch ?? null,
      count: repo.files.length,
      staged: countStagedFiles(repo.files),
    }))
    .sort((a, b) => {
      const rootLabel = path.basename(workspaceRoot) || workspaceRoot;
      if (a.label === rootLabel) return -1;
      if (b.label === rootLabel) return 1;
      return a.label.localeCompare(b.label);
    });
}

function mergeChangedFilesByPath(current: GitChangedFile[], incoming: GitChangedFile[]): GitChangedFile[] {
  const files = new Map<string, GitChangedFile>();
  for (const file of current) files.set(file.path, file);
  for (const file of incoming) files.set(file.path, file);
  return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function updateGitBundleCachesWithUntracked(repoRoot: string, files: GitChangedFile[]): void {
  if (files.length === 0) return;
  for (const [cacheKey, cached] of gitBundleCache.entries()) {
    const bundle = cached.bundle;
    const repositories = bundle.repositories;
    if (repositories?.length) {
      let changed = false;
      const nextRepositories = repositories.map((repo) => {
        if (repo.root !== repoRoot) return repo;
        const annotatedFiles = annotateRepoFiles(files, repo.root, repo.root, repo.displayRoot ?? repo.root);
        const mergedFiles = mergeChangedFilesByPath(repo.files, annotatedFiles);
        changed = true;
        return {
          ...repo,
          files: mergedFiles,
          context: repo.context ? {
            ...repo.context,
            changedFiles: toContextFiles(mergedFiles),
            truncated: mergedFiles.length >= MAX_GIT_CONTEXT_CHANGED_FILES,
          } : repo.context,
          untrackedDeferred: false,
        };
      });
      if (!changed) continue;
      const primary = nextRepositories[0];
      const nextBundle: GitBundlePayload = {
        ...bundle,
        files: nextRepositories.flatMap((repo) => repo.files),
        context: primary?.context ?? bundle.context,
        repositories: nextRepositories,
        repoFilters: buildGitRepositoryFilters(primary?.root ?? repoRoot, nextRepositories),
        untrackedDeferred: nextRepositories.some((repo) => repo.untrackedDeferred),
      };
      gitBundleCache.set(cacheKey, { bundle: nextBundle, expiresAt: cached.expiresAt, updatedAt: cached.updatedAt });
      continue;
    }

    if (bundle.context?.root !== repoRoot) continue;
    const mergedFiles = mergeChangedFilesByPath(bundle.files, files);
    const nextContext = bundle.context ? {
      ...bundle.context,
      changedFiles: toContextFiles(mergedFiles),
      truncated: mergedFiles.length >= MAX_GIT_CONTEXT_CHANGED_FILES,
    } : bundle.context;
    const nextBundle: GitBundlePayload = {
      ...bundle,
      files: mergedFiles,
      context: nextContext,
      untrackedDeferred: false,
    };
    gitBundleCache.set(cacheKey, { bundle: nextBundle, expiresAt: cached.expiresAt, updatedAt: cached.updatedAt });
  }
}

async function buildWorkspaceGitBundle(resolvedCwd: string, gitRoot: string, includeNested: boolean, signal?: AbortSignal, options: { gitTimeoutMs?: number | null } = {}): Promise<GitBundlePayload> {
  if (!includeNested) {
    if (signal) throwIfAborted(signal, 'git.bundle');
    const bundle = await buildGitBundle(resolvedCwd, gitRoot, signal, options);
    const repository: GitRepositoryBundle = {
      id: gitRoot,
      root: gitRoot,
      displayRoot: gitRoot,
      relativeRoot: '.',
      name: path.basename(gitRoot) || gitRoot,
      depth: 0,
      nested: false,
      available: bundle.available,
      files: bundle.files,
      context: bundle.context,
      error: bundle.error,
    };
    return {
      ...bundle,
      repositories: [repository],
      repoFilters: buildGitRepositoryFilters(gitRoot, [repository]),
      untrackedDeferred: bundle.untrackedDeferred,
    };
  }

  if (signal) throwIfAborted(signal, 'git.bundle');
  const { repositories: nestedRepositories, truncated } = await getCachedNestedGitRoots(gitRoot, { refresh: true, signal });
  if (signal) throwIfAborted(signal, 'git.bundle');
  const nestedDisplayRoots = buildNestedRepoDisplayRootSet(gitRoot, nestedRepositories);
  const repositories = await Promise.all([
    buildGitRepositoryBundle(gitRoot, resolvedCwd, gitRoot, gitRoot, signal, options),
    ...nestedRepositories.map((repo) => buildGitRepositoryBundle(gitRoot, resolvedCwd, repo.root, repo.displayRoot, signal, options)),
  ]);
  if (signal) throwIfAborted(signal, 'git.bundle');
  const primary = repositories[0];
  if (primary) {
    primary.files = primary.files.filter((file) => !isNestedRepoPlaceholderFile(file, nestedDisplayRoots));
    if (primary.context) {
      const changedFiles = toContextFiles(primary.files);
      primary.context = {
        ...primary.context,
        changedFiles,
        truncated: changedFiles.length >= MAX_GIT_CONTEXT_CHANGED_FILES,
      };
    }
  }
  return {
    available: true,
    files: repositories.flatMap((repo) => repo.files),
    context: primary.context,
    repositories,
    repoFilters: buildGitRepositoryFilters(gitRoot, repositories),
    truncatedRepositories: truncated,
    untrackedDeferred: repositories.some((repo) => repo.untrackedDeferred),
  };
}

async function getCachedGitBundle(resolvedCwd: string, gitRoot: string, includeNested: boolean, refresh: boolean, allowStale = false, signal?: AbortSignal): Promise<GitBundlePayload> {
  const cacheKey = getGitBundleCacheKey(gitRoot, includeNested);
  const now = Date.now();
  if (signal) throwIfAborted(signal, 'git.bundle');
  const cached = gitBundleCache.get(cacheKey);
  if (!refresh && cached && (cached.expiresAt > now || allowStale)) {
    const cacheAgeMs = Math.max(0, now - (cached.expiresAt - GIT_BUNDLE_CACHE_TTL_MS));
    return {
      ...cached.bundle,
      cached: true,
      stale: cached.expiresAt <= now,
      cacheAgeMs,
      cacheUpdatedAt: cached.updatedAt,
    };
  }

  const canReusePending = !refresh && !signal;
  const pending = canReusePending ? gitBundleBuildPromises.get(cacheKey) : null;
  if (pending) {
    const bundle = await pending;
    return { ...bundle, cached: true, stale: false, cacheAgeMs: 0 };
  }

  const promise = buildWorkspaceGitBundle(resolvedCwd, gitRoot, includeNested, signal)
    .then((bundle) => {
      const updatedAt = Date.now();
      gitBundleCache.set(cacheKey, { bundle, expiresAt: updatedAt + GIT_BUNDLE_CACHE_TTL_MS, updatedAt });
      return { ...bundle, cacheUpdatedAt: updatedAt };
    })
    .finally(() => {
      if (gitBundleBuildPromises.get(cacheKey) === promise) gitBundleBuildPromises.delete(cacheKey);
    });
  if (canReusePending) gitBundleBuildPromises.set(cacheKey, promise);
  return promise;
}

async function refreshGitBundleCacheDetached(resolvedCwd: string, gitRoot: string, includeNested: boolean, options: { gitTimeoutMs?: number | null } = {}): Promise<GitBundlePayload> {
  const cacheKey = getGitBundleCacheKey(gitRoot, includeNested);
  const pending = gitBundleBuildPromises.get(cacheKey);
  if (pending) return pending;
  const promise = buildWorkspaceGitBundle(resolvedCwd, gitRoot, includeNested, undefined, options)
    .then((bundle) => {
      const updatedAt = Date.now();
      gitBundleCache.set(cacheKey, { bundle, expiresAt: updatedAt + GIT_BUNDLE_CACHE_TTL_MS, updatedAt });
      return { ...bundle, cacheUpdatedAt: updatedAt };
    })
    .finally(() => {
      if (gitBundleBuildPromises.get(cacheKey) === promise) gitBundleBuildPromises.delete(cacheKey);
    });
  gitBundleBuildPromises.set(cacheKey, promise);
  return promise;
}

function getGitBundleCache(gitRoot: string, includeNested: boolean, allowStale = false): GitBundlePayload | null {
  const cacheKey = getGitBundleCacheKey(gitRoot, includeNested);
  const cached = gitBundleCache.get(cacheKey);
  if (!cached) return null;
  const now = Date.now();
  if (cached.expiresAt <= now && !allowStale) return null;
  const cacheAgeMs = Math.max(0, now - (cached.expiresAt - GIT_BUNDLE_CACHE_TTL_MS));
  return {
    ...cached.bundle,
    cached: true,
    stale: cached.expiresAt <= now,
    cacheAgeMs,
    cacheUpdatedAt: cached.updatedAt,
  };
}

function getSinglePath(paths: unknown): string {
  if (!Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== 'string' || !paths[0]) {
    throw new Error('Expected exactly one path');
  }
  return paths[0];
}

function getStashMessage(message: unknown, fallback: string): string {
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 160) : fallback;
}

function getCommitMessage(message: unknown): string {
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('Commit message is required');
  }
  return message.trim().slice(0, 300);
}

function getRemoteName(remote: unknown): string | undefined {
  if (typeof remote !== 'string' || !remote.trim()) return undefined;
  const normalized = remote.trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) {
    throw new Error('Invalid remote name');
  }
  return normalized;
}

function getBranchName(branch: unknown): string | undefined {
  if (typeof branch !== 'string' || !branch.trim()) return undefined;
  const normalized = branch.trim();
  if (normalized.startsWith('-') || normalized.includes('..') || /[\s~^:?*\[\\]/.test(normalized)) {
    throw new Error('Invalid branch name');
  }
  return normalized;
}

function getGitActionJobKey(gitRoot: string, action: GitAction): string {
  return `${gitRoot}\0${action}`;
}

function serializeGitActionJob(job: GitActionJob) {
  return {
    jobId: job.id,
    status: job.status,
    action: job.action,
    cwd: job.cwd,
    gitRoot: job.gitRoot,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    message: job.message,
    output: job.output,
    error: job.error,
    code: job.code,
    bundle: job.bundle,
  };
}

async function runGitActionCommand(
  body: { action?: GitAction; paths?: unknown; message?: unknown; confirm?: { acknowledged?: boolean; phrase?: string }; remote?: unknown; branch?: unknown },
  gitRoot: string,
): Promise<string> {
  const { action, paths, message, confirm } = body;
  if (!action) throw new Error('Unsupported git action');
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  if (action === 'stage-all') {
    return execGit(['add', '-A'], gitRoot, undefined, GIT_ACTION_TIMEOUT_MS);
  }
  if (action === 'stash-all') {
    const stashMessage = getStashMessage(message, `Termdock stash all ${now}`);
    return execGit(['stash', 'push', '--include-untracked', '-m', stashMessage], gitRoot, undefined, GIT_ACTION_TIMEOUT_MS);
  }
  if (action === 'commit') {
    return execGit(['commit', '-m', getCommitMessage(message)], gitRoot, undefined, GIT_ACTION_TIMEOUT_MS);
  }
  if (action === 'push') {
    const remote = getRemoteName(body.remote);
    const branch = getBranchName(body.branch);
    const pushArgs = remote && branch ? ['push', '-u', remote, branch] : remote ? ['push', remote] : ['push'];
    return execGit(pushArgs, gitRoot, undefined, GIT_ACTION_TIMEOUT_MS);
  }
  if (action === 'pull') {
    const remote = getRemoteName(body.remote);
    const branch = getBranchName(body.branch);
    const pullArgs = remote && branch ? ['pull', '--ff-only', remote, branch] : remote ? ['pull', '--ff-only', remote] : ['pull', '--ff-only'];
    return execGit(pullArgs, gitRoot, undefined, GIT_ACTION_TIMEOUT_MS);
  }
  if (action === 'switch-branch') {
    const branch = getBranchName(body.branch);
    if (!branch) throw new Error('Branch is required');
    return execGit(['switch', branch], gitRoot, undefined, GIT_ACTION_TIMEOUT_MS);
  }

  const requestedPath = getSinglePath(paths);
  const pathspec = await toGitPathspec(gitRoot, requestedPath);
  if (action === 'stage-file') {
    return execGit(['--literal-pathspecs', 'add', '--', pathspec], gitRoot, undefined, GIT_ACTION_TIMEOUT_MS);
  }
  if (action === 'unstage-file') {
    return execGit(['--literal-pathspecs', 'restore', '--staged', '--', pathspec], gitRoot, undefined, GIT_ACTION_TIMEOUT_MS);
  }
  if (action === 'stash-file') {
    const stashMessage = getStashMessage(message, `Termdock stash ${pathspec} ${now}`);
    return execGit(['--literal-pathspecs', 'stash', 'push', '--include-untracked', '-m', stashMessage, '--', pathspec], gitRoot, undefined, GIT_ACTION_TIMEOUT_MS);
  }
  if (action === 'restore-worktree-file') {
    if (!confirm?.acknowledged || !RESTORE_CONFIRM_PHRASES.has((confirm.phrase ?? '').trim())) {
      const error = new Error('Confirmation required before discarding changes') as Error & { code?: string; confirmationPhrase?: string };
      error.code = 'CONFIRMATION_REQUIRED';
      error.confirmationPhrase = '丢弃改动';
      throw error;
    }
    return execGit(['--literal-pathspecs', 'restore', '--worktree', '--', pathspec], gitRoot, undefined, GIT_ACTION_TIMEOUT_MS);
  }
  throw new Error('Unsupported git action');
}

async function readBytesPrefix(filePath: string, bytesToRead: number): Promise<Buffer> {
  if (bytesToRead <= 0) return Buffer.alloc(0);

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function normalizeSearchQuery(query: unknown): string {
  return typeof query === 'string' ? query.trim().slice(0, 200) : '';
}

function toSearchPath(filePath: string): string {
  return filePath.split(path.sep).join('/').toLowerCase();
}

function searchEntryMatches(rootPath: string, candidatePath: string, queryLower: string): boolean {
  if (!queryLower) return false;
  const name = path.basename(candidatePath).toLowerCase();
  const relative = path.relative(rootPath, candidatePath) || name;
  return name.includes(queryLower) || toSearchPath(relative).includes(queryLower) || toSearchPath(candidatePath).includes(queryLower);
}

function addSearchEntry(entries: Map<string, FileSearchEntry>, entryPath: string, type: FileSearchEntry['type']): void {
  if (entries.has(entryPath)) return;
  entries.set(entryPath, {
    name: path.basename(entryPath) || entryPath,
    path: entryPath,
    type,
  });
}

function toFileEntry(entryPath: string, stat: fs.Stats, isSymlink = false): FileSearchEntry {
  return {
    name: path.basename(entryPath) || entryPath,
    path: entryPath,
    type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
    isSymlink,
    modified: stat.mtime.toISOString(),
  };
}

async function toDirectoryEntry(dir: string, dirent: Dirent, includeModified = false): Promise<FileSearchEntry> {
  const entryPath = path.join(dir, dirent.name);
  if (!dirent.isSymbolicLink() && !includeModified) {
    return {
      name: dirent.name,
      path: entryPath,
      type: dirent.isDirectory() ? 'directory' : 'file',
    };
  }
  try {
    const stat = await fs.promises.stat(entryPath);
    return {
      name: dirent.name,
      path: entryPath,
      type: stat.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file',
      isSymlink: dirent.isSymbolicLink() || undefined,
      modified: includeModified ? stat.mtime.toISOString() : undefined,
    };
  } catch {
    return {
      name: dirent.name,
      path: entryPath,
      type: dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file',
      isSymlink: dirent.isSymbolicLink() || undefined,
    };
  }
}

async function loadDirectoryEntriesWithModified(dir: string, dirents: Dirent[], signal: AbortSignal): Promise<FileSearchEntry[]> {
  const entries: FileSearchEntry[] = [];
  const batchSize = 64;
  for (let offset = 0; offset < dirents.length; offset += batchSize) {
    throwIfAborted(signal, 'fs.list');
    entries.push(...await Promise.all(
      dirents.slice(offset, offset + batchSize).map((dirent) => toDirectoryEntry(dir, dirent, true)),
    ));
  }
  return entries;
}

function compareDirectoryEntriesByModified(a: FileSearchEntry, b: FileSearchEntry): number {
  if (a.type === 'directory' && b.type !== 'directory') return -1;
  if (a.type !== 'directory' && b.type === 'directory') return 1;
  const modifiedDelta = Date.parse(b.modified ?? '') - Date.parse(a.modified ?? '');
  if (Number.isFinite(modifiedDelta) && modifiedDelta !== 0) return modifiedDelta;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function isIgnoredWatchPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).some((part) => WATCH_IGNORED_NAMES.has(part));
}

function sortSearchEntries(entries: FileSearchEntry[]): FileSearchEntry[] {
  return entries.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.path.localeCompare(b.path);
  });
}

function addMatchingParentDirectories(rootPath: string, absoluteFilePath: string, queryLower: string, entries: Map<string, FileSearchEntry>): void {
  let current = path.dirname(absoluteFilePath);
  while (current && current !== rootPath && isPathInside(rootPath, current)) {
    if (searchEntryMatches(rootPath, current, queryLower)) {
      addSearchEntry(entries, current, 'directory');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function searchWithRipgrep(rootPath: string, queryLower: string, showHidden: boolean, excludePatterns: string[], signal: AbortSignal): Promise<FileSearchPayload> {
  return new Promise((resolve, reject) => {
    const args = ['--files', '--color', 'never', '--no-messages', '--null'];
    if (showHidden) args.push('--hidden', '-g', '!.git/');
    appendRipgrepExcludeArgs(args, excludePatterns);

    const proc = spawn('rg', args, { cwd: rootPath, stdio: ['ignore', 'pipe', 'pipe'] });
    const entries = new Map<string, FileSearchEntry>();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abortHandler);
      fn();
    };

    const abortHandler = () => {
      proc.kill('SIGTERM');
      finish(() => reject(new Error('Search aborted')));
    };
    signal.addEventListener('abort', abortHandler);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let boundary = stdout.lastIndexOf('\0');
      if (boundary < 0) return;
      const complete = stdout.slice(0, boundary);
      stdout = stdout.slice(boundary + 1);
      for (const relativePath of complete.split('\0')) {
        if (!relativePath) continue;
        const absolutePath = path.join(rootPath, relativePath);
        if (!searchEntryMatches(rootPath, absolutePath, queryLower)) {
          addMatchingParentDirectories(rootPath, absolutePath, queryLower, entries);
          continue;
        }
        addSearchEntry(entries, absolutePath, 'file');
        addMatchingParentDirectories(rootPath, absolutePath, queryLower, entries);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('error', (error) => finish(() => reject(error)));
    proc.on('close', (code) => {
      if (settled) return;
      if (code !== 0 && code !== 1) {
        finish(() => reject(new Error(stderr.trim() || `rg exited with code ${code}`)));
        return;
      }
      finish(() => resolve({
        path: rootPath,
        query: queryLower,
        entries: sortSearchEntries(Array.from(entries.values())),
        truncated: false,
        total: entries.size,
        engine: 'rg',
      }));
    });
  });
}

async function searchWithFallback(rootPath: string, queryLower: string, showHidden: boolean, excludePatterns: string[], signal: AbortSignal): Promise<FileSearchPayload> {
  const entries = new Map<string, FileSearchEntry>();
  const queue = [rootPath];
  const isExcluded = createExcludeMatcher(excludePatterns);
  let visited = 0;

  while (queue.length > 0 && visited < MAX_FALLBACK_SEARCH_VISITED) {
    if (signal.aborted) throw new Error('Search aborted');
    const dirPath = queue.shift();
    if (!dirPath) continue;
    visited += 1;
    let dirents: Dirent[];
    try {
      dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (!showHidden && dirent.name.startsWith('.')) continue;
      if (dirent.name === '.git') continue;
      const fullPath = path.join(dirPath, dirent.name);
      if (isExcluded(path.relative(rootPath, fullPath))) continue;
      const type: FileSearchEntry['type'] = dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file';
      if (searchEntryMatches(rootPath, fullPath, queryLower)) {
        addSearchEntry(entries, fullPath, type);
      }
      if (dirent.isDirectory()) queue.push(fullPath);
    }
  }

  return {
    path: rootPath,
    query: queryLower,
    entries: sortSearchEntries(Array.from(entries.values())),
    truncated: visited >= MAX_FALLBACK_SEARCH_VISITED,
    total: entries.size,
    engine: 'fallback',
    limited: visited >= MAX_FALLBACK_SEARCH_VISITED,
  };
}

function writeSearchEvent(res: Response, type: string, payload: Record<string, unknown>): void {
  writeResponseChunk(res, `${JSON.stringify({ type, ...payload })}\n`);
}

function createSearchBatchEmitter(res: Response) {
  let batch: FileSearchEntry[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    if (!isResponseWritable(res)) {
      batch = [];
      return;
    }
    writeSearchEvent(res, 'batch', { entries: batch });
    batch = [];
  };
  return {
    push(entry: FileSearchEntry) {
      batch.push(entry);
      if (batch.length >= 60) flush();
    },
    flush,
  };
}

function streamSearchWithRipgrep(rootPath: string, queryLower: string, showHidden: boolean, excludePatterns: string[], signal: AbortSignal, res: Response): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = ['--files', '--color', 'never', '--no-messages', '--null'];
    if (showHidden) args.push('--hidden', '-g', '!.git/');
    appendRipgrepExcludeArgs(args, excludePatterns);

    const proc = spawn('rg', args, { cwd: rootPath, stdio: ['ignore', 'pipe', 'pipe'] });
    const emitted = new Map<string, FileSearchEntry>();
    const batch = createSearchBatchEmitter(res);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const emitEntry = (entryPath: string, type: FileSearchEntry['type']) => {
      if (emitted.has(entryPath)) return;
      const entry = { name: path.basename(entryPath) || entryPath, path: entryPath, type };
      emitted.set(entryPath, entry);
      batch.push(entry);
    };
    const emitMatchingParents = (absoluteFilePath: string) => {
      let current = path.dirname(absoluteFilePath);
      while (current && current !== rootPath && isPathInside(rootPath, current)) {
        if (searchEntryMatches(rootPath, current, queryLower)) emitEntry(current, 'directory');
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abortHandler);
      batch.flush();
      fn();
    };
    const abortHandler = () => {
      proc.kill('SIGTERM');
      finish(() => reject(new Error('Search aborted')));
    };
    signal.addEventListener('abort', abortHandler);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const boundary = stdout.lastIndexOf('\0');
      if (boundary < 0) return;
      const complete = stdout.slice(0, boundary);
      stdout = stdout.slice(boundary + 1);
      for (const relativePath of complete.split('\0')) {
        if (!relativePath) continue;
        const absolutePath = path.join(rootPath, relativePath);
        if (!searchEntryMatches(rootPath, absolutePath, queryLower)) {
          emitMatchingParents(absolutePath);
          continue;
        }
        emitEntry(absolutePath, 'file');
        emitMatchingParents(absolutePath);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('error', (error) => finish(() => reject(error)));
    proc.on('close', (code) => {
      if (settled) return;
      if (code !== 0 && code !== 1) {
        finish(() => reject(new Error(stderr.trim() || `rg exited with code ${code}`)));
        return;
      }
      finish(() => resolve(emitted.size));
    });
  });
}

async function streamSearchWithFallback(rootPath: string, queryLower: string, showHidden: boolean, excludePatterns: string[], signal: AbortSignal, res: Response): Promise<{ total: number; limited: boolean }> {
  const emitted = new Set<string>();
  const batch = createSearchBatchEmitter(res);
  const queue = [rootPath];
  const isExcluded = createExcludeMatcher(excludePatterns);
  let visited = 0;
  const emitEntry = (entryPath: string, type: FileSearchEntry['type']) => {
    if (emitted.has(entryPath)) return;
    emitted.add(entryPath);
    batch.push({ name: path.basename(entryPath) || entryPath, path: entryPath, type });
  };

  while (queue.length > 0 && visited < MAX_FALLBACK_SEARCH_VISITED) {
    if (signal.aborted || res.destroyed) throw new Error('Search aborted');
    const dirPath = queue.shift();
    if (!dirPath) continue;
    visited += 1;
    let dirents: Dirent[];
    try {
      dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (!showHidden && dirent.name.startsWith('.')) continue;
      if (dirent.name === '.git') continue;
      const fullPath = path.join(dirPath, dirent.name);
      if (isExcluded(path.relative(rootPath, fullPath))) continue;
      const type: FileSearchEntry['type'] = dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file';
      if (searchEntryMatches(rootPath, fullPath, queryLower)) {
        emitEntry(fullPath, type);
      }
      if (dirent.isDirectory()) queue.push(fullPath);
    }
  }

  batch.flush();
  return { total: emitted.size, limited: visited >= MAX_FALLBACK_SEARCH_VISITED };
}

function createContentBatchEmitter(res: Response) {
  let batch: ContentSearchEntry[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    if (!isResponseWritable(res)) {
      batch = [];
      return;
    }
    writeSearchEvent(res, 'content-batch', { contentEntries: batch });
    batch = [];
  };
  return {
    push(entry: ContentSearchEntry) {
      batch.push(entry);
      if (batch.length >= 20) flush();
    },
    flush,
  };
}

// Full-text search using ripgrep's JSON output. Results are aggregated per
// file (path + matching lines) and streamed in small batches. Unlike the
// file-name search there is no fallback engine: a recursive content grep
// without ripgrep would be far too expensive, so callers get an explicit
// "ripgrep required" error instead.
function streamContentSearchWithRipgrep(
  rootPath: string,
  query: string,
  showHidden: boolean,
  excludePatterns: string[],
  options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
  signal: AbortSignal,
  res: Response,
): Promise<{ total: number; limited: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      '--json',
      '--no-messages',
      '-m', String(MAX_CONTENT_MATCHES_PER_FILE),
    ];
    if (showHidden) args.push('--hidden', '-g', '!.git/');
    args.push(options.caseSensitive ? '--case-sensitive' : '--ignore-case');
    if (options.wholeWord) args.push('--word-regexp');
    if (!options.regex) args.push('--fixed-strings');
    appendRipgrepExcludeArgs(args, excludePatterns);
    args.push('--', query);

    const proc = spawn('rg', args, { cwd: rootPath, stdio: ['ignore', 'pipe', 'pipe'] });
    const batch = createContentBatchEmitter(res);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let fileCount = 0;
    let limited = false;
    // Buffer matches per file until rg emits the file's "end" event.
    let currentPath: string | null = null;
    let currentMatches: ContentMatchLine[] = [];

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abortHandler);
      batch.flush();
      fn();
    };
    const abortHandler = () => {
      proc.kill('SIGTERM');
      finish(() => reject(new Error('Search aborted')));
    };
    signal.addEventListener('abort', abortHandler);

    const flushCurrentFile = () => {
      if (currentPath && currentMatches.length > 0) {
        if (fileCount >= MAX_CONTENT_SEARCH_FILES) {
          limited = true;
        } else {
          fileCount += 1;
          batch.push({ name: path.basename(currentPath) || currentPath, path: currentPath, matches: currentMatches });
        }
      }
      currentPath = null;
      currentMatches = [];
    };

    const handleEvent = (raw: string) => {
      if (!raw.trim()) return;
      let event: any;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }
      if (event.type === 'begin') {
        const text = event.data?.path?.text;
        currentPath = typeof text === 'string' ? path.resolve(rootPath, text) : null;
        currentMatches = [];
      } else if (event.type === 'match') {
        if (!currentPath) return;
        if (currentMatches.length >= MAX_CONTENT_MATCHES_PER_FILE) return;
        const lineNumber = typeof event.data?.line_number === 'number' ? event.data.line_number : null;
        const lineTextRaw = event.data?.lines?.text;
        if (lineNumber === null || typeof lineTextRaw !== 'string') return;
        const trimmed = lineTextRaw.replace(/\r?\n$/, '');
        const text = trimmed.length > MAX_CONTENT_MATCH_LINE_LENGTH
          ? `${trimmed.slice(0, MAX_CONTENT_MATCH_LINE_LENGTH)}…`
          : trimmed;
        currentMatches.push({ line: lineNumber, text });
      } else if (event.type === 'end') {
        flushCurrentFile();
        if (limited) {
          proc.kill('SIGTERM');
        }
      }
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let newlineIndex = stdout.indexOf('\n');
      while (newlineIndex >= 0) {
        handleEvent(stdout.slice(0, newlineIndex));
        stdout = stdout.slice(newlineIndex + 1);
        newlineIndex = stdout.indexOf('\n');
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('error', (error) => finish(() => reject(error)));
    proc.on('close', (code) => {
      if (settled) return;
      // rg exits 1 when there are no matches (not an error here) and is killed
      // (null code) once we hit the file cap; treat >=2 as a real failure.
      if (code !== null && code !== 0 && code !== 1) {
        finish(() => reject(new Error(stderr.trim() || `rg exited with code ${code}`)));
        return;
      }
      flushCurrentFile();
      finish(() => resolve({ total: fileCount, limited }));
    });
  });
}

function execGit(args: string[], cwd: string, signal?: AbortSignal, timeoutMs: number | null = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = timeoutMs === null ? null : setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('git command timed out'));
    }, timeoutMs);

    const proc = execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      proc.kill();
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new GitCommandAbortError());
    };
    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

function execGitLimited(
  args: string[],
  cwd: string,
  maxBytes: number,
  allowExitCodeOne = false,
  signal?: AbortSignal,
  logContext?: { id: number; action: string; op: string; path?: string; extra?: Record<string, unknown> },
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderr = '';
    let settled = false;
    let truncated = false;

    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    if (logContext) {
      logFsIoEvent({ ...logContext, event: 'git-child-start', cwd, childPid: proc.pid, args });
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      if (logContext) {
        logFsIoEvent({ ...logContext, event: 'git-child-timeout-kill', cwd, childPid: proc.pid, args, code: 'GIT_CHILD_TIMEOUT' });
      }
      reject(new Error('git command timed out'));
    }, GIT_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      fn();
    };

    const abortHandler = () => {
      proc.kill();
      if (logContext) {
        logFsIoEvent({ ...logContext, event: 'git-child-abort-kill', cwd, childPid: proc.pid, args, code: 'GIT_CHILD_ABORTED' });
      }
      const reason = signal?.reason;
      finish(() => reject(reason instanceof Error ? reason : new GitCommandAbortError()));
    };
    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const remainingBytes = maxBytes - totalBytes;
      if (chunk.length > remainingBytes) {
        if (remainingBytes > 0) {
          chunks.push(chunk.subarray(0, remainingBytes));
          totalBytes += remainingBytes;
        }
        truncated = true;
        if (logContext) {
          logFsIoEvent({ ...logContext, event: 'git-child-byte-limit-kill', cwd, childPid: proc.pid, args, code: 'GIT_CHILD_BYTE_LIMIT', extra: { maxBytes } });
        }
        proc.kill();
        return;
      }
      chunks.push(chunk);
      totalBytes += chunk.length;
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('error', (error) => finish(() => reject(error)));
    proc.on('close', (code) => {
      finish(() => {
        if (logContext) {
          logFsIoEvent({ ...logContext, event: 'git-child-close', cwd, childPid: proc.pid, args, extra: { exitCode: code, totalBytes, truncated } });
        }
        const allowed = code === 0 || (allowExitCodeOne && code === 1);
        if (!allowed && !truncated) {
          reject(new Error(stderr.trim() || `git exited with code ${code}`));
          return;
        }
        resolve({ stdout: Buffer.concat(chunks).toString('utf8'), truncated });
      });
    });
  });
}

function isSafeGitRefName(ref: string): boolean {
  if (!ref || ref.length > 240) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('\\') || ref.includes('//')) return false;
  if (/[\s~^:?*[\\\]\0-\x1f\x7f]/.test(ref)) return false;
  return true;
}

function normalizeDiffPath(value: string): string | null {
  if (!value || value === '/dev/null') return null;
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
}

function buildHunkFingerprint(lines: string[]): string {
  const changedLines = lines
    .filter((line) => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')))
    .map((line) => `${line.startsWith('+') ? 'insert' : 'delete'}:${line.slice(1)}`);
  const text = changedLines.length > 0
    ? changedLines.join('\n')
    : lines.map((line) => line.slice(1)).join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseBranchDiffHunks(diffText: string): BranchDiffHunk[] {
  const hunks: BranchDiffHunk[] = [];
  const lines = diffText.split('\n');
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let currentHeader: string | null = null;
  let currentLines: string[] = [];
  let hunkIndexByFile = 0;

  const flush = () => {
    if (!currentHeader || (!oldPath && !newPath)) return;
    const filePath = newPath ?? oldPath ?? '';
    const oldDiffPath = oldPath ? `a/${oldPath}` : '/dev/null';
    const newDiffPath = newPath ? `b/${newPath}` : '/dev/null';
    const hunkDiff = [
      `diff --git a/${oldPath ?? filePath} b/${newPath ?? filePath}`,
      `--- ${oldDiffPath}`,
      `+++ ${newDiffPath}`,
      currentHeader,
      ...currentLines,
    ].join('\n');
    hunks.push({
      filePath,
      oldPath,
      newPath,
      hunkHeader: currentHeader,
      hunkIndex: hunkIndexByFile,
      fingerprint: buildHunkFingerprint(currentLines),
      additions: currentLines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: currentLines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      diff: hunkDiff,
    });
    hunkIndexByFile += 1;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentHeader = null;
      currentLines = [];
      hunkIndexByFile = 0;
      const match = /^diff --git (.+) (.+)$/.exec(line);
      oldPath = normalizeDiffPath(match?.[1] ?? '');
      newPath = normalizeDiffPath(match?.[2] ?? '');
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = normalizeDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith('+++ ')) {
      newPath = normalizeDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith('@@ ')) {
      flush();
      currentHeader = line;
      currentLines = [];
      continue;
    }
    if (currentHeader) currentLines.push(line);
  }
  flush();
  return hunks;
}

async function annotateBranchDiffHunks(
  repoRoot: string,
  baseRef: string,
  hunks: BranchDiffHunk[],
  signal: AbortSignal,
): Promise<BranchDiffHunk[]> {
  if (hunks.length === 0) return hunks;
  const workingDiff = await execGitLimited(['diff', 'HEAD'], repoRoot, MAX_BRANCH_DIFF_BYTES, false, signal)
    .then((result) => result.stdout)
    .catch(emptyOnNonAbortGitError);
  const workingFingerprints = new Set(parseBranchDiffHunks(workingDiff).map((hunk) => `${hunk.filePath}\0${hunk.hunkHeader}\0${hunk.fingerprint}`));
  const commitByFile = new Map<string, string | null>();
  await Promise.all(Array.from(new Set(hunks.map((hunk) => hunk.filePath))).map(async (filePath) => {
    const commit = await execGit(['log', '-1', '--format=%h', `${baseRef}..HEAD`, '--', filePath], repoRoot, signal)
      .then((result) => result.trim() || null)
      .catch(() => null);
    commitByFile.set(filePath, commit);
  }));
  return hunks.map((hunk) => {
    const key = `${hunk.filePath}\0${hunk.hunkHeader}\0${hunk.fingerprint}`;
    if (workingFingerprints.has(key)) return { ...hunk, source: 'uncommitted' as const, commit: null };
    const commit = commitByFile.get(hunk.filePath) ?? null;
    return { ...hunk, source: commit ? 'committed' as const : 'unknown' as const, commit };
  });
}

async function getBranchDiffPayload(
  workspaceRoot: string,
  repoRoot: string,
  baseBranch: string,
  options: { headRef?: string | null; includeUncommitted?: boolean } | undefined,
  signal: AbortSignal,
): Promise<BranchDiffPayload> {
  const trimmedBase = baseBranch.trim();
  if (!isSafeGitRefName(trimmedBase)) {
    return { available: false, workspaceRoot, repoRoot, baseBranch: trimmedBase, error: 'Invalid base branch name' };
  }
  const requestedHead = options?.headRef?.trim() ?? '';
  const hasRequestedHead = requestedHead.length > 0;
  if (hasRequestedHead && !isSafeGitRefName(requestedHead)) {
    return { available: false, workspaceRoot, repoRoot, baseBranch: trimmedBase, error: 'Invalid target branch name' };
  }
  const includeUncommitted = options?.includeUncommitted ?? true;

  let baseRef = trimmedBase.includes('/') ? trimmedBase : `origin/${trimmedBase}`;
  if (trimmedBase.includes('/')) {
    await execGit(['rev-parse', '--verify', '--quiet', baseRef], repoRoot, signal);
  } else {
    try {
      await execGit(['fetch', 'origin', trimmedBase, '--no-tags'], repoRoot, signal, GIT_ROUTE_TIMEOUT_MS);
    } catch (error) {
      const localRef = await execGit(['rev-parse', '--verify', '--quiet', trimmedBase], repoRoot, signal)
        .then(() => trimmedBase)
        .catch(() => null);
      if (!localRef) throw error;
      baseRef = localRef;
    }
  }
  let compareHead = 'HEAD';
  if (hasRequestedHead) {
    compareHead = requestedHead.includes('/') ? requestedHead : requestedHead;
    await execGit(['rev-parse', '--verify', '--quiet', compareHead], repoRoot, signal);
  }
  const includeWorkingTree = includeUncommitted && !hasRequestedHead;
  // Diff merge-base → working tree in a single pass, so committed and
  // uncommitted changes to the same file merge into one coherent diff
  // instead of two overlapping per-file diffs concatenated together.
  // Falls back to the concatenated form when there is no merge base.
  const mergeBase = includeWorkingTree
    ? await execGit(['merge-base', baseRef, compareHead], repoRoot, signal)
      .then((result) => result.trim() || null)
      .catch(() => null)
    : null;
  const diffBase = mergeBase ?? `${baseRef}...${compareHead}`;
  const fetchSeparateWorktreeDiff = includeWorkingTree && !mergeBase;
  const [currentBranch, headRef, statResult, nameResult, workingNameResult, logResult, diffResult, workingDiffResult] = await Promise.all([
    execGit(['branch', '--show-current'], repoRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['rev-parse', '--short=12', compareHead], repoRoot, signal).catch(emptyOnNonAbortGitError),
    execGitLimited(['diff', diffBase, '--stat'], repoRoot, MAX_BRANCH_DIFF_STAT_BYTES, false, signal),
    execGitLimited(['diff', '--name-only', diffBase], repoRoot, MAX_BRANCH_DIFF_NAME_BYTES, false, signal),
    fetchSeparateWorktreeDiff ? execGitLimited(['diff', '--name-only', 'HEAD'], repoRoot, MAX_BRANCH_DIFF_NAME_BYTES, false, signal) : Promise.resolve({ stdout: '', truncated: false }),
    execGitLimited(['log', `${baseRef}..${compareHead}`, '--oneline', '--no-merges'], repoRoot, MAX_BRANCH_DIFF_LOG_BYTES, false, signal),
    execGitLimited(['diff', diffBase], repoRoot, MAX_BRANCH_DIFF_BYTES, false, signal),
    fetchSeparateWorktreeDiff ? execGitLimited(['diff', 'HEAD'], repoRoot, MAX_BRANCH_DIFF_BYTES, false, signal) : Promise.resolve({ stdout: '', truncated: false }),
  ]);
  const trackedDiff = [diffResult.stdout, workingDiffResult.stdout].filter(Boolean).join('\n');
  const untrackedResult = includeWorkingTree
    ? await appendUntrackedDiffs(repoRoot, trackedDiff, signal, {
      maxBytes: MAX_BRANCH_DIFF_BYTES,
      perFileMaxBytes: MAX_UNTRACKED_DIFF_FILE_BYTES,
    })
    : { diff: trackedDiff, files: [] as string[], skippedFiles: [] as DiffSkippedFile[], truncated: false };
  const diff = untrackedResult.diff;
  const stat = statResult.stdout.trim();
  const files = Array.from(new Set([
    ...nameResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
    ...workingNameResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
    ...untrackedResult.files,
  ]));
  const hunks = await annotateBranchDiffHunks(repoRoot, baseRef, parseBranchDiffHunks(diff), signal);
  const commits = logResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const fingerprint = buildChangeAuditFingerprint([
    repoRoot,
    baseRef,
    currentBranch.trim(),
    headRef.trim(),
    stat,
    files.join('\n'),
    commits.join('\n'),
    diff,
  ]);
  return {
    available: true,
    workspaceRoot,
    repoRoot,
    baseRef,
    baseBranch: trimmedBase,
    currentBranch: hasRequestedHead ? requestedHead : (currentBranch.trim() || null),
    headRef: headRef.trim() || null,
    diffFingerprint: fingerprint,
    stat,
    files,
    skippedFiles: untrackedResult.skippedFiles.length > 0 ? untrackedResult.skippedFiles : undefined,
    hunks,
    commits,
    commitCount: commits.length,
    diff,
    truncated: statResult.truncated || nameResult.truncated || logResult.truncated || diffResult.truncated || untrackedResult.truncated,
  };
}

async function getCommitDiffPayload(
  workspaceRoot: string,
  repoRoot: string,
  commit: string,
  signal: AbortSignal,
): Promise<BranchDiffPayload> {
  const trimmedCommit = commit.trim();
  if (!isSafeGitRefName(trimmedCommit)) {
    return { available: false, workspaceRoot, repoRoot, baseBranch: trimmedCommit, error: 'Invalid commit ref' };
  }
  const [currentBranch, headRef, subject, statResult, nameResult, diffResult] = await Promise.all([
    execGit(['branch', '--show-current'], repoRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['rev-parse', '--short=12', trimmedCommit], repoRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['log', '-1', '--format=%s', trimmedCommit], repoRoot, signal).catch(emptyOnNonAbortGitError),
    execGitLimited(['show', '--stat', '--format=', trimmedCommit], repoRoot, MAX_BRANCH_DIFF_STAT_BYTES, false, signal),
    execGitLimited(['show', '--name-only', '--format=', trimmedCommit], repoRoot, MAX_BRANCH_DIFF_NAME_BYTES, false, signal),
    execGitLimited(['show', '--format=', trimmedCommit], repoRoot, MAX_BRANCH_DIFF_BYTES, false, signal),
  ]);
  const diff = diffResult.stdout;
  const stat = statResult.stdout.trim();
  const files = Array.from(new Set(nameResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean)));
  const hunks = parseBranchDiffHunks(diff).map((hunk) => ({ ...hunk, source: 'committed' as const, commit: headRef.trim() || trimmedCommit }));
  const fingerprint = buildChangeAuditFingerprint([
    repoRoot,
    trimmedCommit,
    currentBranch.trim(),
    headRef.trim(),
    stat,
    files.join('\n'),
    subject.trim(),
    diff,
  ]);
  return {
    available: true,
    workspaceRoot,
    repoRoot,
    baseRef: `${trimmedCommit}^`,
    baseBranch: trimmedCommit,
    currentBranch: currentBranch.trim() || null,
    headRef: headRef.trim() || trimmedCommit,
    diffFingerprint: fingerprint,
    stat,
    files,
    hunks,
    commits: [subject.trim()].filter(Boolean),
    commitCount: subject.trim() ? 1 : 0,
    diff,
    truncated: statResult.truncated || nameResult.truncated || diffResult.truncated,
  };
}

// In-memory cache for `git rev-parse --show-toplevel` results.
// Key = requested cwd, Value = { root, expiresAt }. Invalidated quickly so
// directory changes still propagate, but reused within the same UI burst
// (open sidebar fires ~3 git fetches at once).
const GIT_ROOT_CACHE_TTL_MS = 5_000;
const gitRootCache = new Map<string, { root: string | null; expiresAt: number }>();
const gitBundleCache = new Map<string, { bundle: GitBundlePayload; expiresAt: number; updatedAt: number }>();
const gitBundleBuildPromises = new Map<string, Promise<GitBundlePayload>>();

function getGitBundleCacheKey(gitRoot: string, includeNested: boolean): string {
  return `${gitRoot}\u0000${includeNested ? 'nested' : 'single'}`;
}

function clearGitBundleCacheForRoot(root: string): void {
  for (const key of gitBundleCache.keys()) {
    if (key.startsWith(`${root}\u0000`)) gitBundleCache.delete(key);
  }
  for (const key of gitBundleBuildPromises.keys()) {
    if (key.startsWith(`${root}\u0000`)) gitBundleBuildPromises.delete(key);
  }
}

/** Find the top-level directory of the git repo containing `cwd`, or null. */
async function findGitRoot(cwd: string, timeoutMs: number | null = GIT_TIMEOUT_MS): Promise<string | null> {
  const now = Date.now();
  const cached = gitRootCache.get(cwd);
  if (cached && cached.expiresAt > now) {
    return cached.root;
  }
  try {
    const root = (await execGit(['rev-parse', '--show-toplevel'], cwd, undefined, timeoutMs)).trim() || null;
    gitRootCache.set(cwd, { root, expiresAt: now + GIT_ROOT_CACHE_TTL_MS });
    return root;
  } catch {
    // Do NOT cache null — a transient failure (timeout, lock contention, I/O
    // delay) must not be mistaken for "not a git repository". On a real
    // non-git directory git rev-parse fails instantly (< 50 ms), so the
    // cost of retrying is negligible.
    return null;
  }
}

async function hasGitMetadata(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(path.join(candidate, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

async function getDirectoryTarget(candidate: string, entry: Dirent): Promise<string | null> {
  if (entry.isDirectory()) return candidate;
  if (!entry.isSymbolicLink()) return null;
  try {
    const realPath = await fs.promises.realpath(candidate);
    const stat = await fs.promises.stat(realPath);
    return stat.isDirectory() ? realPath : null;
  } catch {
    return null;
  }
}

async function discoverNestedGitRoots(workspaceRoot: string, signal?: AbortSignal): Promise<{ repositories: DiscoveredGitRepository[]; truncated: boolean }> {
  const repositories: DiscoveredGitRepository[] = [];
  const seen = new Set<string>([workspaceRoot]);
  const deadline = Date.now() + NESTED_GIT_DISCOVERY_TIMEOUT_MS;
  let truncated = false;

  async function visit(dir: string): Promise<void> {
    if (signal) throwIfAborted(signal, 'git.bundle');
    if (truncated) return;
    if (Date.now() > deadline) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const childDirectories: Array<{ entry: Dirent; target: string }> = [];
    for (const entry of entries) {
      if (signal) throwIfAborted(signal, 'git.bundle');
      if (truncated) return;
      if (Date.now() > deadline) {
        truncated = true;
        return;
      }
      if (NESTED_GIT_DISCOVERY_IGNORED_NAMES.has(entry.name)) continue;
      const candidate = path.join(dir, entry.name);
      const target = await getDirectoryTarget(candidate, entry);
      if (!target) continue;
      // A Git repository is a hard boundary: record it, then do not scan
      // deeper inside it. This catches containers like `repos/android` while
      // avoiding expensive nested scans through large project worktrees.
      if (await hasGitMetadata(candidate) || await hasGitMetadata(target)) {
        const root = await findGitRoot(target);
        if (root && root !== workspaceRoot && !seen.has(root)) {
          seen.add(root);
          repositories.push({ root, displayRoot: candidate });
          if (repositories.length >= MAX_NESTED_GIT_REPOS) {
            truncated = true;
            return;
          }
        }
        continue;
      }
      if (!entry.isSymbolicLink()) childDirectories.push({ entry, target });
    }

    for (const child of childDirectories) {
      if (signal) throwIfAborted(signal, 'git.bundle');
      if (truncated) return;
      await visit(child.target);
    }
  }

  if (signal) throwIfAborted(signal, 'git.bundle');
  await visit(workspaceRoot);
  if (signal) throwIfAborted(signal, 'git.bundle');
  repositories.sort((a, b) => a.displayRoot.localeCompare(b.displayRoot));
  return { repositories, truncated };
}

async function getCachedNestedGitRoots(workspaceRoot: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<{ repositories: DiscoveredGitRepository[]; truncated: boolean }> {
  if (options.signal) throwIfAborted(options.signal, 'git.bundle');
  const now = Date.now();
  const cached = nestedGitRootsCache.get(workspaceRoot);
  if (!options.refresh && cached) {
    if (cached.expiresAt > now) return cached.result;
    if (cached.promise) return cached.promise;
  }
  const promise = discoverNestedGitRoots(workspaceRoot, options.signal)
    .then((result) => {
      if (result.truncated && cached?.result.repositories.length) {
        return { ...cached.result, truncated: true };
      }
      nestedGitRootsCache.set(workspaceRoot, {
        result,
        expiresAt: Date.now() + NESTED_GIT_DISCOVERY_CACHE_TTL_MS,
      });
      return result;
    })
    .finally(() => {
      const current = nestedGitRootsCache.get(workspaceRoot);
      if (current?.promise === promise) {
        nestedGitRootsCache.set(workspaceRoot, {
          result: current.result,
          expiresAt: current.expiresAt,
        });
      }
    });
  if (cached?.result) {
    nestedGitRootsCache.set(workspaceRoot, { ...cached, promise });
  } else {
    nestedGitRootsCache.set(workspaceRoot, {
      result: { repositories: [], truncated: false },
      expiresAt: 0,
      promise,
    });
  }
  return promise;
}

// Directory listing
router.get('/list', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const requestedPath = req.query.path as string;
  const action = getRequestAction(req, 'list_directory');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('fs.list'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  registerIoSlot({ requestId, op: 'fs.list', action, slotId: requestSlotId, controller, path: requestedPath });
  try {
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const result = await withTimeout((async () => {
      const resolvedPath = await pathValidator.validatePathAsync(requestedPath);
      throwIfAborted(controller.signal, 'fs.list');
      const stat = await fs.promises.stat(resolvedPath);
      throwIfAborted(controller.signal, 'fs.list');

      if (!stat.isDirectory()) {
        throw new Error('Path is not a directory');
      }

      const showHidden = req.query.showHidden === 'true';
      const sortMode = req.query.sort === 'modified' ? 'modified' : 'name';
      const allEntries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
      throwIfAborted(controller.signal, 'fs.list');
      const visibleDirents = allEntries.filter(dirent => showHidden || !dirent.name.startsWith('.'));
      const entries = sortMode === 'modified'
        ? (await loadDirectoryEntriesWithModified(resolvedPath, visibleDirents, controller.signal))
            .sort(compareDirectoryEntriesByModified)
            .slice(0, MAX_DIRECTORY_ENTRIES)
        : await Promise.all(visibleDirents
            .sort(compareDirents)
            .slice(0, MAX_DIRECTORY_ENTRIES)
            .map((dirent) => toDirectoryEntry(resolvedPath, dirent)));
      throwIfAborted(controller.signal, 'fs.list');
      return { resolvedPath, entries, total: visibleDirents.length };
    })(), FS_ROUTE_TIMEOUT_MS, 'Directory listing took too long. The folder may be on a slow disk or network mount.', 'FS_LIST_TIMEOUT');

    res.setHeader('X-Termdock-FS-List-Duration-Ms', String(Date.now() - startedAt));
    res.setHeader('X-Termdock-FS-List-Total', String(result.total));
    res.setHeader('X-Termdock-FS-List-Returned', String(result.entries.length));
    logFsIo({ id: requestId, action, op: 'fs.list', startedAt, status: 'ok', path: result.resolvedPath, count: result.entries.length, total: result.total, truncated: result.total > result.entries.length, extra: { requestSlotId } });
    res.json({ path: result.resolvedPath, entries: result.entries, truncated: result.total > result.entries.length, total: result.total });
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action, op: 'fs.list', startedAt, status: 'error', path: requestedPath, code: payload.code, error: payload.error, extra: { requestSlotId } });
    res.status(error instanceof OperationTimeoutError ? 504 : 403).json(payload);
  } finally {
    releaseIoSlot(requestSlotId, requestId);
  }
});

// Stream file-system changes for the active file explorer roots. This is not a
// deep directory listing; it uses the OS watcher and sends small batched events
// so the client can patch only directories it has already loaded.
router.get('/watch', async (req: Request, res: Response) => {
  const repeatedRootsParam = req.query.root;
  const rootsParam = req.query.roots;
  const rawRoots = (Array.isArray(repeatedRootsParam)
    ? repeatedRootsParam
    : typeof repeatedRootsParam === 'string'
      ? [repeatedRootsParam]
      : Array.isArray(rootsParam)
        ? rootsParam
        : typeof rootsParam === 'string'
          ? rootsParam.split('|')
          : [])
    .filter((root): root is string => typeof root === 'string');
  const validatedRoots: string[] = [];
  for (const rawRoot of rawRoots) {
    if (!rawRoot) continue;
    try {
      const resolved = await pathValidator.validatePathAsync(rawRoot);
      const stat = await fs.promises.stat(resolved);
      if (stat.isDirectory() && !validatedRoots.includes(resolved)) validatedRoots.push(resolved);
    } catch {
      // Ignore invalid watch roots; the visible tree will still work via manual list requests.
    }
  }

  const roots = normalizeDirectoryWatchRoots(validatedRoots);
  if (roots.length === 0) {
    res.status(400).json({ error: 'No valid roots to watch' });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  let closed = false;
  let pending: FileWatchEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const attachedRoots = new Map<string, SharedWatchClient>();

  // Register cleanup before the first native watch or fallback snapshot starts;
  // the browser may abort while roots are being validated or attached.
  const closeWatchStream = () => {
    if (closed) return;
    closed = true;
    if (flushTimer) clearTimeout(flushTimer);
    for (const [rootPath, client] of attachedRoots) {
      releaseSharedWatch(rootPath, client);
    }
  };
  res.once('close', closeWatchStream);

  const writeEvent = (type: string, payload: Record<string, unknown>) => {
    if (closed) return false;
    return writeResponseChunk(res, `${JSON.stringify({ type, ...payload })}\n`);
  };
  const flush = () => {
    flushTimer = null;
    if (pending.length === 0) return;
    const events = pending;
    pending = [];
    writeEvent('events', { events });
  };
  const enqueue = (event: FileWatchEvent) => {
    if (closed) return;
    if (pending.length >= WATCH_EVENT_STORM_LIMIT) {
      pending = roots.map((rootPath) => ({ type: 'rescan-required', path: rootPath, reason: 'event-storm' }));
    } else {
      pending.push(event);
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flush, WATCH_BATCH_MS);
      flushTimer.unref?.();
    }
  };

  writeEvent('ready', { roots });
  console.info('[file-watch] Stream ready', {
    requestedRoots: rawRoots.length,
    validatedRoots: validatedRoots.length,
    subscribedRoots: roots.length,
    deduplicatedRoots: validatedRoots.length - roots.length,
    activeSubscriptions: countActiveSharedWatches(),
    registrySize: sharedWatchRegistry.size,
  });

  const attachRoot = async (rootPath: string) => {
    if (closed) return;
    const client: SharedWatchClient = {
      closed: false,
      enqueue,
      degrade: (reason) => {
        if (closed || !isResponseWritable(res)) {
          closeWatchStream();
          return;
        }
        enqueue({ type: 'rescan-required', path: rootPath, reason });
        flush();
        closeWatchStream();
        if (isResponseWritable(res)) res.end();
      },
    };
    attachedRoots.set(rootPath, client);
    const ok = await acquireSharedWatch(rootPath, client);
    if (closed) return;
    if (!ok) {
      const reason = sharedWatchRegistry.get(rootPath)?.failure ?? 'watch-unavailable';
      client.degrade(reason);
    }
  };

  for (const rootPath of roots) {
    if (closed) break;
    await attachRoot(rootPath);
  }

});

router.get('/cancel-slot', (req: Request, res: Response) => {
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const action = getRequestAction(req, 'cancel_io_slot');
  if (!requestSlotId) {
    res.status(400).json({ ok: false, error: 'Missing requestSlotId' });
    return;
  }

  const diff = activeDiffSlots.get(requestSlotId);
  const io = activeIoSlots.get(requestSlotId);
  if (diff) {
    diff.controller.abort(new SupersededRequestError('git.diff'));
    activeDiffSlots.delete(requestSlotId);
  }
  if (io) {
    io.controller.abort(new SupersededRequestError(io.op));
    activeIoSlots.delete(requestSlotId);
  }
  logFsIoEvent({
    action,
    op: 'io.cancel-slot',
    event: diff || io ? 'slot-cancelled' : 'slot-not-found',
    extra: {
      requestSlotId,
      diffRequestId: diff?.requestId,
      ioRequestId: io?.requestId,
      ioOp: io?.op,
    },
  });
  res.json({ ok: true, cancelled: Boolean(diff || io) });
});

// Fast recursive file search for the right sidebar.
// Prefer ripgrep because it respects .gitignore, skips ignored/build folders,
// and is dramatically faster than recursively calling readdir from the browser.
router.get('/search', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const controller = new AbortController();
  const requestedPath = req.query.path as string;
  const action = getRequestAction(req, 'search_files');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  let logged = false;
  const logSearch = (status: 'ok' | 'error', entry: Partial<Parameters<typeof logFsIo>[0]> = {}) => {
    if (logged) return;
    logged = true;
    logFsIo({
      id: requestId,
      action,
      op: 'fs.search',
      startedAt,
      status,
      path: requestedPath,
      ...entry,
      extra: { ...(entry.extra ?? {}), requestSlotId },
    });
  };
  req.on('close', () => controller.abort(new SupersededRequestError('fs.search')));
  registerIoSlot({ requestId, op: 'fs.search', action, slotId: requestSlotId, controller, path: requestedPath });
  try {
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const query = normalizeSearchQuery(req.query.query);
    if (!query) {
      logSearch('ok', { count: 0, total: 0, extra: { mode: 'empty' } });
      res.json({ path: requestedPath, query: '', entries: [], truncated: false, total: 0, engine: 'rg' });
      return;
    }

    const resolvedPath = await pathValidator.validatePathAsync(requestedPath);
    throwIfAborted(controller.signal, 'fs.search');
    const stat = await fs.promises.stat(resolvedPath);
    throwIfAborted(controller.signal, 'fs.search');
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' });
      return;
    }

    const showHidden = req.query.showHidden === 'true';
    const mode = req.query.mode === 'content' ? 'content' : 'name';
    const queryLower = query.toLowerCase();
    const excludePatterns = normalizeExcludePatterns(req.query.exclude);
    const contentOptions = {
      caseSensitive: req.query.caseSensitive === 'true',
      wholeWord: req.query.wholeWord === 'true',
      regex: req.query.regex === 'true',
    };

    if (mode === 'content') {
      if (req.query.stream !== 'true') {
        res.status(400).json({ error: 'Content search requires streaming', code: 'CONTENT_SEARCH_STREAM_ONLY' });
        return;
      }
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      writeSearchEvent(res, 'meta', { path: resolvedPath, query, engine: 'rg', mode: 'content', limited: false });
      try {
        const result = await streamContentSearchWithRipgrep(resolvedPath, query, showHidden, excludePatterns, contentOptions, controller.signal, res);
        if (!controller.signal.aborted && isResponseWritable(res)) {
          writeSearchEvent(res, 'done', { total: result.total, truncated: result.limited, limited: result.limited, engine: 'rg', mode: 'content' });
          logSearch('ok', { count: result.total, truncated: result.limited, extra: { mode: 'content', engine: 'rg' } });
          if (isResponseWritable(res)) res.end();
        }
      } catch (error) {
        if (controller.signal.aborted || !isResponseWritable(res)) {
          const payload = getErrorPayload(controller.signal.reason ?? error);
          logSearch('error', { code: payload.code, error: payload.error, extra: { mode: 'content', engine: 'rg' } });
          return;
        }
        const message = error instanceof Error ? error.message : 'Content search failed';
        logSearch('error', { code: 'CONTENT_SEARCH_UNAVAILABLE', error: message, extra: { mode: 'content', engine: 'rg' } });
        writeSearchEvent(res, 'error', { message, code: 'CONTENT_SEARCH_UNAVAILABLE' });
        if (isResponseWritable(res)) res.end();
      }
      return;
    }

    if (req.query.stream === 'true') {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      writeSearchEvent(res, 'meta', { path: resolvedPath, query, engine: 'rg', limited: false });
      try {
        const total = await streamSearchWithRipgrep(resolvedPath, queryLower, showHidden, excludePatterns, controller.signal, res);
        if (!controller.signal.aborted && isResponseWritable(res)) {
          writeSearchEvent(res, 'done', { total, truncated: false, limited: false, engine: 'rg' });
          logSearch('ok', { count: total, truncated: false, extra: { mode: 'name', engine: 'rg' } });
          if (isResponseWritable(res)) res.end();
        }
      } catch (error) {
        if (controller.signal.aborted || !isResponseWritable(res)) {
          const payload = getErrorPayload(controller.signal.reason ?? error);
          logSearch('error', { code: payload.code, error: payload.error, extra: { mode: 'name', engine: 'rg' } });
          return;
        }
        writeSearchEvent(res, 'meta', { path: resolvedPath, query, engine: 'fallback', limited: false });
        const result = await streamSearchWithFallback(resolvedPath, queryLower, showHidden, excludePatterns, controller.signal, res);
        if (!controller.signal.aborted && isResponseWritable(res)) {
          writeSearchEvent(res, 'done', { total: result.total, truncated: result.limited, limited: result.limited, engine: 'fallback' });
          logSearch('ok', { count: result.total, truncated: result.limited, extra: { mode: 'name', engine: 'fallback' } });
          if (isResponseWritable(res)) res.end();
        }
      }
      return;
    }

    try {
      const result = await searchWithRipgrep(resolvedPath, queryLower, showHidden, excludePatterns, controller.signal);
      logSearch('ok', { count: result.entries.length, total: result.total, truncated: result.truncated, extra: { mode: 'name', engine: result.engine } });
      res.json(result);
    } catch (error) {
      if (controller.signal.aborted) {
        const payload = getErrorPayload(controller.signal.reason ?? error);
        logSearch('error', { code: payload.code, error: payload.error, extra: { mode: 'name', engine: 'rg' } });
        return;
      }
      // Graceful fallback for machines without `rg` installed. It is bounded so
      // searching an enormous home directory cannot monopolize the server.
      const result = await searchWithFallback(resolvedPath, queryLower, showHidden, excludePatterns, controller.signal);
      logSearch('ok', { count: result.entries.length, total: result.total, truncated: result.truncated, extra: { mode: 'name', engine: result.engine } });
      res.json(result);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const payload = getErrorPayload(controller.signal.reason ?? error);
      logSearch('error', { code: payload.code, error: payload.error });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    logSearch('error', { error: message });
    res.status(403).json({ error: message });
  } finally {
    releaseIoSlot(requestSlotId, requestId);
  }
});

// Read file content
router.get('/read', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const requestedPath = req.query.path as string;
  const action = getRequestAction(req, 'view_file');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('fs.read'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  registerIoSlot({ requestId, op: 'fs.read', action, slotId: requestSlotId, controller, path: requestedPath });
  try {
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const result = await withTimeout((async () => {
      const resolvedPath = await pathValidator.validatePathAsync(requestedPath);
      throwIfAborted(controller.signal, 'fs.read');
      const stat = await fs.promises.stat(resolvedPath);
      throwIfAborted(controller.signal, 'fs.read');

      // 只允许常规文件：FIFO / unix socket / 设备文件的 open() 会永久占住
      // 一个 libuv 线程且不可取消（线程池耗尽 = 整个服务 IO 假死）。
      if (!stat.isFile()) {
        throw new Error('Path is not a regular file');
      }

      const bytesToRead = Math.min(stat.size, MAX_FILE_SIZE);
      const truncated = stat.size > bytesToRead;
      const buffer = await readBytesPrefix(resolvedPath, bytesToRead);
      // NUL-byte heuristic on the first 8KB: binary files (zip/elf/class/...)
      // contain a 0x00 byte very early, text files never do. This lets the
      // frontend show a "cannot preview" state instead of dumping garbled bytes.
      const binary = buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
      throwIfAborted(controller.signal, 'fs.read');
      return { resolvedPath, stat, buffer, binary, truncated };
    })(), FS_ROUTE_TIMEOUT_MS, 'File preview took too long. The file may be on slow storage or currently blocked by another process.', 'FS_READ_TIMEOUT');

    logFsIo({ id: requestId, action, op: 'fs.read', startedAt, status: 'ok', path: result.resolvedPath, bytes: Math.min(result.stat.size, MAX_FILE_SIZE), total: result.stat.size, truncated: result.truncated, extra: { requestSlotId } });
    res.json({
      path: result.resolvedPath,
      content: result.binary ? '' : result.buffer.toString('utf-8'),
      size: result.stat.size,
      modified: result.stat.mtime.toISOString(),
      truncated: result.binary ? false : result.truncated,
      binary: result.binary,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action, op: 'fs.read', startedAt, status: 'error', path: requestedPath, code: payload.code, error: payload.error, extra: { requestSlotId } });
    res.status(error instanceof OperationTimeoutError ? 504 : 403).json(payload);
  } finally {
    releaseIoSlot(requestSlotId, requestId);
  }
});

router.get('/git-blob', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const requestedPath = typeof req.query.path === 'string' ? req.query.path : undefined;
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
  const ref = typeof req.query.ref === 'string' ? req.query.ref : 'HEAD';
  const source = req.query.source === 'index' ? 'index' : 'ref';
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('git.blob'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  try {
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }
    if (source !== 'index' && !isSafeGitRefName(ref)) {
      res.status(400).json({ error: 'Invalid git ref' });
      return;
    }
    const resolvedCwd = cwd ? await pathValidator.validatePathAsync(cwd) : process.cwd();
    const refresh = req.query.refresh === 'true';
    const gitRoot = await findGitRoot(resolvedCwd, refresh ? null : GIT_TIMEOUT_MS);
    if (!gitRoot) {
      res.status(400).json({ error: 'Not a git repository' });
      return;
    }
    const pathspec = await toGitPathspec(gitRoot, requestedPath);
    const objectSpec = source === 'index' ? `:${pathspec}` : `${ref}:${pathspec}`;
    const result = await execGitLimited(['show', objectSpec], gitRoot, MAX_FILE_SIZE, false, controller.signal);
    logFsIo({ id: requestId, action: 'git_blob', op: 'git.blob', startedAt, status: 'ok', path: requestedPath, cwd, repoRoot: gitRoot, bytes: Buffer.byteLength(result.stdout), truncated: result.truncated });
    res.json({
      path: requestedPath,
      ref: source === 'index' ? ':index' : ref,
      source,
      content: result.truncated ? '' : result.stdout,
      truncated: result.truncated || undefined,
      size: Buffer.byteLength(result.stdout),
      maxBytes: result.truncated ? MAX_FILE_SIZE : undefined,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action: 'git_blob', op: 'git.blob', startedAt, status: 'error', path: requestedPath, cwd, code: payload.code, error: payload.error });
    res.status(error instanceof OperationTimeoutError ? 504 : 200).json({ path: requestedPath ?? null, content: '', ...payload });
  }
});

type EdaPreviewView = 'schematic' | 'pcb-front' | 'pcb-back' | 'pcb-3d';

const EDA_PREVIEW_VIEWS = new Set<EdaPreviewView>(['schematic', 'pcb-front', 'pcb-back', 'pcb-3d']);
const edaPreviewCache = new EdaPreviewCache(EDA_PREVIEW_CACHE_MAX_BYTES);

function runKicadCli(args: string[], cwd: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const proc = execFile('kicad-cli', args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abortHandler);
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve();
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      signal.removeEventListener('abort', abortHandler);
      reject(new OperationTimeoutError('KiCad preview rendering timed out.', 'EDA_PREVIEW_TIMEOUT'));
    }, EDA_PREVIEW_TIMEOUT_MS);
    const abortHandler = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      reject(signal.reason instanceof Error ? signal.reason : new SupersededRequestError('fs.eda-preview'));
    };
    if (signal.aborted) abortHandler();
    else signal.addEventListener('abort', abortHandler, { once: true });
  });
}

// Render native KiCad sources for Review. The source path is passed as an
// execFile argument (never through a shell), and every output lives in a
// request-scoped temporary directory which is deleted after the response.
router.get('/eda-preview', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const requestedPath = req.query.path as string;
  const requestedView = req.query.view as EdaPreviewView;
  const action = getRequestAction(req, 'view_file');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('fs.eda-preview'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  registerIoSlot({ requestId, op: 'fs.eda-preview', action, slotId: requestSlotId, controller, path: requestedPath });
  let tempDir: string | null = null;
  try {
    if (!requestedPath || !EDA_PREVIEW_VIEWS.has(requestedView)) {
      res.status(400).json({ error: 'Missing path or invalid KiCad preview view' });
      return;
    }
    const resolvedPath = await pathValidator.validatePathAsync(requestedPath);
    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isFile()) throw new Error('Path is not a file');

    const lowerPath = resolvedPath.toLowerCase();
    const isSchematic = lowerPath.endsWith('.kicad_sch');
    const isBoard = lowerPath.endsWith('.kicad_pcb');
    if (!isSchematic && !isBoard) {
      res.status(415).json({ error: 'Only .kicad_sch and .kicad_pcb previews are supported' });
      return;
    }
    if ((isSchematic && requestedView !== 'schematic') || (isBoard && requestedView === 'schematic')) {
      res.status(400).json({ error: 'Preview view does not match the KiCad file type' });
      return;
    }

    const versionKey = `${resolvedPath}\0${requestedView}\0${stat.size}\0${stat.mtimeMs}`;
    const etag = `"eda-${crypto.createHash('sha256').update(versionKey).digest('base64url').slice(0, 24)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Eda-View', requestedView);
    if (requestAcceptsEtag(req.headers['if-none-match'], etag)) {
      res.setHeader('X-Eda-Cache', 'revalidated');
      res.status(304).end();
      logFsIo({ id: requestId, action, op: 'fs.eda-preview', startedAt, status: 'ok', path: resolvedPath, bytes: 0, extra: { view: requestedView, requestSlotId, cache: 'revalidated' } });
      return;
    }

    const cached = edaPreviewCache.get(versionKey);
    if (cached) {
      res.setHeader('Content-Type', cached.mimeType);
      res.setHeader('Content-Length', String(cached.body.length));
      res.setHeader('X-Eda-Cache', 'hit');
      res.send(cached.body);
      logFsIo({ id: requestId, action, op: 'fs.eda-preview', startedAt, status: 'ok', path: resolvedPath, bytes: cached.body.length, extra: { view: requestedView, requestSlotId, cache: 'hit' } });
      return;
    }

    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'termdock-eda-preview-'));
    let outputPath: string;
    let mimeType: string;
    if (isSchematic) {
      await runKicadCli([
        'sch', 'export', 'svg', '--output', tempDir, '--pages', '1',
        '--exclude-drawing-sheet', '--no-background-color', resolvedPath,
      ], path.dirname(resolvedPath), controller.signal);
      const svgFiles = (await fs.promises.readdir(tempDir)).filter((name) => name.toLowerCase().endsWith('.svg')).sort();
      if (svgFiles.length === 0) throw new Error('KiCad did not produce a schematic SVG');
      outputPath = path.join(tempDir, svgFiles[0]);
      mimeType = 'image/svg+xml';
    } else if (requestedView === 'pcb-3d') {
      outputPath = path.join(tempDir, 'pcb-3d.glb');
      await runKicadCli([
        'pcb', 'export', 'glb', '--output', outputPath, '--force',
        '--include-tracks', '--include-pads', '--include-silkscreen', '--include-soldermask',
        resolvedPath,
      ], path.dirname(resolvedPath), controller.signal);
      mimeType = 'model/gltf-binary';
    } else {
      const front = requestedView === 'pcb-front';
      outputPath = path.join(tempDir, front ? 'pcb-front.svg' : 'pcb-back.svg');
      const layers = front
        ? 'F.Cu,F.Mask,F.Silkscreen,Edge.Cuts'
        : 'B.Cu,B.Mask,B.Silkscreen,Edge.Cuts';
      const args = [
        'pcb', 'export', 'svg', '--output', outputPath, '--mode-single', '--layers', layers,
        '--page-size-mode', '2', '--fit-page-to-board', '--exclude-drawing-sheet',
      ];
      if (!front) args.push('--mirror');
      args.push(resolvedPath);
      await runKicadCli(args, path.dirname(resolvedPath), controller.signal);
      mimeType = 'image/svg+xml';
    }

    const output = await fs.promises.readFile(outputPath);
    if (output.length > MAX_IMAGE_PREVIEW_SIZE) {
      res.status(413).json({ error: 'Rendered KiCad preview is too large' });
      return;
    }
    edaPreviewCache.set(versionKey, { body: output, mimeType });
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(output.length));
    res.setHeader('X-Eda-Cache', 'miss');
    res.send(output);
    logFsIo({ id: requestId, action, op: 'fs.eda-preview', startedAt, status: 'ok', path: resolvedPath, bytes: output.length, extra: { view: requestedView, requestSlotId, cache: 'miss' } });
  } catch (error) {
    const payload = getErrorPayload(error);
    if (!res.headersSent) {
      res.status(error instanceof OperationTimeoutError ? 504 : 403).json(payload);
    }
    logFsIo({ id: requestId, action, op: 'fs.eda-preview', startedAt, status: 'error', path: requestedPath, code: payload.code, error: payload.error, extra: { view: requestedView, requestSlotId } });
  } finally {
    releaseIoSlot(requestSlotId, requestId);
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

router.get('/eda-inspect', async (req: Request, res: Response) => {
  const requestedPath = req.query.path as string;
  const requestedView = req.query.view as EdaPreviewView;
  const xPercent = Number(req.query.x);
  const yPercent = Number(req.query.y);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new OperationTimeoutError('KiCad point inspection timed out.', 'EDA_INSPECT_TIMEOUT')), EDA_PREVIEW_TIMEOUT_MS);
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('fs.eda-inspect'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  try {
    if (!requestedPath || !EDA_PREVIEW_VIEWS.has(requestedView)
      || !Number.isFinite(xPercent) || !Number.isFinite(yPercent)
      || xPercent < 0 || xPercent > 100 || yPercent < 0 || yPercent > 100) {
      res.status(400).json({ error: 'Missing path, view, or valid preview coordinates' });
      return;
    }
    const resolvedPath = await pathValidator.validatePathAsync(requestedPath);
    if (!resolvedPath.toLowerCase().endsWith('.kicad_pcb')) {
      res.json({ available: false, reason: '只有 PCB 文件支持工程坐标' });
      return;
    }
    const result = await inspectKicadBoardPoint(resolvedPath, requestedView, xPercent, yPercent, controller.signal);
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    if (!res.headersSent) res.status(error instanceof OperationTimeoutError ? 504 : 500).json(getErrorPayload(error));
  } finally {
    clearTimeout(timeout);
  }
});

// Stream supported image files for the right sidebar preview.
router.get('/blob', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const requestedPath = req.query.path as string;
  const action = getRequestAction(req, 'view_file');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('fs.blob'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  registerIoSlot({ requestId, op: 'fs.blob', action, slotId: requestSlotId, controller, path: requestedPath });
  let logged = false;
  const logOnce = (status: 'ok' | 'error', entry: Partial<Parameters<typeof logFsIo>[0]> = {}) => {
    if (logged) return;
    logged = true;
    releaseIoSlot(requestSlotId, requestId);
    logFsIo({
      action,
      op: 'fs.blob',
      id: requestId,
      startedAt,
      status,
      path: requestedPath,
      ...entry,
      extra: { ...(entry.extra ?? {}), requestSlotId },
    });
  };
  try {
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const { resolvedPath, stat, mimeType } = await withTimeout((async () => {
      const resolvedPath = await pathValidator.validatePathAsync(requestedPath);
      throwIfAborted(controller.signal, 'fs.blob');
      const stat = await fs.promises.stat(resolvedPath);
      throwIfAborted(controller.signal, 'fs.blob');

      if (!stat.isFile()) {
        throw new Error('Path is not a file');
      }

      const mimeType = getImageMimeType(resolvedPath);
      if (!mimeType) {
        const error = new Error('Unsupported image type');
        (error as Error & { status?: number }).status = 415;
        throw error;
      }

      if (stat.size > MAX_IMAGE_PREVIEW_SIZE) {
        const error = new Error('Image is too large to preview');
        (error as Error & { code?: string; status?: number }).code = 'IMAGE_TOO_LARGE';
        (error as Error & { status?: number }).status = 413;
        throw error;
      }
      return { resolvedPath, stat, mimeType };
    })(), FS_ROUTE_TIMEOUT_MS, 'Image preview took too long. The file may be on slow storage or currently blocked by another process.', 'FS_BLOB_TIMEOUT');

    let responseBody: Buffer | null = null;
    let responseMimeType = mimeType;
    let responseFilename = path.basename(resolvedPath);
    if (isHeicPreviewPath(resolvedPath)) {
      responseBody = await withTimeout(
        convertHeicPreview(resolvedPath, controller.signal),
        HEIC_PREVIEW_TIMEOUT_MS,
        'HEIC preview conversion took too long.',
        'HEIC_PREVIEW_TIMEOUT',
        () => controller.abort(new OperationTimeoutError('HEIC preview conversion took too long.', 'HEIC_PREVIEW_TIMEOUT')),
      );
      if (responseBody.length > MAX_IMAGE_PREVIEW_SIZE) {
        const error = new Error('Converted image is too large to preview');
        (error as Error & { code?: string; status?: number }).code = 'IMAGE_TOO_LARGE';
        (error as Error & { status?: number }).status = 413;
        throw error;
      }
      responseMimeType = 'image/jpeg';
      responseFilename = `${path.basename(resolvedPath, path.extname(resolvedPath))}.jpg`;
    }

    const responseSize = responseBody?.length ?? stat.size;
    res.setHeader('Content-Type', responseMimeType);
    res.setHeader('Content-Length', responseSize.toString());
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', buildContentDisposition('inline', responseFilename));

    // Expose dimensions so markdown image previews can reserve the final
    // display box before downloading (loading placeholder without a jump).
    // Best-effort: parsing failure just omits the headers.
    const dimensions = responseBody
      ? parseImageDimensions(responseBody, responseMimeType)
      : await getImageDimensions(resolvedPath, responseMimeType).catch(() => null);
    if (dimensions) {
      res.setHeader('X-Image-Width', String(dimensions.width));
      res.setHeader('X-Image-Height', String(dimensions.height));
    }

    if (responseBody) {
      logOnce('ok', { path: resolvedPath, bytes: responseSize, extra: { mimeType: responseMimeType, sourceMimeType: mimeType } });
      res.end(responseBody);
      return;
    }

    const stream = fs.createReadStream(resolvedPath);
    controller.signal.addEventListener('abort', () => stream.destroy(controller.signal.reason instanceof Error ? controller.signal.reason : undefined), { once: true });
    res.on('finish', () => logOnce('ok', { path: resolvedPath, bytes: stat.size, extra: { mimeType: responseMimeType } }));
    res.on('close', () => {
      if (!res.writableEnded) logOnce('error', { path: resolvedPath, bytes: stat.size, code: 'CLIENT_CLOSED', error: 'Client closed image preview request' });
    });
    stream.on('error', (error) => {
      logOnce('error', { path: resolvedPath, code: 'FS_BLOB_STREAM_ERROR', error: error instanceof Error ? error.message : 'Failed to read image' });
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : 'Failed to read image';
        res.status(500).json({ error: message });
        return;
      }
      res.destroy(error instanceof Error ? error : undefined);
    });
    stream.pipe(res);
  } catch (error) {
    const payload = getErrorPayload(error);
    const status = error instanceof OperationTimeoutError
      ? 504
      : typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : 403;
    const code = payload.code ?? (typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined);
    logOnce('error', { code, error: payload.error });
    res.status(status).json({ ...payload, code });
  }
});

// Serve video files for the right-sidebar preview. The route streams with
// HTTP Range support, so <video> playback starts quickly and seeking works
// without buffering the whole file in the browser or server memory.
router.get('/video', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const requestedPath = req.query.path as string;
  const action = getRequestAction(req, 'view_file');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('fs.video'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  registerIoSlot({ requestId, op: 'fs.video', action, slotId: requestSlotId, controller, path: requestedPath });
  let logged = false;
  const logOnce = (status: 'ok' | 'error', entry: Partial<Parameters<typeof logFsIo>[0]> = {}) => {
    if (logged) return;
    logged = true;
    releaseIoSlot(requestSlotId, requestId);
    logFsIo({
      action,
      op: 'fs.video',
      id: requestId,
      startedAt,
      status,
      path: requestedPath,
      ...entry,
      extra: { ...(entry.extra ?? {}), requestSlotId },
    });
  };
  try {
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const { resolvedPath, stat, mimeType } = await withTimeout((async () => {
      const resolvedPath = await pathValidator.validatePathAsync(requestedPath);
      throwIfAborted(controller.signal, 'fs.video');
      const stat = await fs.promises.stat(resolvedPath);
      throwIfAborted(controller.signal, 'fs.video');

      if (!stat.isFile()) {
        throw new Error('Path is not a file');
      }

      const mimeType = getVideoMimeType(resolvedPath);
      if (!mimeType) {
        const error = new Error('Unsupported video type');
        (error as Error & { status?: number }).status = 415;
        throw error;
      }

      if (stat.size > MAX_VIDEO_PREVIEW_SIZE) {
        const error = new Error('Video is too large to preview');
        (error as Error & { code?: string; status?: number }).code = 'VIDEO_TOO_LARGE';
        (error as Error & { status?: number }).status = 413;
        throw error;
      }
      return { resolvedPath, stat, mimeType };
    })(), FS_ROUTE_TIMEOUT_MS, 'Video preview took too long. The file may be on slow storage or currently blocked by another process.', 'FS_VIDEO_TIMEOUT');

    const total = stat.size;
    const range = parseVideoRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, total);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', buildContentDisposition('inline', path.basename(resolvedPath)));

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', total.toString());
      if (range.kind === 'range') res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
      res.end();
      logOnce('ok', { path: resolvedPath, bytes: total, extra: { mimeType } });
      return;
    }

    if (range.kind === 'unsatisfiable') {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${total}`);
      res.end();
      logOnce('ok', { path: resolvedPath, bytes: 0, extra: { mimeType, status: 416 } });
      return;
    }

    if (range.kind === 'range') {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
      res.setHeader('Content-Length', total.toString());
    }

    const stream = fs.createReadStream(resolvedPath, range.kind === 'range' ? { start: range.start, end: range.end } : undefined);
    controller.signal.addEventListener('abort', () => stream.destroy(controller.signal.reason instanceof Error ? controller.signal.reason : undefined), { once: true });
    const bytesServed = range.kind === 'range' ? range.end - range.start + 1 : total;
    res.on('finish', () => logOnce('ok', { path: resolvedPath, bytes: bytesServed, extra: { mimeType } }));
    res.on('close', () => {
      if (!res.writableEnded) logOnce('error', { path: resolvedPath, bytes: bytesServed, code: 'CLIENT_CLOSED', error: 'Client closed video preview request' });
    });
    stream.on('error', (error) => {
      logOnce('error', { path: resolvedPath, code: 'FS_VIDEO_STREAM_ERROR', error: error instanceof Error ? error.message : 'Failed to read video' });
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : 'Failed to read video';
        res.status(500).json({ error: message });
        return;
      }
      res.destroy(error instanceof Error ? error : undefined);
    });
    stream.pipe(res);
  } catch (error) {
    const payload = getErrorPayload(error);
    const status = error instanceof OperationTimeoutError
      ? 504
      : typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : 403;
    const code = payload.code ?? (typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined);
    logOnce('error', { code, error: payload.error });
    res.status(status).json({ ...payload, code });
  }
});

// Serve workspace files for the right-sidebar HTML preview. The URL path
// mirrors the absolute filesystem path (e.g. .../preview/home/user/proj/
// index.html), so relative css/js/image references inside a document resolve
// to the file's own directory. To make that resolution explicit and engine-
// independent (some engines don't reliably resolve subresources against a
// sandboxed iframe's document URL), HTML documents get an injected <base href>
// equal to the document's own request URL — that keeps relative references
// working while also making in-page anchor links (#section) stay same-document
// instead of forcing a full reload. Other asset types keep streaming as-is.
//
// Authentication: browsers refuse to send cookies for subresource requests
// from a sandboxed iframe without allow-same-origin (Chrome blocks the 401
// responses as ORB), so with a password set the document loads but images
// don't. The preview route therefore authenticates document requests with the
// session cookie, then redirects them to a URL carrying a short-lived token
// bound to the previewed file's directory. Every relative subresource URL
// inherits that token from the document URL, so css/js/images load without
// cookies while the sandbox keeps previewed scripts on a separate origin.
// The frontend renders this in a sandboxed iframe (no allow-same-origin), so
// previewed scripts never gain the termdock origin.
const PREVIEW_TOKEN_TTL_MS = 30 * 60 * 1000;
const previewTokens = new Map<string, { root: string; expiresAt: number }>();

export function isPreviewToken(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

export function isPathWithinPreviewRoot(root: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(prefix);
}

// Sliding-expiry validation: a valid token refreshes its lifetime so a page
// that keeps loading subresources stays usable without re-authenticating.
export function validatePreviewToken(token: string, targetPath: string): boolean {
  const entry = previewTokens.get(token);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    previewTokens.delete(token);
    return false;
  }
  if (!isPathWithinPreviewRoot(entry.root, targetPath)) return false;
  entry.expiresAt = Date.now() + PREVIEW_TOKEN_TTL_MS;
  return true;
}

export function mintPreviewToken(root: string): string {
  const now = Date.now();
  for (const [token, entry] of previewTokens) {
    if (entry.expiresAt < now) previewTokens.delete(token);
  }
  const token = crypto.randomBytes(16).toString('hex');
  previewTokens.set(token, { root: path.resolve(root), expiresAt: now + PREVIEW_TOKEN_TTL_MS });
  return token;
}

function tokenizePreviewUrl(previewBaseUrl: string, token: string): string {
  return previewBaseUrl.replace(/^(\/api\/terminal\/fs\/preview\/)/, `$1${token}/`);
}

// Insert <base href> right after <head> (or after the doctype / at the very
// start when the document has no head). Documents that already declare their
// own <base> are left untouched so author intent wins.
export function injectHtmlPreviewBase(html: string, baseUrl: string): string {
  if (/<base\b/i.test(html)) return html;
  const baseTag = `<base href="${baseUrl}">`;
  const headMatch = html.match(/<head\b[^>]*>/i);
  if (headMatch && typeof headMatch.index === 'number') {
    const insertAt = headMatch.index + headMatch[0].length;
    return html.slice(0, insertAt) + baseTag + html.slice(insertAt);
  }
  const doctypeMatch = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctypeMatch) {
    return html.slice(0, doctypeMatch[0].length) + baseTag + html.slice(doctypeMatch[0].length);
  }
  return baseTag + html;
}

const HTML_PREVIEW_INDEX_FILES = ['index.html', 'index.htm'];

// Directory navigation in a previewed document (e.g. <a href="docs/">) should
// behave like a normal web server: serve the directory's index document when
// one exists. Returns the validated index file path, or null when the
// directory has no index to preview.
export async function findDirectoryIndexFile(dirPath: string): Promise<string | null> {
  for (const name of HTML_PREVIEW_INDEX_FILES) {
    const candidate = path.join(dirPath, name);
    try {
      const candidatePath = await pathValidator.validatePathAsync(candidate);
      const candidateStat = await fs.promises.stat(candidatePath);
      if (candidateStat.isFile()) return candidatePath;
    } catch {
      // Missing or not allowed — try the next index name.
    }
  }
  return null;
}

router.get('/preview/*path', async (req: Request, res: Response) => {
  try {
    const rawSegments = req.params.path;
    const segments: string[] = Array.isArray(rawSegments) ? rawSegments : rawSegments ? [rawSegments] : [];
    const firstSegment = segments[0];
    const maybeToken = firstSegment && isPreviewToken(firstSegment) ? firstSegment : null;
    const pathSegments = maybeToken ? segments.slice(1) : segments;
    const requestedPath = `/${pathSegments.join('/')}`;
    if (!requestedPath || requestedPath === '/') {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    // Raw (percent-encoded) full pathname as the browser sees it (baseUrl +
    // path, since this router is mounted under /api/terminal/fs); used as the
    // injected <base> so it always equals the document URL.
    const previewBaseUrl = req.originalUrl.split('?', 1)[0];
    const authEnabled = isAuthEnabled();

    // Token requests carry their own credential in the URL. Document requests
    // must present the session cookie before we mint a token for them.
    if (!maybeToken && authEnabled && !isRequestAuthenticated(req)) {
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      return;
    }

    const validatedPath = await pathValidator.validatePathAsync(requestedPath);
    let stat = await fs.promises.stat(validatedPath);

    let targetPath = validatedPath;
    let redirectUrl: string | null = null;
    if (stat.isDirectory()) {
      // Directory links must carry a trailing slash so relative references
      // inside the served index resolve within the directory, matching how a
      // normal web server behaves.
      if (!previewBaseUrl.endsWith('/')) {
        redirectUrl = `${previewBaseUrl}/`;
      } else {
        const indexPath = await findDirectoryIndexFile(validatedPath);
        if (!indexPath) {
          res.status(404).json({ error: 'Directory has no index file to preview', code: 'NO_INDEX' });
          return;
        }
        targetPath = indexPath;
        stat = await fs.promises.stat(targetPath);
      }
    }

    // Authenticated document requests get a short-lived token bound to the
    // previewed file's directory, so the sandboxed iframe's subresources can
    // load without cookies. The token segment in the URL is inherited by every
    // relative reference the document makes.
    if (authEnabled && !maybeToken) {
      const root = stat.isDirectory() ? validatedPath : path.dirname(validatedPath);
      const tokenized = tokenizePreviewUrl(previewBaseUrl, mintPreviewToken(root));
      redirectUrl = stat.isDirectory() && !previewBaseUrl.endsWith('/') ? `${tokenized}/` : tokenized;
    }

    if (redirectUrl) {
      res.redirect(302, redirectUrl);
      return;
    }

    if (!stat.isFile()) {
      res.status(400).json({ error: 'Path is not a file' });
      return;
    }

    if (maybeToken && !validatePreviewToken(maybeToken, targetPath)) {
      res.status(403).json({ error: 'Preview token invalid or expired', code: 'PREVIEW_TOKEN_INVALID' });
      return;
    }

    const mimeType = getHtmlPreviewMimeType(targetPath);
    if (!mimeType) {
      res.status(415).json({ error: 'Unsupported file type for preview' });
      return;
    }

    if (stat.size > MAX_HTML_PREVIEW_SIZE) {
      res.status(413).json({
        error: 'File is too large to preview',
        code: 'FILE_TOO_LARGE',
        size: stat.size,
        maxSize: MAX_HTML_PREVIEW_SIZE,
      });
      return;
    }

    const isHtml = path.extname(targetPath).toLowerCase() === '.html' || path.extname(targetPath).toLowerCase() === '.htm';

    if (isHtml) {
      // HTML is size-capped above; buffer it so we can inject <base> and send
      // an accurate Content-Length for the modified payload.
      const html = await fs.promises.readFile(targetPath, 'utf8');
      const served = injectHtmlPreviewBase(html, previewBaseUrl);
      const payload = Buffer.from(served, 'utf8');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', payload.length.toString());
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Preview URLs carry a short-lived token; never leak it to third-party
      // resources the previewed document loads (fonts, analytics, hotlinked
      // images) via the Referer header.
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Disposition', buildContentDisposition('inline', path.basename(targetPath)));
      res.end(payload);
      return;
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size.toString());
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Disposition', buildContentDisposition('inline', path.basename(targetPath)));

    const stream = fs.createReadStream(targetPath);
    stream.on('error', (error) => {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : 'Failed to serve file';
        res.status(500).json({ error: message });
        return;
      }
      res.destroy(error instanceof Error ? error : undefined);
    });
    stream.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(403).json({ error: message });
  }
});

// Download any file as an attachment. Works in both PWA and normal browser
// contexts — the frontend fetches this as a blob and either pipes it through
// the File System Access API (showSaveFilePicker, desktop PWA/Chromium) or
// falls back to an <a download> blob URL.
router.get('/download', async (req: Request, res: Response) => {
  try {
    const requestedPath = req.query.path as string;
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const resolvedPath = await pathValidator.validatePathAsync(requestedPath);
    const stat = await fs.promises.stat(resolvedPath);

    if (!stat.isFile()) {
      res.status(400).json({ error: 'Path is not a file' });
      return;
    }

    if (stat.size > MAX_DOWNLOAD_SIZE) {
      res.status(413).json({
        error: 'File is too large to download',
        code: 'FILE_TOO_LARGE',
        size: stat.size,
        maxSize: MAX_DOWNLOAD_SIZE,
      });
      return;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size.toString());
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', buildContentDisposition('attachment', path.basename(resolvedPath)));

    const stream = fs.createReadStream(resolvedPath);
    stream.on('error', (error) => {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : 'Failed to download file';
        res.status(500).json({ error: message });
        return;
      }
      res.destroy(error instanceof Error ? error : undefined);
    });
    stream.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(403).json({ error: message });
  }
});

// Delete one file after an explicit client confirmation. Directories are never
// removed by this endpoint; symbolic links are unlinked without following them.
router.delete('/file', async (req: Request, res: Response) => {
  try {
    const requestedPath = req.query.path as string;
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }
    if (req.query.confirm !== 'true') {
      res.status(400).json({ error: 'File deletion requires confirmation', code: 'CONFIRMATION_REQUIRED' });
      return;
    }

    const deletedPath = await deleteFilesystemFile(requestedPath);
    res.json({ ok: true, path: deletedPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    res.status(code === 'ENOENT' ? 404 : message === 'Path is not a file' ? 400 : 403).json({ error: message, code });
  }
});

// Git diff for a file or the entire repo
router.get('/diff', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const inflight = updateInflight('git.diff', 1);
  const startedAt = Date.now();
  const requestedPath = req.query.path as string | undefined;
  const cwd = req.query.cwd as string | undefined;
  const traceId = typeof req.query.traceId === 'string' ? req.query.traceId : undefined;
  const interactionId = typeof req.query.interactionId === 'string' ? req.query.interactionId : undefined;
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const action = getRequestAction(req, requestedPath ? 'view_diff' : 'view_all_changes');
  const diffOptions = {
    algorithm: getGitDiffAlgorithm(req.query.algorithm),
    whitespace: getGitDiffWhitespaceMode(req.query.whitespace),
    context: getGitDiffContextLines(req.query.context),
  };
  const diffOptionArgs = buildGitDiffOptionArgs(diffOptions);
  const controller = new AbortController();
  let requestClosed = false;
  const abortRequest = (event: string) => {
    if (requestClosed) return;
    requestClosed = true;
    logFsIoEvent({ id: requestId, action, op: 'git.diff', event, path: requestedPath, cwd, repoRoot: gitCwdForLog, requestClosed: true, extra: { traceId } });
    controller.abort();
  };
  req.on('aborted', () => abortRequest('request-aborted'));
  res.on('close', () => {
    if (!res.writableEnded) abortRequest('response-close-before-end');
  });
  const isConcreteFileDiff = Boolean(requestedPath);
  const diffTimeoutMs = isConcreteFileDiff ? GIT_FILE_DIFF_ROUTE_TIMEOUT_MS : GIT_ROUTE_TIMEOUT_MS;
  const diffTimeoutMessage = isConcreteFileDiff
    ? 'Git diff is still running for this file. It may be blocked by repository IO or another Git process.'
    : 'Git diff took too long. The repository may be busy, on slow storage, or locked by another Git process.';
  let gitCwdForLog: string | null = null;
  if (requestSlotId && action === 'view_diff') {
    const previous = activeDiffSlots.get(requestSlotId);
    if (previous && previous.requestId !== requestId) {
      previous.controller.abort(new GitCommandAbortError('superseded by newer diff request'));
      logFsIoEvent({ id: requestId, action, op: 'git.diff', event: 'slot-cancel-previous', path: requestedPath, cwd, extra: { traceId, interactionId, requestSlotId, previousRequestId: previous.requestId } });
      writeDiffTraceLog({
        source: 'server.git-diff',
        event: 'slot-cancel-previous',
        requestId,
        action,
        traceId,
        interactionId,
        requestSlotId,
        previousRequestId: previous.requestId,
        filePath: requestedPath,
        cwd,
      });
    }
    activeDiffSlots.set(requestSlotId, { controller, requestId });
  }
  logFsIoEvent({ id: requestId, action, op: 'git.diff', event: 'request-start', path: requestedPath, cwd, extra: { inflight, traceId, interactionId, requestSlotId, ...diffOptions } });
  writeDiffTraceLog({
    source: 'server.git-diff',
    event: 'request-start',
    requestId,
    action,
    traceId,
    interactionId,
    requestSlotId,
    filePath: requestedPath,
    cwd,
    inflight,
    diffOptions,
  });
  try {
    const result = await withTimeout((async () => {
      const cached = req.query.cached === 'true';

      // Determine the git working directory
      let gitCwd: string | null;
      if (requestedPath && path.isAbsolute(requestedPath)) {
        const resolvedPath = await pathValidator.validatePathAsync(requestedPath);
        const stat = await fs.promises.stat(resolvedPath).catch(() => null);
        gitCwd = await findGitRoot(stat?.isDirectory() ? resolvedPath : path.dirname(resolvedPath));
      } else if (cwd) {
        const resolvedCwd = await pathValidator.validatePathAsync(cwd);
        gitCwd = await findGitRoot(resolvedCwd);
      } else {
        gitCwd = null;
      }
      gitCwdForLog = gitCwd;
      logFsIoEvent({ id: requestId, action, op: 'git.diff', event: 'git-root-resolved', path: requestedPath, cwd, repoRoot: gitCwd, requestClosed, extra: { traceId, interactionId } });
      writeDiffTraceLog({
        source: 'server.git-diff',
        event: 'git-root-resolved',
        requestId,
        action,
        traceId,
        interactionId,
        requestSlotId,
        filePath: requestedPath,
        cwd,
        gitRoot: gitCwd,
        requestClosed,
      });

      if (!gitCwd) {
        return { payload: { path: requestedPath ?? null, diff: '', error: 'Not a git repository' } satisfies DiffResponsePayload, pathspec: null };
      }

      const pathspec = requestedPath ? await toGitPathspec(gitCwd, requestedPath) : null;
      const skippedFiles: DiffSkippedFile[] = [];

      // The complete sidebar review requests every changed file at once. Git's
      // output cap cannot prevent the work needed to classify a huge binary, so
      // cheaply inspect the working-tree prefix before starting Git. Images are
      // intentionally exempt because the sidebar has a dedicated preview path.
      if (pathspec && !getImageMimeType(pathspec)) {
        const candidatePath = path.resolve(gitCwd, pathspec);
        const inspection = isPathInside(gitCwd, candidatePath)
          ? await inspectBinaryFile(candidatePath)
          : null;
        throwIfAborted(controller.signal, 'git.diff');
        if (inspection?.binary) {
          skippedFiles.push(makeSkippedBinary(pathspec, inspection.size));
          return {
            payload: {
              path: requestedPath ?? null,
              diff: '',
              size: 0,
              skippedFiles,
              truncated: true,
            } satisfies DiffResponsePayload,
            pathspec,
          };
        }
      }

      const buildDiffArgs = (includeCached: boolean) => {
        const args = ['diff', '-M', ...diffOptionArgs];
        if (includeCached) args.push('--cached');
        if (pathspec) args.push('--', pathspec);
        return args;
      };

      // Use `git diff HEAD` to present a merged view of all worktree changes
      // (staged + unstaged) against HEAD. Untracked files are handled separately
      // with `--no-index` below.
      let truncatedByGit = false;
      const readLimitedDiff = async (args: string[], maxBytes = MAX_DIFF_BYTES) => {
        const gitResult = await execGitLimited(args, gitCwd, maxBytes, false, controller.signal, { id: requestId, action, op: 'git.diff', path: requestedPath, extra: { traceId, interactionId, requestSlotId } });
        if (gitResult.truncated) truncatedByGit = true;
        return gitResult.stdout;
      };
      const readLimitedNoIndexDiff = async (args: string[], maxBytes = MAX_DIFF_BYTES) => {
        const gitResult = await execGitLimited(args, gitCwd, maxBytes, true, controller.signal, { id: requestId, action, op: 'git.diff', path: requestedPath, extra: { traceId, interactionId, requestSlotId } });
        if (gitResult.truncated) truncatedByGit = true;
        return gitResult.stdout;
      };

      const buildHeadDiffArgs = () => {
        const args = ['diff', '-M', ...diffOptionArgs, 'HEAD'];
        if (pathspec) args.push('--', pathspec);
        return args;
      };

      let diff = cached
        ? await readLimitedDiff(buildDiffArgs(true))
        : await readLimitedDiff(buildHeadDiffArgs());

      let totalBytes = getDiffByteLength(diff);

      // If git diff produced no output for a specific file, it might be an
      // untracked (new) file.  Use `git diff --no-index /dev/null <path>` to
      // show the entire file contents as additions, but never for very large
      // files — that would turn a preview request into a full-file transfer.
      // Note: git diff --no-index exits with code 1 when there are differences,
      // but stdout still contains the valid diff text.
      if (!diff && requestedPath && !cached && pathspec) {
        const size = await getRelativeFileSize(gitCwd, pathspec);
        if (size !== null && size > MAX_UNTRACKED_DIFF_FILE_BYTES) {
          skippedFiles.push(makeSkippedUntracked(pathspec, size));
        } else {
          diff = await readLimitedNoIndexDiff(['diff', '--no-index', ...diffOptionArgs, '--', '/dev/null', pathspec]);
          totalBytes = getDiffByteLength(diff);
        }
      }

      // When viewing the full repo diff (no specific file), also append diffs
      // for untracked files — `git diff` silently skips them. Keep both per-file
      // and aggregate byte caps so an accidental large generated file doesn't
      // dominate the network response or freeze react-diff-view parsing.
      if (!requestedPath && !cached && totalBytes <= MAX_DIFF_BYTES) {
        const untracked = await execGit(['ls-files', '--others', '--exclude-standard', '-z'], gitCwd, controller.signal).catch(emptyOnNonAbortGitError);
        for (const p of untracked.split('\0').filter(Boolean)) {
          const size = await getRelativeFileSize(gitCwd, p);
          if (size !== null && size > MAX_UNTRACKED_DIFF_FILE_BYTES) {
            skippedFiles.push(makeSkippedUntracked(p, size));
            continue;
          }
          const partial = await readLimitedNoIndexDiff(['diff', '--no-index', ...diffOptionArgs, '--', '/dev/null', p], MAX_UNTRACKED_DIFF_FILE_BYTES);
          if (!partial) continue;
          const nextDiff = diff ? `${diff}\n${partial}` : partial;
          const nextBytes = getDiffByteLength(nextDiff);
          if (nextBytes > MAX_DIFF_BYTES) {
            skippedFiles.push({ path: p, reason: 'diff-byte-limit-exceeded', size: getDiffByteLength(partial), maxBytes: MAX_DIFF_BYTES });
            break;
          }
          diff = nextDiff;
          totalBytes = nextBytes;
        }
      }

      return {
        payload: truncateDiffIfNeeded({
          path: requestedPath ?? null,
          diff: truncatedByGit ? '' : diff,
          skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
          truncated: skippedFiles.length > 0 || truncatedByGit ? true : undefined,
          tooLarge: truncatedByGit ? true : undefined,
          maxBytes: truncatedByGit ? MAX_DIFF_BYTES : undefined,
        }),
        pathspec,
      };
    })(), diffTimeoutMs, diffTimeoutMessage, 'GIT_DIFF_TIMEOUT', () => controller.abort(new OperationTimeoutError(diffTimeoutMessage, 'GIT_DIFF_TIMEOUT')));

    logFsIo({
      id: requestId,
      action,
      op: 'git.diff',
      startedAt,
      status: result.payload.error ? 'error' : 'ok',
      path: requestedPath,
      cwd,
      repoRoot: gitCwdForLog,
      bytes: getDiffByteLength(result.payload.diff),
      truncated: Boolean(result.payload.truncated),
      code: result.payload.error ? 'GIT_DIFF_ERROR' : undefined,
      error: result.payload.error,
      extra: { traceId, interactionId, pathspec: result.pathspec, tooLarge: Boolean(result.payload.tooLarge) },
    });
    writeDiffTraceLog({
      source: 'server.git-diff',
      event: result.payload.error ? 'response-error' : 'response-ok',
      requestId,
      action,
      traceId,
      interactionId,
      requestSlotId,
      filePath: requestedPath,
      cwd,
      gitRoot: gitCwdForLog,
      durationMs: Date.now() - startedAt,
      bytes: getDiffByteLength(result.payload.diff),
      truncated: Boolean(result.payload.truncated),
      error: result.payload.error,
      pathspec: result.pathspec,
      tooLarge: Boolean(result.payload.tooLarge),
    });
    res.json(result.payload);
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action, op: 'git.diff', startedAt, status: 'error', path: requestedPath, cwd, repoRoot: gitCwdForLog, code: payload.code, error: payload.error, extra: { traceId, interactionId, requestClosed } });
    writeDiffTraceLog({
      source: 'server.git-diff',
      event: 'response-exception',
      requestId,
      action,
      traceId,
      interactionId,
      requestSlotId,
      filePath: requestedPath,
      cwd,
      gitRoot: gitCwdForLog,
      durationMs: Date.now() - startedAt,
      error: payload.error,
      code: payload.code,
      requestClosed,
    });
    res.status(error instanceof OperationTimeoutError ? 504 : 200).json({ path: req.query.path ?? null, diff: '', ...payload });
  } finally {
    if (requestSlotId && activeDiffSlots.get(requestSlotId)?.requestId === requestId) {
      activeDiffSlots.delete(requestSlotId);
    }
    updateInflight('git.diff', -1);
    logFsIoEvent({ id: requestId, action, op: 'git.diff', event: 'request-end', path: requestedPath, cwd, repoRoot: gitCwdForLog, requestClosed, extra: { traceId, interactionId, requestSlotId } });
    writeDiffTraceLog({
      source: 'server.git-diff',
      event: 'request-end',
      requestId,
      action,
      traceId,
      interactionId,
      requestSlotId,
      filePath: requestedPath,
      cwd,
      gitRoot: gitCwdForLog,
      requestClosed,
    });
  }
});

// List changed files across staged, unstaged, and untracked state.
router.get('/diff-files', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const cwd = req.query.cwd as string | undefined;
  const action = getRequestAction(req, 'load_diff_files');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('git.diff-files'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  registerIoSlot({ requestId, op: 'git.diff-files', action, slotId: requestSlotId, controller, cwd });
  let gitRootForLog: string | null = null;
  try {
    if (!cwd) {
      res.json({ files: [], error: 'No cwd provided' });
      return;
    }

    const resolvedCwd = await pathValidator.validatePathAsync(cwd);
    throwIfAborted(controller.signal, 'git.diff-files');
    const gitCwd = await findGitRoot(resolvedCwd);
    throwIfAborted(controller.signal, 'git.diff-files');
    gitRootForLog = gitCwd;
    if (!gitCwd) {
      res.json({ files: [], error: 'Not a git repository' });
      return;
    }

    const changedResult = await withTimeout(
      getChangedFiles(gitCwd, controller.signal, { includeUntracked: false }),
      GIT_ROUTE_TIMEOUT_MS,
      'Git file list took too long. The repository may be busy, on slow storage, or locked by another Git process.',
      'GIT_DIFF_FILES_TIMEOUT',
      () => controller.abort(new OperationTimeoutError('Git file list took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_DIFF_FILES_TIMEOUT')),
    );
    const files = changedResult.files;
    logFsIo({ id: requestId, action, op: 'git.diff-files', startedAt, status: 'ok', cwd: resolvedCwd, repoRoot: gitCwd, count: files.length, extra: { requestSlotId } });
    res.json({ files });
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action, op: 'git.diff-files', startedAt, status: 'error', cwd, repoRoot: gitRootForLog, code: payload.code, error: payload.error, extra: { requestSlotId } });
    res.json({ files: [], ...payload });
  } finally {
    releaseIoSlot(requestSlotId, requestId);
  }
});

router.get('/untracked-files', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const cwd = req.query.cwd as string | undefined;
  const action = getRequestAction(req, 'load_untracked_files');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  let gitRootForLog: string | null = null;
  try {
    if (!cwd) {
      res.json({ status: 'error', files: [], error: 'No cwd provided' });
      return;
    }
    const resolvedCwd = await pathValidator.validatePathAsync(cwd);
    const gitRoot = await findGitRoot(resolvedCwd);
    gitRootForLog = gitRoot;
    if (!gitRoot) {
      res.json({ status: 'error', files: [], error: 'Not a git repository' });
      return;
    }

    let nestedDisplayRoots = new Set<string>();
    try {
      const discovered = await getCachedNestedGitRoots(gitRoot);
      nestedDisplayRoots = buildNestedRepoDisplayRootSet(gitRoot, discovered.repositories);
    } catch {
      // Best-effort only. The untracked scan should still return useful data
      // even if nested repository discovery is cancelled or times out.
    }
    const payload = startUntrackedJob(gitRoot, nestedDisplayRoots);
    logFsIo({
      id: requestId,
      action,
      op: 'git.untracked',
      startedAt,
      status: payload.status === 'error' ? 'error' : 'ok',
      cwd: resolvedCwd,
      repoRoot: gitRoot,
      count: payload.files.length,
      code: payload.code,
      error: payload.error,
      extra: { requestSlotId, jobStatus: payload.status },
    });
    res.json(payload);
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action, op: 'git.untracked', startedAt, status: 'error', cwd, repoRoot: gitRootForLog, code: payload.code, error: payload.error, extra: { requestSlotId } });
    res.status(200).json({ status: 'error', files: [], ...payload });
  }
});

// Lightweight git context for AI prompts / multi-agent handoff
router.get('/git-context', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const cwd = req.query.cwd as string | undefined;
  const action = getRequestAction(req, 'load_git_details');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('git.context'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  let gitRootForLog: string | null = null;
  registerIoSlot({ requestId, op: 'git.context', action, slotId: requestSlotId, controller, cwd });
  try {
    if (!cwd) {
      res.json({ available: false, error: 'No cwd provided' });
      return;
    }

    const resolvedCwd = await pathValidator.validatePathAsync(cwd);
    throwIfAborted(controller.signal, 'git.context');
    const gitRoot = await findGitRoot(resolvedCwd);
    throwIfAborted(controller.signal, 'git.context');
    gitRootForLog = gitRoot;
    if (!gitRoot) {
      logFsIo({ action, op: 'git.context', startedAt, status: 'error', cwd: resolvedCwd, repoRoot: null, code: 'NOT_GIT_REPOSITORY', error: 'Not a git repository' });
      res.json({ available: false, cwd: resolvedCwd, error: 'Not a git repository', code: 'NOT_GIT_REPOSITORY' });
      return;
    }

    const result = await withTimeout((async () => {
      throwIfAborted(controller.signal, 'git.context');
      const [branchOutput, statusOutput, pushTargets] = await Promise.all([
        execGit(['branch', '--show-current'], gitRoot, controller.signal).catch(emptyOnNonAbortGitError),
        execGit(['status', '--short', '--branch'], gitRoot, controller.signal).catch(emptyOnNonAbortGitError),
        getGitPushTargets(gitRoot, controller.signal),
      ]);
      throwIfAborted(controller.signal, 'git.context');

      const files = (await getChangedFiles(gitRoot, controller.signal, { includeUntracked: false })).files;
      throwIfAborted(controller.signal, 'git.context');
      const changedFiles = toContextFiles(files);
      return { branchOutput, statusOutput, pushTargets, changedFiles };
    })(), GIT_ROUTE_TIMEOUT_MS, 'Git details took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_CONTEXT_TIMEOUT', () => controller.abort(new OperationTimeoutError('Git details took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_CONTEXT_TIMEOUT')));

    logFsIo({ id: requestId, action, op: 'git.context', startedAt, status: 'ok', cwd: resolvedCwd, repoRoot: gitRoot, count: result.changedFiles.length, truncated: result.changedFiles.length >= MAX_GIT_CONTEXT_CHANGED_FILES, extra: { requestSlotId } });
    res.json({
      available: true,
      cwd: resolvedCwd,
      root: gitRoot,
      branch: result.branchOutput.trim() || null,
      ...result.pushTargets,
      status: result.statusOutput.trim(),
      changedFiles: result.changedFiles,
      truncated: result.changedFiles.length >= MAX_GIT_CONTEXT_CHANGED_FILES,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action, op: 'git.context', startedAt, status: 'error', cwd, repoRoot: gitRootForLog, code: payload.code, error: payload.error, extra: { requestSlotId } });
    res.status(error instanceof OperationTimeoutError ? 504 : 200).json({ available: false, ...payload });
  } finally {
    releaseIoSlot(requestSlotId, requestId);
  }
});

// Combined payload for sidebar open — returns diff-files and git-context
// in one round-trip. Front-end fires this once when opening the right
// sidebar instead of two parallel requests, and the server reuses the
// resolved git root rather than running `rev-parse` twice.
router.get('/git-bundle', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const inflight = updateInflight('git.bundle', 1);
  const startedAt = Date.now();
  const cwd = req.query.cwd as string | undefined;
  const action = getRequestAction(req, req.query.refresh === 'true' ? 'manual_git_refresh' : 'open_sidebar_git_refresh');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('git.bundle'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  let gitRootForLog: string | null = null;
  registerIoSlot({ requestId, op: 'git.bundle', action, slotId: requestSlotId, controller, cwd });
  logFsIoEvent({ id: requestId, action, op: 'git.bundle', event: 'request-start', cwd, extra: { inflight, requestSlotId, includeNestedQuery: req.query.includeNested === 'true', refreshQuery: req.query.refresh === 'true' } });
  try {
    const refresh = req.query.refresh === 'true';
    const cacheOnly = req.query.cacheOnly === 'true';
    const includeNested = req.query.includeNested === 'true';
    if (!cwd) {
      res.json({ available: false, files: [], context: null, error: 'No cwd provided' });
      return;
    }

    const resolvedCwd = await pathValidator.validatePathAsync(cwd);
    throwIfAborted(controller.signal, 'git.bundle');
    const gitRoot = await findGitRoot(resolvedCwd, refresh ? null : GIT_TIMEOUT_MS);
    throwIfAborted(controller.signal, 'git.bundle');
    gitRootForLog = gitRoot;
    if (!gitRoot) {
      const payload = {
        available: false,
        files: [],
        context: { available: false, cwd: resolvedCwd, error: 'Not a git repository', code: 'NOT_GIT_REPOSITORY' },
        code: 'NOT_GIT_REPOSITORY',
      };
      logFsIo({ id: requestId, action, op: 'git.bundle', startedAt, status: 'error', cwd: resolvedCwd, repoRoot: null, code: 'NOT_GIT_REPOSITORY', error: 'Not a git repository' });
      res.json(payload);
      return;
    }
    logFsIoEvent({ id: requestId, action, op: 'git.bundle', event: 'git-root-resolved', cwd: resolvedCwd, repoRoot: gitRoot, extra: { requestSlotId, includeNested, refresh, cacheOnly } });
    const allowStale = !refresh;
    const cachedBundle = allowStale && includeNested ? getGitBundleCache(gitRoot, true, true) : null;
    const effectiveIncludeNested = includeNested;
    const nestedDeferred = false;

    if (cacheOnly) {
      const bundle = cachedBundle ?? getGitBundleCache(gitRoot, effectiveIncludeNested, true);
      const payload = bundle ?? {
        available: true,
        files: [],
        context: { available: true, cwd: resolvedCwd, root: gitRoot, changedFiles: [] },
        repositories: [],
        repoFilters: [],
        cached: false,
        stale: true,
        cacheAgeMs: undefined,
      };
      logFsIo({
        id: requestId,
        action,
        op: 'git.bundle',
        startedAt,
        status: payload.error ? 'error' : 'ok',
        cwd: resolvedCwd,
        repoRoot: gitRoot,
        count: payload.files.length,
        code: payload.error ? 'GIT_BUNDLE_ERROR' : undefined,
        error: payload.error,
        truncated: Boolean(payload.truncatedRepositories),
        extra: { requestSlotId, repositories: payload.repositories?.length ?? 1, includeNested: effectiveIncludeNested, requestedIncludeNested: includeNested, nestedDeferred, untrackedDeferred: Boolean(payload.untrackedDeferred), refresh, cacheOnly, cached: Boolean(payload.cached), stale: Boolean(payload.stale), cacheAgeMs: payload.cacheAgeMs },
      });
      res.json(payload);
      return;
    }

    const bundle = cachedBundle ?? (refresh
      ? await refreshGitBundleCacheDetached(resolvedCwd, gitRoot, effectiveIncludeNested, { gitTimeoutMs: null })
      : await withTimeout(
        getCachedGitBundle(resolvedCwd, gitRoot, effectiveIncludeNested, false, allowStale, controller.signal),
        GIT_ROUTE_TIMEOUT_MS,
        'Git status refresh took too long. The repository may be busy, on slow storage, or locked by another Git process.',
        'GIT_BUNDLE_TIMEOUT',
        () => controller.abort(new OperationTimeoutError('Git status refresh took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_BUNDLE_TIMEOUT')),
      ));
    logFsIo({
      id: requestId,
      action,
      op: 'git.bundle',
      startedAt,
      status: bundle.error ? 'error' : 'ok',
      cwd: resolvedCwd,
      repoRoot: gitRoot,
      count: bundle.files.length,
      code: bundle.error ? 'GIT_BUNDLE_ERROR' : undefined,
      error: bundle.error,
      truncated: Boolean(bundle.truncatedRepositories),
      extra: { requestSlotId, repositories: bundle.repositories?.length ?? 1, includeNested: effectiveIncludeNested, requestedIncludeNested: includeNested, nestedDeferred, untrackedDeferred: Boolean(bundle.untrackedDeferred), refresh, cacheOnly, cached: Boolean(bundle.cached), stale: Boolean(bundle.stale), cacheAgeMs: bundle.cacheAgeMs },
    });
    res.json(bundle);
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action, op: 'git.bundle', startedAt, status: 'error', cwd, repoRoot: gitRootForLog, code: payload.code, error: payload.error, extra: { requestSlotId } });
    res.status(error instanceof OperationTimeoutError ? 504 : 200).json({ available: false, files: [], context: null, ...payload });
  } finally {
    releaseIoSlot(requestSlotId, requestId);
    updateInflight('git.bundle', -1);
    logFsIoEvent({ id: requestId, action, op: 'git.bundle', event: 'request-end', cwd, repoRoot: gitRootForLog, extra: { requestSlotId } });
  }
});

router.get('/change-audit', (req: Request, res: Response) => {
  const workspaceRoot = typeof req.query.workspaceRoot === 'string' ? req.query.workspaceRoot : null;
  const repoRoot = typeof req.query.repoRoot === 'string' ? req.query.repoRoot : null;
  res.json(listChangeAuditRecords({ workspaceRoot, repoRoot }));
});

router.delete('/change-audit', (req: Request, res: Response) => {
  const body = req.body as { ids?: unknown; workspaceRoot?: unknown; repoRoot?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : undefined;
  const workspaceRoot = typeof body.workspaceRoot === 'string' ? body.workspaceRoot : null;
  const repoRoot = typeof body.repoRoot === 'string' ? body.repoRoot : null;
  if ((!ids || ids.length === 0) && !workspaceRoot && !repoRoot) {
    res.status(400).json({ error: 'Expected ids, workspaceRoot, or repoRoot to clear change audit explanations' });
    return;
  }
  res.json({ ok: true, ...clearChangeAuditRecords({ ids, workspaceRoot, repoRoot }) });
});

router.get('/branch-diff', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
  const requestedRepoRoot = typeof req.query.repoRoot === 'string' ? req.query.repoRoot : undefined;
  const baseBranch = typeof req.query.base === 'string' ? req.query.base : '';
  const headRef = typeof req.query.head === 'string' ? req.query.head : null;
  const includeUncommitted = req.query.includeUncommitted !== '0' && req.query.includeUncommitted !== 'false';
  const action = getRequestAction(req, 'load_branch_diff');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('git.branch-diff'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  let repoRootForLog: string | null = null;
  registerIoSlot({ requestId, op: 'git.branch-diff', action, slotId: requestSlotId, controller, cwd: requestedRepoRoot ?? cwd });
  try {
    if (!cwd && !requestedRepoRoot) {
      res.json({ available: false, error: 'No cwd provided' });
      return;
    }
    const resolvedCwd = await pathValidator.validatePathAsync(cwd ?? requestedRepoRoot ?? '');
    throwIfAborted(controller.signal, 'git.branch-diff');
    const workspaceGitRoot = await findGitRoot(resolvedCwd);
    throwIfAborted(controller.signal, 'git.branch-diff');
    if (!workspaceGitRoot) {
      res.json({ available: false, workspaceRoot: resolvedCwd, error: 'Not a git repository' });
      return;
    }
    const repoRoot = requestedRepoRoot ? await pathValidator.validatePathAsync(requestedRepoRoot) : workspaceGitRoot;
    if (!(await isWorkspaceGitRepositoryRoot(workspaceGitRoot, repoRoot, controller.signal))) {
      res.status(400).json({ available: false, error: 'Repository is outside current workspace' });
      return;
    }
    const actualRepoRoot = await findGitRoot(repoRoot);
    if (!actualRepoRoot || actualRepoRoot !== repoRoot) {
      res.status(400).json({ available: false, error: 'Repository root is invalid' });
      return;
    }
    repoRootForLog = repoRoot;
    const payload = await withTimeout(
      getBranchDiffPayload(workspaceGitRoot, repoRoot, baseBranch, { headRef, includeUncommitted }, controller.signal),
      GIT_FILE_DIFF_ROUTE_TIMEOUT_MS,
      'Branch diff took too long. The repository may be busy, on slow storage, or locked by another Git process.',
      'GIT_BRANCH_DIFF_TIMEOUT',
      () => controller.abort(new OperationTimeoutError('Branch diff took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_BRANCH_DIFF_TIMEOUT')),
    );
    logFsIo({
      id: requestId,
      action,
      op: 'git.branch-diff',
      startedAt,
      status: payload.available ? 'ok' : 'error',
      cwd: resolvedCwd,
      repoRoot,
      count: payload.files?.length ?? 0,
      error: payload.error,
      truncated: payload.truncated,
      extra: { baseBranch, headRef, includeUncommitted, requestSlotId, commits: payload.commitCount },
    });
    res.json(payload);
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action, op: 'git.branch-diff', startedAt, status: 'error', cwd, repoRoot: repoRootForLog, code: payload.code, error: payload.error, extra: { baseBranch, requestSlotId } });
    res.status(error instanceof OperationTimeoutError ? 504 : 200).json({ available: false, ...payload });
  } finally {
    releaseIoSlot(requestSlotId, requestId);
  }
});

router.get('/commit-diff', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
  const requestedRepoRoot = typeof req.query.repoRoot === 'string' ? req.query.repoRoot : undefined;
  const commit = typeof req.query.commit === 'string' ? req.query.commit : '';
  const action = getRequestAction(req, 'load_commit_diff');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('git.commit-diff'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  let repoRootForLog: string | null = null;
  registerIoSlot({ requestId, op: 'git.commit-diff', action, slotId: requestSlotId, controller, cwd: requestedRepoRoot ?? cwd });
  try {
    if ((!cwd && !requestedRepoRoot) || !commit.trim()) {
      res.json({ available: false, error: 'No cwd or commit provided' });
      return;
    }
    const resolvedCwd = await pathValidator.validatePathAsync(cwd ?? requestedRepoRoot ?? '');
    throwIfAborted(controller.signal, 'git.commit-diff');
    const workspaceGitRoot = await findGitRoot(resolvedCwd);
    throwIfAborted(controller.signal, 'git.commit-diff');
    if (!workspaceGitRoot) {
      res.json({ available: false, workspaceRoot: resolvedCwd, error: 'Not a git repository' });
      return;
    }
    const repoRoot = requestedRepoRoot ? await pathValidator.validatePathAsync(requestedRepoRoot) : workspaceGitRoot;
    if (!(await isWorkspaceGitRepositoryRoot(workspaceGitRoot, repoRoot, controller.signal))) {
      res.status(400).json({ available: false, error: 'Repository is outside current workspace' });
      return;
    }
    const actualRepoRoot = await findGitRoot(repoRoot);
    if (!actualRepoRoot || actualRepoRoot !== repoRoot) {
      res.status(400).json({ available: false, error: 'Repository root is invalid' });
      return;
    }
    repoRootForLog = repoRoot;
    const payload = await withTimeout(
      getCommitDiffPayload(workspaceGitRoot, repoRoot, commit, controller.signal),
      GIT_FILE_DIFF_ROUTE_TIMEOUT_MS,
      'Commit diff took too long. The repository may be busy, on slow storage, or locked by another Git process.',
      'GIT_COMMIT_DIFF_TIMEOUT',
      () => controller.abort(new OperationTimeoutError('Commit diff took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_COMMIT_DIFF_TIMEOUT')),
    );
    logFsIo({
      id: requestId,
      action,
      op: 'git.commit-diff',
      startedAt,
      status: payload.available ? 'ok' : 'error',
      cwd: resolvedCwd,
      repoRoot,
      count: payload.files?.length ?? 0,
      error: payload.error,
      truncated: payload.truncated,
      extra: { commit, requestSlotId },
    });
    res.json(payload);
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action, op: 'git.commit-diff', startedAt, status: 'error', cwd, repoRoot: repoRootForLog, code: payload.code, error: payload.error, extra: { commit, requestSlotId } });
    res.status(error instanceof OperationTimeoutError ? 504 : 200).json({ available: false, ...payload });
  } finally {
    releaseIoSlot(requestSlotId, requestId);
  }
});

router.get('/git-recent-commits', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
  const requestedRepoRoot = typeof req.query.repoRoot === 'string' ? req.query.repoRoot : undefined;
  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
  const rawLimit = Number.parseInt(typeof req.query.limit === 'string' ? req.query.limit : '', 10);
  const rawSkip = Number.parseInt(typeof req.query.skip === 'string' ? req.query.skip : '', 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), MAX_RECENT_COMMITS_LIMIT);
  const skip = Math.max(Number.isFinite(rawSkip) ? rawSkip : 0, 0);
  const action = getRequestAction(req, 'load_recent_commits');
  const requestSlotId = typeof req.query.requestSlotId === 'string' ? req.query.requestSlotId : undefined;
  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) controller.abort(new SupersededRequestError('git.recent-commits'));
  };
  req.on('aborted', abortRequest);
  res.on('close', abortRequest);
  let repoRootForLog: string | null = null;
  registerIoSlot({ requestId, op: 'git.recent-commits', action, slotId: requestSlotId, controller, cwd: requestedRepoRoot ?? cwd });
  try {
    if (!cwd && !requestedRepoRoot) {
      res.json({ available: false, error: 'No cwd provided' });
      return;
    }
    const resolvedCwd = await pathValidator.validatePathAsync(cwd ?? requestedRepoRoot ?? '');
    throwIfAborted(controller.signal, 'git.recent-commits');
    const workspaceGitRoot = await findGitRoot(resolvedCwd);
    throwIfAborted(controller.signal, 'git.recent-commits');
    if (!workspaceGitRoot) {
      res.json({ available: false, cwd: resolvedCwd, error: 'Not a git repository', commits: [], hasMore: false });
      return;
    }
    const repoRoot = requestedRepoRoot ? await pathValidator.validatePathAsync(requestedRepoRoot) : workspaceGitRoot;
    if (!(await isWorkspaceGitRepositoryRoot(workspaceGitRoot, repoRoot, controller.signal))) {
      res.status(400).json({ available: false, error: 'Repository is outside current workspace', commits: [], hasMore: false });
      return;
    }
    const actualRepoRoot = await findGitRoot(repoRoot);
    if (!actualRepoRoot || actualRepoRoot !== repoRoot) {
      res.status(400).json({ available: false, error: 'Repository root is invalid', commits: [], hasMore: false });
      return;
    }
    repoRootForLog = repoRoot;
    const fetchCount = limit + 1;
    const logArgs = ['log', '--oneline', `--skip=${skip}`, `-${fetchCount}`];
    if (query) {
      logArgs.push('--regexp-ignore-case', '--all-match', `--grep=${query}`);
    }
    let output = await withTimeout(
      execGit(logArgs, repoRoot, controller.signal).catch(emptyOnNonAbortGitError),
      GIT_ROUTE_TIMEOUT_MS,
      'Recent commits took too long. The repository may be busy, on slow storage, or locked by another Git process.',
      'GIT_RECENT_COMMITS_TIMEOUT',
      () => controller.abort(new OperationTimeoutError('Recent commits took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_RECENT_COMMITS_TIMEOUT')),
    );
    let commits = output.split('\n').map((line) => line.trim()).filter(Boolean);
    if (query && commits.length === 0 && /^[0-9a-f]{4,40}$/i.test(query)) {
      const hashSearchLimit = Math.max(fetchCount + skip, 200);
      output = await withTimeout(
        execGit(['log', '--oneline', '--abbrev=40', `-${hashSearchLimit}`], repoRoot, controller.signal).catch(emptyOnNonAbortGitError),
        GIT_ROUTE_TIMEOUT_MS,
        'Recent commits took too long. The repository may be busy, on slow storage, or locked by another Git process.',
        'GIT_RECENT_COMMITS_TIMEOUT',
        () => controller.abort(new OperationTimeoutError('Recent commits took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_RECENT_COMMITS_TIMEOUT')),
      );
      commits = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.toLowerCase().startsWith(query.toLowerCase()))
        .slice(skip, skip + fetchCount);
    }
    const hasMore = commits.length > limit;
    const page = commits.slice(0, limit);
    logFsIo({ id: requestId, action, op: 'git.recent-commits', startedAt, status: 'ok', cwd: resolvedCwd, repoRoot, count: page.length, extra: { requestSlotId, query, skip, limit, hasMore } });
    res.json({ available: true, cwd: resolvedCwd, root: repoRoot, commits: page, hasMore, skip, limit, query });
  } catch (error) {
    const payload = getErrorPayload(error);
    logFsIo({ id: requestId, action, op: 'git.recent-commits', startedAt, status: 'error', cwd, repoRoot: repoRootForLog, code: payload.code, error: payload.error, extra: { requestSlotId, query, skip, limit } });
    res.status(error instanceof OperationTimeoutError ? 504 : 200).json({ available: false, commits: [], hasMore: false, ...payload });
  } finally {
    releaseIoSlot(requestSlotId, requestId);
  }
});

router.get('/branch-audit', (req: Request, res: Response) => {
  const workspaceRoot = typeof req.query.workspaceRoot === 'string' ? req.query.workspaceRoot : null;
  const repoRoot = typeof req.query.repoRoot === 'string' ? req.query.repoRoot : null;
  const baseRef = typeof req.query.baseRef === 'string' ? req.query.baseRef : null;
  const branchName = typeof req.query.branchName === 'string' ? req.query.branchName : null;
  res.json(listBranchAuditRecords({ workspaceRoot, repoRoot, baseRef, branchName }));
});

router.delete('/branch-audit', (req: Request, res: Response) => {
  const body = req.body as { ids?: unknown; workspaceRoot?: unknown; repoRoot?: unknown; baseRef?: unknown; branchName?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : undefined;
  const workspaceRoot = typeof body.workspaceRoot === 'string' ? body.workspaceRoot : null;
  const repoRoot = typeof body.repoRoot === 'string' ? body.repoRoot : null;
  const baseRef = typeof body.baseRef === 'string' ? body.baseRef : null;
  const branchName = typeof body.branchName === 'string' ? body.branchName : null;
  if ((!ids || ids.length === 0) && !workspaceRoot && !repoRoot && !baseRef && !branchName) {
    res.status(400).json({ error: 'Expected ids, workspaceRoot, repoRoot, baseRef, or branchName to clear branch audit explanations' });
    return;
  }
  res.json({ ok: true, ...clearBranchAuditRecords({ ids, workspaceRoot, repoRoot, baseRef, branchName }) });
});

// Mutating Git actions for the right sidebar diff list. Keep this API as a
// strict allowlist — never accept arbitrary git arguments from the browser.
router.post('/git-action', async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      action?: GitAction;
      cwd?: string;
      paths?: unknown;
      message?: unknown;
      confirm?: { acknowledged?: boolean; phrase?: string };
      remote?: unknown;
      branch?: unknown;
    };
    const { action, cwd } = body;

    if (!cwd) {
      res.status(400).json({ error: 'Missing cwd', code: 'MISSING_CWD' });
      return;
    }
    if (!action || !['stage-file', 'stage-all', 'unstage-file', 'stash-file', 'stash-all', 'restore-worktree-file', 'commit', 'push', 'pull', 'switch-branch'].includes(action)) {
      res.status(400).json({ error: 'Unsupported git action', code: 'UNSUPPORTED_ACTION' });
      return;
    }

    const resolvedCwd = await pathValidator.validatePathAsync(cwd);
    const gitRoot = await findGitRoot(resolvedCwd);
    if (!gitRoot) {
      res.status(404).json({ error: 'Not a git repository', code: 'NOT_GIT_REPOSITORY' });
      return;
    }

    const existing = gitActionJobs.get(getGitActionJobKey(gitRoot, action));
    if (existing?.status === 'running') {
      res.json({ ok: true, ...serializeGitActionJob(existing) });
      return;
    }

    const job: GitActionJob = {
      id: `git-action-${Date.now().toString(36)}-${(++gitActionJobSeq).toString(36)}`,
      key: getGitActionJobKey(gitRoot, action),
      status: 'running',
      action,
      cwd: resolvedCwd,
      gitRoot,
      startedAt: Date.now(),
    };
    gitActionJobs.set(job.key, job);
    job.promise = (async () => {
      try {
        const output = await runGitActionCommand(body, gitRoot);
        clearGitBundleCacheForRoot(gitRoot);
        const bundle = await refreshGitBundleCacheDetached(resolvedCwd, gitRoot, true);
        job.status = 'done';
        job.output = output;
        job.message = output.trim() || 'Git action completed';
        job.bundle = bundle;
      } catch (error) {
        job.status = 'error';
        job.error = error instanceof Error ? error.message : 'Git action failed';
        job.code = (error as Error & { code?: string }).code ?? 'GIT_ACTION_FAILED';
        if ((error as Error & { confirmationPhrase?: string }).confirmationPhrase) {
          job.message = (error as Error & { confirmationPhrase?: string }).confirmationPhrase;
        }
      } finally {
        job.finishedAt = Date.now();
      }
    })();
    void job.promise;
    res.json({ ok: true, ...serializeGitActionJob(job) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git action failed';
    const code = (error as Error & { code?: string }).code ?? 'GIT_ACTION_FAILED';
    const confirmationPhrase = (error as Error & { confirmationPhrase?: string }).confirmationPhrase;
    res.status(code === 'CONFIRMATION_REQUIRED' ? 428 : 500).json({ error: message, code, confirmationPhrase });
  }
});

router.get('/git-action/status', async (req: Request, res: Response) => {
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
  const action = typeof req.query.action === 'string' ? req.query.action as GitAction : undefined;
  const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
  if (jobId) {
    const job = Array.from(gitActionJobs.values()).find((candidate) => candidate.id === jobId);
    res.json(job ? { ok: true, ...serializeGitActionJob(job) } : { ok: false, status: 'missing' });
    return;
  }
  if (!cwd || !action || !['stage-file', 'stage-all', 'unstage-file', 'stash-file', 'stash-all', 'restore-worktree-file', 'commit', 'push', 'pull', 'switch-branch'].includes(action)) {
    res.status(400).json({ ok: false, error: 'Missing cwd or action' });
    return;
  }
  const resolvedCwd = await pathValidator.validatePathAsync(cwd);
  const gitRoot = await findGitRoot(resolvedCwd);
  if (!gitRoot) {
    res.status(404).json({ ok: false, error: 'Not a git repository' });
    return;
  }
  const job = gitActionJobs.get(getGitActionJobKey(gitRoot, action));
  res.json(job ? { ok: true, ...serializeGitActionJob(job) } : { ok: false, status: 'missing' });
});

// Hunk-level git operations (IntelliJ-style gutter actions): stage one hunk
// into the index or revert it in the worktree/index. The browser extracts a
// single hunk from a diff we served and posts it back; validateHunkPatch
// confines it to the requested file and the patch is fed to `git apply` over
// stdin — no temp files, no shell.
router.post('/apply-hunk', async (req: Request, res: Response) => {
  const requestId = ++fsIoRequestSeq;
  const startedAt = Date.now();
  const action = getRequestAction(req, 'apply_diff_hunk');
  const body = req.body as { cwd?: unknown; path?: unknown; mode?: unknown; patch?: unknown };
  const cwd = typeof body.cwd === 'string' ? body.cwd : '';
  const requestedPath = typeof body.path === 'string' ? body.path : '';
  const mode: HunkApplyMode | undefined = typeof body.mode === 'string' && HUNK_APPLY_MODES.includes(body.mode as HunkApplyMode)
    ? body.mode as HunkApplyMode
    : undefined;
  const patch = typeof body.patch === 'string' ? body.patch : '';
  let gitRootForLog: string | null = null;
  logFsIoEvent({ id: requestId, action, op: 'git.apply-hunk', event: 'request-start', path: requestedPath, cwd, extra: { mode, patchBytes: getDiffByteLength(patch) } });
  try {
    if (!cwd || !requestedPath) {
      res.status(400).json({ error: 'Missing cwd or path', code: 'MISSING_PARAMS' });
      return;
    }
    if (!mode) {
      res.status(400).json({ error: 'Unsupported hunk apply mode', code: 'UNSUPPORTED_MODE' });
      return;
    }
    const resolvedCwd = await pathValidator.validatePathAsync(cwd);
    const gitRoot = await findGitRoot(resolvedCwd);
    if (!gitRoot) {
      res.status(404).json({ error: 'Not a git repository', code: 'NOT_GIT_REPOSITORY' });
      return;
    }
    gitRootForLog = gitRoot;
    const pathspec = await toGitPathspec(gitRoot, requestedPath);
    const validation = validateHunkPatch(patch, pathspec);
    if (!validation.ok) {
      logFsIoEvent({ id: requestId, action, op: 'git.apply-hunk', event: 'invalid-patch', path: requestedPath, cwd, repoRoot: gitRoot, extra: { mode, reason: validation.error } });
      res.status(400).json({ error: validation.error, code: 'INVALID_PATCH' });
      return;
    }
    await runGitApply(gitRoot, mode, patch, GIT_APPLY_TIMEOUT_MS);
    clearGitBundleCacheForRoot(gitRoot);
    const bundle = await refreshGitBundleCacheDetached(resolvedCwd, gitRoot, true);
    logFsIo({ id: requestId, action, op: 'git.apply-hunk', startedAt, status: 'ok', path: requestedPath, cwd, repoRoot: gitRoot, extra: { mode } });
    res.json({ ok: true, bundle });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git apply failed';
    const code = (error as Error & { code?: string }).code ?? 'GIT_APPLY_FAILED';
    logFsIo({ id: requestId, action, op: 'git.apply-hunk', startedAt, status: 'error', path: requestedPath, cwd, repoRoot: gitRootForLog, code, error: message, extra: { mode } });
    // A stale patch (context drifted since the diff was rendered) is a normal
    // conflict, not a server fault — 409 tells the client to suggest a refresh.
    res.status(error instanceof GitApplyError ? 409 : 500).json({ error: message, code });
  }
});

// ---- File upload ----

interface UploadedFile {
  name: string;
  path: string;
  size: number;
}

function sanitizeUploadFilename(filename: string | undefined, fallback: string): string {
  const normalized = (filename ?? '').replace(/\\/g, '/');
  const basename = path.basename(normalized).trim();
  if (!basename || basename === '.' || basename === '..') return fallback;
  return basename;
}

function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return '';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function isLocalBrowserRequest(req: Request): boolean {
  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress);
  if (LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '') || LOOPBACK_ADDRESSES.has(remoteAddress) || remoteAddress.startsWith('127.')) {
    return true;
  }
  return getLanIPv4Addresses().includes(remoteAddress);
}

function getOpenCommand(targetPath: string, isDirectory: boolean): { command: string; args: string[] } | null {
  if (process.platform === 'darwin') {
    return isDirectory
      ? { command: 'open', args: [targetPath] }
      : { command: 'open', args: ['-R', targetPath] };
  }
  if (process.platform === 'win32') {
    return isDirectory
      ? { command: 'explorer.exe', args: [targetPath] }
      : { command: 'explorer.exe', args: ['/select,', targetPath] };
  }
  return isDirectory
    ? { command: 'xdg-open', args: [targetPath] }
    : { command: 'xdg-open', args: [path.dirname(targetPath)] };
}

router.get('/local-open-availability', (req: Request, res: Response) => {
  const available = isLocalBrowserRequest(req);
  res.json({ available, platform: process.platform });
});

router.post('/open-in-file-browser', async (req: Request, res: Response) => {
  try {
    if (!isLocalBrowserRequest(req)) {
      res.status(403).json({ error: 'Only available from the Termdock host machine', code: 'NOT_LOCAL_BROWSER' });
      return;
    }
    const requestedPath = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path', code: 'MISSING_PATH' });
      return;
    }

    const resolvedPath = await pathValidator.validatePathAsync(requestedPath);
    const stat = await fs.promises.stat(resolvedPath);
    const openCommand = getOpenCommand(resolvedPath, stat.isDirectory());
    if (!openCommand) {
      res.status(501).json({ error: 'Opening file browser is not supported on this platform', code: 'UNSUPPORTED_PLATFORM' });
      return;
    }

    const child = spawn(openCommand.command, openCommand.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && (error as any).code === 'PATH_NOT_ALLOWED') {
      res.status(403).json({ error: 'Path not allowed', code: 'PATH_NOT_ALLOWED' });
      return;
    }
    const message = error instanceof Error ? error.message : 'Failed to open file browser';
    res.status(500).json({ error: message, code: 'OPEN_FILE_BROWSER_FAILED' });
  }
});

router.post('/upload', async (req: Request, res: Response) => {
  try {
    const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
    if (!dir) {
      res.status(400).json({ error: 'Missing dir query parameter', code: 'MISSING_DIR' });
      return;
    }

    const resolvedDir = await pathValidator.validatePathAsync(dir);
    const stat = await fs.promises.stat(resolvedDir);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Target is not a directory', code: 'NOT_A_DIRECTORY' });
      return;
    }

    const files: UploadedFile[] = [];
    let fileCount = 0;
    let aborted = false;
    let totalSize = 0;

    const bb = busboy({
      headers: req.headers,
      // Browser FormData sends UTF-8 filenames, while busboy defaults bare
      // multipart filename parameters to latin1. Without this, dropped files
      // named with CJK characters turn into mojibake like "æ¥è¯¢".
      defParamCharset: 'utf8',
      limits: { fileSize: MAX_UPLOAD_SIZE, files: MAX_UPLOAD_FILES },
    });

    const writePromises: Promise<void>[] = [];

    bb.on('file', (_fieldname: string, fileStream: NodeJS.ReadableStream, info: { filename: string; encoding: string; mimeType: string }) => {
      if (aborted) {
        fileStream.resume();
        return;
      }

      fileCount++;
      if (fileCount > MAX_UPLOAD_FILES) {
        aborted = true;
        fileStream.resume();
        return;
      }

      const { filename } = info;
      const destName = sanitizeUploadFilename(filename, `file_${fileCount}`);
      const baseDestPath = path.join(resolvedDir, destName);

      // Resolve unique path asynchronously inside the write promise
      const writePromise = (async () => {
        const destPath = await uniquePath(baseDestPath);
        return new Promise<void>((resolve, reject) => {
          const writeStream = fs.createWriteStream(destPath);
          let fileSize = 0;

          fileStream.on('data', (chunk: Buffer) => {
            fileSize += chunk.length;
            totalSize += chunk.length;
            if (totalSize > MAX_UPLOAD_SIZE) {
              aborted = true;
              (fileStream as any).destroy?.(new Error('File too large'));
              writeStream.destroy();
              return;
            }
          });

          fileStream.pipe(writeStream);

          writeStream.on('finish', () => {
            files.push({ name: destName, path: destPath, size: fileSize });
            resolve();
          });

          writeStream.on('error', (err) => {
            fs.promises.unlink(destPath).catch(() => {});
            reject(err);
          });
        });
      })();

      writePromises.push(writePromise);
    });

    bb.on('error', (_err: Error) => {
      // Will be handled by the promise rejection below
    });

    bb.on('filesLimit', () => {
      aborted = true;
    });

    bb.on('finish', async () => {
      try {
        await Promise.all(writePromises);
        if (aborted && files.length === 0) {
          res.status(413).json({ error: 'Upload limit exceeded', code: 'UPLOAD_LIMIT' });
          return;
        }
        res.status(200).json({ files });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        res.status(500).json({ error: message, code: 'UPLOAD_FAILED' });
      }
    });

    req.pipe(bb);
  } catch (error) {
    if (error instanceof Error && (error as any).code === 'PATH_NOT_ALLOWED') {
      res.status(403).json({ error: 'Path not allowed', code: 'PATH_NOT_ALLOWED' });
      return;
    }
    const message = error instanceof Error ? error.message : 'Upload failed';
    res.status(500).json({ error: message, code: 'UPLOAD_FAILED' });
  }
});

async function uniquePath(filePath: string): Promise<string> {
  try {
    await fs.promises.access(filePath);
    // File exists — find a unique name
    const ext = path.extname(filePath);
    const base = filePath.slice(0, filePath.length - ext.length);
    let counter = 1;
    let candidate: string;
    do {
      candidate = `${base}_${counter}${ext}`;
      counter++;
    } while (await exists(candidate));
    return candidate;
  } catch {
    // File doesn't exist — use as-is
    return filePath;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export default router;
