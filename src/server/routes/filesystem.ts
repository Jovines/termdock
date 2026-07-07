import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import watcher from '@parcel/watcher';
import { pathValidator } from '../utils/pathValidator.js';
import { writeDiffTraceLog, writeErrorLog, writeJsonLog } from '../utils/serverLogger.js';
import { clearChangeAuditRecords, listChangeAuditRecords } from '../utils/changeAuditStore.js';

const router = Router();

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_IMAGE_PREVIEW_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_DOWNLOAD_SIZE = 200 * 1024 * 1024; // 200MB
const GIT_TIMEOUT_MS = 5000;
const GIT_UNTRACKED_TIMEOUT_MS = 800;
const GIT_UNTRACKED_BACKGROUND_TIMEOUT_MS = 120_000;
const GIT_BUNDLE_CACHE_TTL_MS = 60_000;
const MAX_DIRECTORY_ENTRIES = 1000;
const MAX_FALLBACK_SEARCH_VISITED = 30_000;
// Content (full-text) search caps so a broad query can't flood the stream/UI.
const MAX_CONTENT_SEARCH_FILES = 1_000;
const MAX_CONTENT_MATCHES_PER_FILE = 50;
const MAX_CONTENT_MATCH_LINE_LENGTH = 400;
const MAX_GIT_CONTEXT_CHANGED_FILES = 200;
const MAX_DIFF_BYTES = 1024 * 1024; // 1MB
const MAX_UNTRACKED_DIFF_FILE_BYTES = 1024 * 1024; // 1MB
const MAX_NESTED_GIT_REPOS = 32;
const NESTED_GIT_DISCOVERY_TIMEOUT_MS = 1_000;
const FS_ROUTE_TIMEOUT_MS = 6_000;
const GIT_ROUTE_TIMEOUT_MS = 8_000;
const GIT_FILE_DIFF_ROUTE_TIMEOUT_MS = 45_000;
const RESTORE_CONFIRM_PHRASES = new Set(['丢弃改动', 'discard changes']);
const FS_IO_LOG_NAME = 'fs-io.log';
const activeDiffSlots = new Map<string, { controller: AbortController; requestId: number }>();
const activeIoSlots = new Map<string, { controller: AbortController; requestId: number; op: string }>();
const untrackedJobs = new Map<string, {
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  files?: GitChangedFile[];
  error?: string;
  code?: string;
  promise?: Promise<void>;
}>();

type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'unknown';

type GitAction = 'stage-file' | 'stage-all' | 'unstage-file' | 'stash-file' | 'stash-all' | 'restore-worktree-file' | 'commit' | 'push' | 'pull' | 'switch-branch';

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
  } | null;
  repositories?: GitRepositoryBundle[];
  repoFilters?: GitRepositoryFilter[];
  truncatedRepositories?: boolean;
  cached?: boolean;
  stale?: boolean;
  cacheAgeMs?: number;
  nestedDeferred?: boolean;
  untrackedDeferred?: boolean;
  error?: string;
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

interface FileSearchEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  isSymlink?: boolean;
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

const WATCH_IGNORED_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo', 'coverage', 'target', '.gradle', '.idea', '.DS_Store',
]);
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
};

function getImageMimeType(filePath: string): string | null {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

function toInlineFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '_');
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

async function getChangedFiles(gitRoot: string, signal?: AbortSignal, options: { includeUntracked?: boolean; untrackedTimeoutMs?: number } = {}): Promise<ChangedFilesResult> {
  const includeUntracked = options.includeUntracked !== false;
  const [stagedOutput, unstagedOutput, untrackedResult] = await Promise.all([
    execGit(['diff', '--cached', '--name-status', '-M', '-z'], gitRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['diff', '--name-status', '-M', '-z'], gitRoot, signal).catch(emptyOnNonAbortGitError),
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

function buildUntrackedFiles(gitRoot: string, output: string): GitChangedFile[] {
  return finalizeChangedFiles(new Map(output.split('\0').filter(Boolean).map((p) => {
    const file = emptyChangedFile(gitRoot, p);
    file.status = 'untracked';
    file.untracked = true;
    file.unstaged = true;
    file.tracked = false;
    return [p, file] as const;
  })));
}

function startUntrackedJob(gitRoot: string): UntrackedFilesPayload {
  const current = untrackedJobs.get(gitRoot);
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
  const promise = execGit(['ls-files', '--others', '--exclude-standard', '-z'], gitRoot, undefined, GIT_UNTRACKED_BACKGROUND_TIMEOUT_MS)
    .then((output) => {
      job.status = 'done';
      job.files = buildUntrackedFiles(gitRoot, output);
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
  untrackedJobs.set(gitRoot, job);
  void promise;
  return { status: 'running', files: [], startedAt };
}

async function getGitPushTargets(gitRoot: string, signal?: AbortSignal) {
  const [remotesOutput, branchesOutput, upstreamOutput, aheadBehindOutput] = await Promise.all([
    execGit(['remote'], gitRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], gitRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], gitRoot, signal).catch(emptyOnNonAbortGitError),
    execGit(['rev-list', '--left-right', '--count', '@{u}...HEAD'], gitRoot, signal).catch(emptyOnNonAbortGitError),
  ]);
  const remotes = uniqueSortedLines(remotesOutput);
  const branches = uniqueSortedLines(branchesOutput);
  const upstream = upstreamOutput.trim() || null;
  const { remote: upstreamRemote, branch: upstreamBranch } = splitUpstream(upstream, remotes);
  const { ahead, behind } = parseAheadBehind(aheadBehindOutput, Boolean(upstream));
  return { remotes, branches, upstream, upstreamRemote, upstreamBranch, ahead, behind };
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

async function buildGitBundle(resolvedCwd: string, gitRoot: string, signal?: AbortSignal): Promise<GitBundlePayload> {
  const [branchOutput, changedResult] = await Promise.all([
    execGit(['branch', '--show-current'], gitRoot, signal).catch(emptyOnNonAbortGitError),
    getChangedFiles(gitRoot, signal, { includeUntracked: false }),
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

async function buildGitRepositoryBundle(workspaceRoot: string, resolvedCwd: string, repoRoot: string, displayRoot: string = repoRoot, signal?: AbortSignal): Promise<GitRepositoryBundle> {
  try {
    if (signal) throwIfAborted(signal, 'git.bundle');
    const bundle = await buildGitBundle(repoRoot === workspaceRoot ? resolvedCwd : repoRoot, repoRoot, signal);
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
    .filter((repo) => repo.files.length > 0)
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

async function buildWorkspaceGitBundle(resolvedCwd: string, gitRoot: string, includeNested: boolean, signal?: AbortSignal): Promise<GitBundlePayload> {
  if (!includeNested) {
    if (signal) throwIfAborted(signal, 'git.bundle');
    const bundle = await buildGitBundle(resolvedCwd, gitRoot, signal);
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
  const { repositories: nestedRepositories, truncated } = await discoverNestedGitRoots(gitRoot, signal);
  if (signal) throwIfAborted(signal, 'git.bundle');
  const nestedDisplayRoots = new Set(nestedRepositories.map((repo) => (
    path.relative(gitRoot, repo.displayRoot).split(path.sep).join('/').replace(/\/+$/, '')
  )));
  const repositories = await Promise.all([
    buildGitRepositoryBundle(gitRoot, resolvedCwd, gitRoot, gitRoot, signal),
    ...nestedRepositories.map((repo) => buildGitRepositoryBundle(gitRoot, resolvedCwd, repo.root, repo.displayRoot, signal)),
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
      gitBundleCache.set(cacheKey, { bundle, expiresAt: Date.now() + GIT_BUNDLE_CACHE_TTL_MS });
      return bundle;
    })
    .finally(() => {
      if (gitBundleBuildPromises.get(cacheKey) === promise) gitBundleBuildPromises.delete(cacheKey);
    });
  if (canReusePending) gitBundleBuildPromises.set(cacheKey, promise);
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
  };
}

async function toDirectoryEntry(dir: string, dirent: Dirent): Promise<FileSearchEntry> {
  const entryPath = path.join(dir, dirent.name);
  if (!dirent.isSymbolicLink()) {
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
      type: stat.isDirectory() ? 'directory' : 'symlink',
      isSymlink: true,
    };
  } catch {
    return {
      name: dirent.name,
      path: entryPath,
      type: 'symlink',
      isSymlink: true,
    };
  }
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

function searchWithRipgrep(rootPath: string, queryLower: string, showHidden: boolean, signal: AbortSignal): Promise<FileSearchPayload> {
  return new Promise((resolve, reject) => {
    const args = ['--files', '--color', 'never', '--no-messages', '--null'];
    if (showHidden) args.push('--hidden', '-g', '!.git/');

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

async function searchWithFallback(rootPath: string, queryLower: string, showHidden: boolean, signal: AbortSignal): Promise<FileSearchPayload> {
  const entries = new Map<string, FileSearchEntry>();
  const queue = [rootPath];
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
  res.write(`${JSON.stringify({ type, ...payload })}\n`);
}

function createSearchBatchEmitter(res: Response) {
  let batch: FileSearchEntry[] = [];
  const flush = () => {
    if (batch.length === 0 || res.destroyed) return;
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

function streamSearchWithRipgrep(rootPath: string, queryLower: string, showHidden: boolean, signal: AbortSignal, res: Response): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = ['--files', '--color', 'never', '--no-messages', '--null'];
    if (showHidden) args.push('--hidden', '-g', '!.git/');

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

async function streamSearchWithFallback(rootPath: string, queryLower: string, showHidden: boolean, signal: AbortSignal, res: Response): Promise<{ total: number; limited: boolean }> {
  const emitted = new Set<string>();
  const batch = createSearchBatchEmitter(res);
  const queue = [rootPath];
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
    if (batch.length === 0 || res.destroyed) return;
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
function streamContentSearchWithRipgrep(rootPath: string, query: string, showHidden: boolean, signal: AbortSignal, res: Response): Promise<{ total: number; limited: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      '--json',
      '--smart-case',
      '--no-messages',
      '-m', String(MAX_CONTENT_MATCHES_PER_FILE),
    ];
    if (showHidden) args.push('--hidden', '-g', '!.git/');
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

function execGit(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('git command timed out'));
    }, timeoutMs);

    const proc = execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      clearTimeout(timer);
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

// In-memory cache for `git rev-parse --show-toplevel` results.
// Key = requested cwd, Value = { root, expiresAt }. Invalidated quickly so
// directory changes still propagate, but reused within the same UI burst
// (open sidebar fires ~3 git fetches at once).
const GIT_ROOT_CACHE_TTL_MS = 5_000;
const gitRootCache = new Map<string, { root: string | null; expiresAt: number }>();
const gitBundleCache = new Map<string, { bundle: GitBundlePayload; expiresAt: number }>();
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
async function findGitRoot(cwd: string): Promise<string | null> {
  const now = Date.now();
  const cached = gitRootCache.get(cwd);
  if (cached && cached.expiresAt > now) {
    return cached.root;
  }
  try {
    const root = (await execGit(['rev-parse', '--show-toplevel'], cwd)).trim() || null;
    gitRootCache.set(cwd, { root, expiresAt: now + GIT_ROOT_CACHE_TTL_MS });
    return root;
  } catch {
    gitRootCache.set(cwd, { root: null, expiresAt: now + GIT_ROOT_CACHE_TTL_MS });
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
      const allEntries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
      throwIfAborted(controller.signal, 'fs.list');
      const visibleDirents = allEntries.filter(dirent => showHidden || !dirent.name.startsWith('.'));
      const returnedDirents = visibleDirents
        .sort(compareDirents)
        .slice(0, MAX_DIRECTORY_ENTRIES);
      const entries = await Promise.all(returnedDirents.map((dirent) => toDirectoryEntry(resolvedPath, dirent)));
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
  const rootsParam = req.query.roots;
  const rawRoots = (Array.isArray(rootsParam) ? rootsParam : typeof rootsParam === 'string' ? rootsParam.split('|') : [])
    .filter((root): root is string => typeof root === 'string');
  const roots: string[] = [];
  for (const rawRoot of rawRoots) {
    if (!rawRoot) continue;
    try {
      const resolved = await pathValidator.validatePathAsync(rawRoot);
      const stat = await fs.promises.stat(resolved);
      if (stat.isDirectory() && !roots.includes(resolved)) roots.push(resolved);
    } catch {
      // Ignore invalid watch roots; the visible tree will still work via manual list requests.
    }
  }

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
  const subscriptions: watcher.AsyncSubscription[] = [];

  const writeEvent = (type: string, payload: Record<string, unknown>) => {
    if (closed || res.destroyed) return;
    res.write(`${JSON.stringify({ type, ...payload })}\n`);
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

  for (const rootPath of roots) {
    try {
      const subscription = await watcher.subscribe(rootPath, (error, events) => {
        if (closed) return;
        if (error) {
          enqueue({ type: 'rescan-required', path: rootPath, reason: error.message || 'watch-error' });
          return;
        }
        for (const event of events) {
          const changedPath = path.resolve(event.path);
          if (!isPathInside(rootPath, changedPath) || isIgnoredWatchPath(rootPath, changedPath)) continue;
          if (event.type === 'delete') {
            enqueue({ type: 'deleted', path: changedPath });
            continue;
          }
          fs.promises.lstat(changedPath)
            .then((stat) => {
              enqueue({ type: event.type === 'create' ? 'created' : 'updated', path: changedPath, entry: toFileEntry(changedPath, stat) });
            })
            .catch(() => {
              enqueue({ type: 'deleted', path: changedPath });
            });
        }
      }, {
        ignore: Array.from(WATCH_IGNORED_NAMES).map((name) => `**/${name}/**`),
      });
      subscriptions.push(subscription);
    } catch (error) {
      enqueue({ type: 'rescan-required', path: rootPath, reason: error instanceof Error ? error.message : 'watch-unavailable' });
    }
  }

  req.on('close', () => {
    closed = true;
    if (flushTimer) clearTimeout(flushTimer);
    for (const subscription of subscriptions) {
      void subscription.unsubscribe().catch(() => undefined);
    }
  });
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
        const result = await streamContentSearchWithRipgrep(resolvedPath, query, showHidden, controller.signal, res);
        if (!controller.signal.aborted && !res.destroyed) {
          writeSearchEvent(res, 'done', { total: result.total, truncated: result.limited, limited: result.limited, engine: 'rg', mode: 'content' });
          logSearch('ok', { count: result.total, truncated: result.limited, extra: { mode: 'content', engine: 'rg' } });
          res.end();
        }
      } catch (error) {
        if (controller.signal.aborted || res.destroyed) {
          const payload = getErrorPayload(controller.signal.reason ?? error);
          logSearch('error', { code: payload.code, error: payload.error, extra: { mode: 'content', engine: 'rg' } });
          return;
        }
        const message = error instanceof Error ? error.message : 'Content search failed';
        logSearch('error', { code: 'CONTENT_SEARCH_UNAVAILABLE', error: message, extra: { mode: 'content', engine: 'rg' } });
        writeSearchEvent(res, 'error', { message, code: 'CONTENT_SEARCH_UNAVAILABLE' });
        res.end();
      }
      return;
    }

    if (req.query.stream === 'true') {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      writeSearchEvent(res, 'meta', { path: resolvedPath, query, engine: 'rg', limited: false });
      try {
        const total = await streamSearchWithRipgrep(resolvedPath, queryLower, showHidden, controller.signal, res);
        if (!controller.signal.aborted && !res.destroyed) {
          writeSearchEvent(res, 'done', { total, truncated: false, limited: false, engine: 'rg' });
          logSearch('ok', { count: total, truncated: false, extra: { mode: 'name', engine: 'rg' } });
          res.end();
        }
      } catch (error) {
        if (controller.signal.aborted || res.destroyed) {
          const payload = getErrorPayload(controller.signal.reason ?? error);
          logSearch('error', { code: payload.code, error: payload.error, extra: { mode: 'name', engine: 'rg' } });
          return;
        }
        writeSearchEvent(res, 'meta', { path: resolvedPath, query, engine: 'fallback', limited: false });
        const result = await streamSearchWithFallback(resolvedPath, queryLower, showHidden, controller.signal, res);
        if (!controller.signal.aborted && !res.destroyed) {
          writeSearchEvent(res, 'done', { total: result.total, truncated: result.limited, limited: result.limited, engine: 'fallback' });
          logSearch('ok', { count: result.total, truncated: result.limited, extra: { mode: 'name', engine: 'fallback' } });
          res.end();
        }
      }
      return;
    }

    try {
      const result = await searchWithRipgrep(resolvedPath, queryLower, showHidden, controller.signal);
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
      const result = await searchWithFallback(resolvedPath, queryLower, showHidden, controller.signal);
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

      if (stat.isDirectory()) {
        throw new Error('Path is a directory, not a file');
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

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size.toString());
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${toInlineFilename(path.basename(resolvedPath))}"`);

    const stream = fs.createReadStream(resolvedPath);
    controller.signal.addEventListener('abort', () => stream.destroy(controller.signal.reason instanceof Error ? controller.signal.reason : undefined), { once: true });
    res.on('finish', () => logOnce('ok', { path: resolvedPath, bytes: stat.size, extra: { mimeType } }));
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
    res.setHeader('Content-Disposition', `attachment; filename="${toInlineFilename(path.basename(resolvedPath))}"`);

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
  logFsIoEvent({ id: requestId, action, op: 'git.diff', event: 'request-start', path: requestedPath, cwd, extra: { inflight, traceId, interactionId, requestSlotId } });
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
      const buildDiffArgs = (includeCached: boolean) => {
        const args = ['diff', '-M'];
        if (includeCached) args.push('--cached');
        if (pathspec) args.push('--', pathspec);
        return args;
      };

      // Default sidebar diffs should represent every changed file from the list:
      // staged-only changes, unstaged changes, and untracked files. Plain
      // `git diff` only shows unstaged tracked edits, which made staged-only
      // additions/deletions/renames look empty in the UI.
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

      let diff = cached
        ? await readLimitedDiff(buildDiffArgs(true))
        : [
            await readLimitedDiff(buildDiffArgs(true)),
            await readLimitedDiff(buildDiffArgs(false)),
          ].filter(Boolean).join('\n');

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
          diff = await readLimitedNoIndexDiff(['diff', '--no-index', '--', '/dev/null', pathspec]);
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
          const partial = await readLimitedNoIndexDiff(['diff', '--no-index', '--', '/dev/null', p], MAX_UNTRACKED_DIFF_FILE_BYTES);
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

    const payload = startUntrackedJob(gitRoot);
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
      res.json({ available: false, cwd: resolvedCwd, error: 'Not a git repository' });
      return;
    }

    const result = await withTimeout((async () => {
      throwIfAborted(controller.signal, 'git.context');
      const [branchOutput, statusOutput, logOutput, pushTargets] = await Promise.all([
        execGit(['branch', '--show-current'], gitRoot, controller.signal).catch(emptyOnNonAbortGitError),
        execGit(['status', '--short', '--branch'], gitRoot, controller.signal).catch(emptyOnNonAbortGitError),
        execGit(['log', '--oneline', '-8'], gitRoot, controller.signal).catch(emptyOnNonAbortGitError),
        getGitPushTargets(gitRoot, controller.signal),
      ]);
      throwIfAborted(controller.signal, 'git.context');

      const files = (await getChangedFiles(gitRoot, controller.signal, { includeUntracked: false })).files;
      throwIfAborted(controller.signal, 'git.context');
      const changedFiles = toContextFiles(files);
      return { branchOutput, statusOutput, logOutput, pushTargets, changedFiles };
    })(), GIT_ROUTE_TIMEOUT_MS, 'Git details took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_CONTEXT_TIMEOUT', () => controller.abort(new OperationTimeoutError('Git details took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_CONTEXT_TIMEOUT')));

    logFsIo({ id: requestId, action, op: 'git.context', startedAt, status: 'ok', cwd: resolvedCwd, repoRoot: gitRoot, count: result.changedFiles.length, truncated: result.changedFiles.length >= MAX_GIT_CONTEXT_CHANGED_FILES, extra: { requestSlotId } });
    res.json({
      available: true,
      cwd: resolvedCwd,
      root: gitRoot,
      branch: result.branchOutput.trim() || null,
      ...result.pushTargets,
      status: result.statusOutput.trim(),
      recentCommits: result.logOutput.split('\n').map((line) => line.trim()).filter(Boolean),
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
    const includeNested = req.query.includeNested === 'true';
    if (!cwd) {
      res.json({ available: false, files: [], context: null, error: 'No cwd provided' });
      return;
    }

    const resolvedCwd = await pathValidator.validatePathAsync(cwd);
    throwIfAborted(controller.signal, 'git.bundle');
    const gitRoot = await findGitRoot(resolvedCwd);
    throwIfAborted(controller.signal, 'git.bundle');
    gitRootForLog = gitRoot;
    if (!gitRoot) {
      const payload = {
        available: false,
        files: [],
        context: { available: false, cwd: resolvedCwd, error: 'Not a git repository' },
      };
      logFsIo({ id: requestId, action, op: 'git.bundle', startedAt, status: 'error', cwd: resolvedCwd, repoRoot: null, code: 'NOT_GIT_REPOSITORY', error: 'Not a git repository' });
      res.json(payload);
      return;
    }
    logFsIoEvent({ id: requestId, action, op: 'git.bundle', event: 'git-root-resolved', cwd: resolvedCwd, repoRoot: gitRoot, extra: { requestSlotId, includeNested, refresh } });
    const allowStale = !refresh;
    const cachedBundle = allowStale && includeNested ? getGitBundleCache(gitRoot, true, true) : null;
    const effectiveIncludeNested = includeNested;
    const nestedDeferred = false;

    const bundle = cachedBundle ?? await withTimeout(
      getCachedGitBundle(resolvedCwd, gitRoot, effectiveIncludeNested, refresh, allowStale, controller.signal),
      GIT_ROUTE_TIMEOUT_MS,
      'Git status refresh took too long. The repository may be busy, on slow storage, or locked by another Git process.',
      'GIT_BUNDLE_TIMEOUT',
      () => controller.abort(new OperationTimeoutError('Git status refresh took too long. The repository may be busy, on slow storage, or locked by another Git process.', 'GIT_BUNDLE_TIMEOUT')),
    );
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
      extra: { requestSlotId, repositories: bundle.repositories?.length ?? 1, includeNested: effectiveIncludeNested, requestedIncludeNested: includeNested, nestedDeferred, untrackedDeferred: Boolean(bundle.untrackedDeferred), refresh, cached: Boolean(bundle.cached), stale: Boolean(bundle.stale), cacheAgeMs: bundle.cacheAgeMs },
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

// Mutating Git actions for the right sidebar diff list. Keep this API as a
// strict allowlist — never accept arbitrary git arguments from the browser.
router.post('/git-action', async (req: Request, res: Response) => {
  try {
    const { action, cwd, paths, message, confirm } = req.body as {
      action?: GitAction;
      cwd?: string;
      paths?: unknown;
      message?: unknown;
      confirm?: { acknowledged?: boolean; phrase?: string };
    };

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

    const now = new Date().toISOString().replace(/[:.]/g, '-');
    let output = '';

    if (action === 'stage-all') {
      output = await execGit(['add', '-A'], gitRoot);
    } else if (action === 'stash-all') {
      const stashMessage = getStashMessage(message, `Termdock stash all ${now}`);
      output = await execGit(['stash', 'push', '--include-untracked', '-m', stashMessage], gitRoot);
    } else if (action === 'commit') {
      output = await execGit(['commit', '-m', getCommitMessage(message)], gitRoot);
    } else if (action === 'push') {
      const remote = getRemoteName((req.body as { remote?: unknown }).remote);
      const branch = getBranchName((req.body as { branch?: unknown }).branch);
      const pushArgs = remote && branch ? ['push', '-u', remote, branch] : remote ? ['push', remote] : ['push'];
      output = await execGit(pushArgs, gitRoot);
    } else if (action === 'pull') {
      const remote = getRemoteName((req.body as { remote?: unknown }).remote);
      const branch = getBranchName((req.body as { branch?: unknown }).branch);
      const pullArgs = remote && branch ? ['pull', '--ff-only', remote, branch] : remote ? ['pull', '--ff-only', remote] : ['pull', '--ff-only'];
      output = await execGit(pullArgs, gitRoot);
    } else if (action === 'switch-branch') {
      const branch = getBranchName((req.body as { branch?: unknown }).branch);
      if (!branch) throw new Error('Branch is required');
      output = await execGit(['switch', branch], gitRoot);
    } else {
      const requestedPath = getSinglePath(paths);
      const pathspec = await toGitPathspec(gitRoot, requestedPath);

      if (action === 'stage-file') {
        output = await execGit(['--literal-pathspecs', 'add', '--', pathspec], gitRoot);
      } else if (action === 'unstage-file') {
        output = await execGit(['--literal-pathspecs', 'restore', '--staged', '--', pathspec], gitRoot);
      } else if (action === 'stash-file') {
        const stashMessage = getStashMessage(message, `Termdock stash ${pathspec} ${now}`);
        output = await execGit(['--literal-pathspecs', 'stash', 'push', '--include-untracked', '-m', stashMessage, '--', pathspec], gitRoot);
      } else if (action === 'restore-worktree-file') {
        if (!confirm?.acknowledged || !RESTORE_CONFIRM_PHRASES.has((confirm.phrase ?? '').trim())) {
          res.status(428).json({
            error: 'Confirmation required before discarding changes',
            code: 'CONFIRMATION_REQUIRED',
            confirmationPhrase: '丢弃改动',
          });
          return;
        }
        output = await execGit(['--literal-pathspecs', 'restore', '--worktree', '--', pathspec], gitRoot);
      }
    }

    clearGitBundleCacheForRoot(gitRoot);
    res.json({
      ok: true,
      action,
      message: output.trim() || 'Git action completed',
      output,
      bundle: await getCachedGitBundle(resolvedCwd, gitRoot, false, true),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git action failed';
    res.status(500).json({ error: message, code: 'GIT_ACTION_FAILED' });
  }
});

export default router;
