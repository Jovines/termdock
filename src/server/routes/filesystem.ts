import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import watcher from '@parcel/watcher';
import { pathValidator } from '../utils/pathValidator.js';

const router = Router();

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_IMAGE_PREVIEW_SIZE = 20 * 1024 * 1024; // 20MB
const GIT_TIMEOUT_MS = 5000;
const MAX_DIRECTORY_ENTRIES = 1000;
const MAX_FALLBACK_SEARCH_VISITED = 30_000;
// Content (full-text) search caps so a broad query can't flood the stream/UI.
const MAX_CONTENT_SEARCH_FILES = 1_000;
const MAX_CONTENT_MATCHES_PER_FILE = 50;
const MAX_CONTENT_MATCH_LINE_LENGTH = 400;
const MAX_GIT_CONTEXT_CHANGED_FILES = 200;
const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_UNTRACKED_DIFF_FILE_BYTES = 1024 * 1024; // 1MB
const RESTORE_CONFIRM_PHRASES = new Set(['丢弃改动', 'discard changes']);

type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'unknown';

type GitAction = 'stage-file' | 'stage-all' | 'unstage-file' | 'stash-file' | 'stash-all' | 'restore-worktree-file' | 'commit' | 'push' | 'pull' | 'switch-branch';

interface GitChangedFile {
  path: string;
  absolutePath: string;
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
  error?: string;
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

interface FileSearchEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
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

function compareFileTreeEntries(a: Pick<FileSearchEntry, 'name' | 'type'>, b: Pick<FileSearchEntry, 'name' | 'type'>): number {
  if (a.type === 'directory' && b.type !== 'directory') return -1;
  if (a.type !== 'directory' && b.type === 'directory') return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

const WATCH_IGNORED_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo', 'coverage', 'target', '.gradle', '.idea', '.DS_Store',
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

function toGitPathspec(gitRoot: string, requestedPath: string): string {
  const absoluteCandidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(gitRoot, requestedPath);

  const candidate = fs.existsSync(absoluteCandidate)
    ? pathValidator.validatePath(absoluteCandidate)
    : absoluteCandidate;

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

function getRelativeFileSize(gitRoot: string, filePath: string): number | null {
  try {
    const absolutePath = path.resolve(gitRoot, filePath);
    if (!isPathInside(gitRoot, absolutePath)) return null;
    const stat = fs.statSync(absolutePath);
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

async function getChangedFiles(gitRoot: string): Promise<GitChangedFile[]> {
  const [stagedOutput, unstagedOutput, untrackedOutput] = await Promise.all([
    execGit(['diff', '--cached', '--name-status', '-M', '-C', '--find-copies-harder', '-z'], gitRoot).catch(() => ''),
    execGit(['diff', '--name-status', '-M', '-C', '--find-copies-harder', '-z'], gitRoot).catch(() => ''),
    execGit(['ls-files', '--others', '--exclude-standard', '-z'], gitRoot).catch(() => ''),
  ]);

  const files = new Map<string, GitChangedFile>();
  mergeNameStatus(files, gitRoot, stagedOutput, 'staged');
  mergeNameStatus(files, gitRoot, unstagedOutput, 'unstaged');

  for (const p of untrackedOutput.split('\0').filter(Boolean)) {
    const current = files.get(p) ?? emptyChangedFile(gitRoot, p);
    current.status = 'untracked';
    current.untracked = true;
    current.unstaged = true;
    current.tracked = false;
    files.set(p, current);
  }

  return finalizeChangedFiles(files);
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

async function getGitPushTargets(gitRoot: string) {
  const [remotesOutput, branchesOutput, upstreamOutput, aheadBehindOutput] = await Promise.all([
    execGit(['remote'], gitRoot).catch(() => ''),
    execGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], gitRoot).catch(() => ''),
    execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], gitRoot).catch(() => ''),
    execGit(['rev-list', '--left-right', '--count', '@{u}...HEAD'], gitRoot).catch(() => ''),
  ]);
  const remotes = uniqueSortedLines(remotesOutput);
  const branches = uniqueSortedLines(branchesOutput);
  const upstream = upstreamOutput.trim() || null;
  const { remote: upstreamRemote, branch: upstreamBranch } = splitUpstream(upstream, remotes);
  const { ahead, behind } = parseAheadBehind(aheadBehindOutput, Boolean(upstream));
  return { remotes, branches, upstream, upstreamRemote, upstreamBranch, ahead, behind };
}

async function buildGitBundle(resolvedCwd: string, gitRoot: string): Promise<GitBundlePayload> {
  const [files, branchOutput, statusOutput, logOutput, pushTargets] = await Promise.all([
    getChangedFiles(gitRoot),
    execGit(['branch', '--show-current'], gitRoot).catch(() => ''),
    execGit(['status', '--short', '--branch'], gitRoot).catch(() => ''),
    execGit(['log', '--oneline', '-8'], gitRoot).catch(() => ''),
    getGitPushTargets(gitRoot),
  ]);
  const changedFiles = toContextFiles(files);

  return {
    available: true,
    files,
    context: {
      available: true,
      cwd: resolvedCwd,
      root: gitRoot,
      branch: branchOutput.trim() || null,
      ...pushTargets,
      status: statusOutput.trim(),
      recentCommits: logOutput.split('\n').map((line) => line.trim()).filter(Boolean),
      changedFiles,
      truncated: changedFiles.length >= MAX_GIT_CONTEXT_CHANGED_FILES,
    },
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

function readFilePrefix(filePath: string, bytesToRead: number): string {
  if (bytesToRead <= 0) return '';

  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    fs.closeSync(fd);
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

function toFileEntry(entryPath: string, stat: fs.Stats): FileSearchEntry {
  return {
    name: path.basename(entryPath) || entryPath,
    path: entryPath,
    type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
  };
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

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('git command timed out'));
    }, GIT_TIMEOUT_MS);

    const proc = execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Like execGit, but tolerant of exit code 1.
 * `git diff --no-index` exits 1 when there are differences (which is the
 * normal case for showing an untracked file's content).  We still want the
 * stdout in that case; only treat exit codes >= 2 as real errors.
 */
function execGitNoIndex(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('git command timed out'));
    }, GIT_TIMEOUT_MS);

    const proc = execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      clearTimeout(timer);
      if (err && typeof err.code === 'number' && err.code >= 2) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

// In-memory cache for `git rev-parse --show-toplevel` results.
// Key = requested cwd, Value = { root, expiresAt }. Invalidated quickly so
// directory changes still propagate, but reused within the same UI burst
// (open sidebar fires ~3 git fetches at once).
const GIT_ROOT_CACHE_TTL_MS = 5_000;
const gitRootCache = new Map<string, { root: string | null; expiresAt: number }>();

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

// Directory listing
router.get('/list', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const requestedPath = req.query.path as string;
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const resolvedPath = pathValidator.validatePath(requestedPath);
    const stat = await fs.promises.stat(resolvedPath);

    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' });
      return;
    }

    const showHidden = req.query.showHidden === 'true';
    const allEntries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
    const visibleDirents = allEntries.filter(dirent => showHidden || !dirent.name.startsWith('.'));
    const entries = visibleDirents
      .map((dirent): { name: string; path: string; type: 'file' | 'directory' | 'symlink' } => {
        const fullPath = path.join(resolvedPath, dirent.name);
        return {
          name: dirent.name,
          path: fullPath,
          type: dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file',
        };
      })
      .sort(compareFileTreeEntries)
      .slice(0, MAX_DIRECTORY_ENTRIES);

    res.setHeader('X-Termdock-FS-List-Duration-Ms', String(Date.now() - startedAt));
    res.setHeader('X-Termdock-FS-List-Total', String(visibleDirents.length));
    res.setHeader('X-Termdock-FS-List-Returned', String(entries.length));
    res.json({ path: resolvedPath, entries, truncated: visibleDirents.length > entries.length, total: visibleDirents.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(403).json({ error: message });
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
      const resolved = pathValidator.validatePath(rawRoot);
      const stat = fs.statSync(resolved);
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

// Fast recursive file search for the right sidebar.
// Prefer ripgrep because it respects .gitignore, skips ignored/build folders,
// and is dramatically faster than recursively calling readdir from the browser.
router.get('/search', async (req: Request, res: Response) => {
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  try {
    const requestedPath = req.query.path as string;
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const query = normalizeSearchQuery(req.query.query);
    if (!query) {
      res.json({ path: requestedPath, query: '', entries: [], truncated: false, total: 0, engine: 'rg' });
      return;
    }

    const resolvedPath = pathValidator.validatePath(requestedPath);
    const stat = await fs.promises.stat(resolvedPath);
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
          res.end();
        }
      } catch (error) {
        if (controller.signal.aborted || res.destroyed) return;
        const message = error instanceof Error ? error.message : 'Content search failed';
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
          res.end();
        }
      } catch (error) {
        if (controller.signal.aborted || res.destroyed) return;
        writeSearchEvent(res, 'meta', { path: resolvedPath, query, engine: 'fallback', limited: false });
        const result = await streamSearchWithFallback(resolvedPath, queryLower, showHidden, controller.signal, res);
        if (!controller.signal.aborted && !res.destroyed) {
          writeSearchEvent(res, 'done', { total: result.total, truncated: result.limited, limited: result.limited, engine: 'fallback' });
          res.end();
        }
      }
      return;
    }

    try {
      res.json(await searchWithRipgrep(resolvedPath, queryLower, showHidden, controller.signal));
    } catch (error) {
      if (controller.signal.aborted) return;
      // Graceful fallback for machines without `rg` installed. It is bounded so
      // searching an enormous home directory cannot monopolize the server.
      res.json(await searchWithFallback(resolvedPath, queryLower, showHidden, controller.signal));
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(403).json({ error: message });
  }
});

// Read file content
router.get('/read', async (req: Request, res: Response) => {
  try {
    const requestedPath = req.query.path as string;
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const resolvedPath = pathValidator.validatePath(requestedPath);
    const stat = fs.statSync(resolvedPath);

    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory, not a file' });
      return;
    }

    const bytesToRead = Math.min(stat.size, MAX_FILE_SIZE);
    const truncated = stat.size > bytesToRead;
    const content = readFilePrefix(resolvedPath, bytesToRead);

    res.json({
      path: resolvedPath,
      content,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      truncated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(403).json({ error: message });
  }
});

// Stream supported image files for the right sidebar preview.
router.get('/blob', async (req: Request, res: Response) => {
  try {
    const requestedPath = req.query.path as string;
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const resolvedPath = pathValidator.validatePath(requestedPath);
    const stat = fs.statSync(resolvedPath);

    if (!stat.isFile()) {
      res.status(400).json({ error: 'Path is not a file' });
      return;
    }

    const mimeType = getImageMimeType(resolvedPath);
    if (!mimeType) {
      res.status(415).json({ error: 'Unsupported image type' });
      return;
    }

    if (stat.size > MAX_IMAGE_PREVIEW_SIZE) {
      res.status(413).json({
        error: 'Image is too large to preview',
        code: 'IMAGE_TOO_LARGE',
        size: stat.size,
        maxSize: MAX_IMAGE_PREVIEW_SIZE,
      });
      return;
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size.toString());
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${toInlineFilename(path.basename(resolvedPath))}"`);

    const stream = fs.createReadStream(resolvedPath);
    stream.on('error', (error) => {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : 'Failed to read image';
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
  try {
    const requestedPath = req.query.path as string | undefined;
    const cached = req.query.cached === 'true';
    const cwd = req.query.cwd as string | undefined;

    // Determine the git working directory
    let gitCwd: string | null;
    if (requestedPath && path.isAbsolute(requestedPath)) {
      const resolvedPath = pathValidator.validatePath(requestedPath);
      const stat = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath) : null;
      gitCwd = await findGitRoot(stat?.isDirectory() ? resolvedPath : path.dirname(resolvedPath));
    } else if (cwd) {
      const resolvedCwd = pathValidator.validatePath(cwd);
      gitCwd = await findGitRoot(resolvedCwd);
    } else {
      gitCwd = null;
    }

    if (!gitCwd) {
      res.json({ path: requestedPath ?? null, diff: '', error: 'Not a git repository' });
      return;
    }

    const pathspec = requestedPath ? toGitPathspec(gitCwd, requestedPath) : null;
    const skippedFiles: DiffSkippedFile[] = [];
    const buildDiffArgs = (includeCached: boolean) => {
      const args = ['diff', '-M', '-C', '--find-copies-harder'];
      if (includeCached) args.push('--cached');
      if (pathspec) args.push('--', pathspec);
      return args;
    };

    // Default sidebar diffs should represent every changed file from the list:
    // staged-only changes, unstaged changes, and untracked files. Plain
    // `git diff` only shows unstaged tracked edits, which made staged-only
    // additions/deletions/renames look empty in the UI.
    let diff = cached
      ? await execGit(buildDiffArgs(true), gitCwd).catch(() => '')
      : [
          await execGit(buildDiffArgs(true), gitCwd).catch(() => ''),
          await execGit(buildDiffArgs(false), gitCwd).catch(() => ''),
        ].filter(Boolean).join('\n');

    let totalBytes = getDiffByteLength(diff);

    // If git diff produced no output for a specific file, it might be an
    // untracked (new) file.  Use `git diff --no-index /dev/null <path>` to
    // show the entire file contents as additions, but never for very large
    // files — that would turn a preview request into a full-file transfer.
    // Note: git diff --no-index exits with code 1 when there are differences,
    // but stdout still contains the valid diff text.
    if (!diff && requestedPath && !cached && pathspec) {
      const size = getRelativeFileSize(gitCwd, pathspec);
      if (size !== null && size > MAX_UNTRACKED_DIFF_FILE_BYTES) {
        skippedFiles.push(makeSkippedUntracked(pathspec, size));
      } else {
        diff = await execGitNoIndex(['diff', '--no-index', '--', '/dev/null', pathspec], gitCwd).catch(() => '');
        totalBytes = getDiffByteLength(diff);
      }
    }

    // When viewing the full repo diff (no specific file), also append diffs
    // for untracked files — `git diff` silently skips them. Keep both per-file
    // and aggregate byte caps so an accidental large generated file doesn't
    // dominate the network response or freeze react-diff-view parsing.
    if (!requestedPath && !cached && totalBytes <= MAX_DIFF_BYTES) {
      const untracked = await execGit(['ls-files', '--others', '--exclude-standard', '-z'], gitCwd).catch(() => '');
      for (const p of untracked.split('\0').filter(Boolean)) {
        const size = getRelativeFileSize(gitCwd, p);
        if (size !== null && size > MAX_UNTRACKED_DIFF_FILE_BYTES) {
          skippedFiles.push(makeSkippedUntracked(p, size));
          continue;
        }
        const partial = await execGitNoIndex(['diff', '--no-index', '--', '/dev/null', p], gitCwd).catch(() => '');
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

    res.json(truncateDiffIfNeeded({
      path: requestedPath ?? null,
      diff,
      skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
      truncated: skippedFiles.length > 0 ? true : undefined,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.json({ path: req.query.path ?? null, diff: '', error: message });
  }
});

// List changed files across staged, unstaged, and untracked state.
router.get('/diff-files', async (req: Request, res: Response) => {
  try {
    const cwd = req.query.cwd as string | undefined;
    if (!cwd) {
      res.json({ files: [], error: 'No cwd provided' });
      return;
    }

    const resolvedCwd = pathValidator.validatePath(cwd);
    const gitCwd = await findGitRoot(resolvedCwd);
    if (!gitCwd) {
      res.json({ files: [], error: 'Not a git repository' });
      return;
    }

    res.json({ files: await getChangedFiles(gitCwd) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.json({ files: [], error: message });
  }
});

// Lightweight git context for AI prompts / multi-agent handoff
router.get('/git-context', async (req: Request, res: Response) => {
  try {
    const cwd = req.query.cwd as string | undefined;
    if (!cwd) {
      res.json({ available: false, error: 'No cwd provided' });
      return;
    }

    const resolvedCwd = pathValidator.validatePath(cwd);
    const gitRoot = await findGitRoot(resolvedCwd);
    if (!gitRoot) {
      res.json({ available: false, cwd: resolvedCwd, error: 'Not a git repository' });
      return;
    }

    const [branchOutput, statusOutput, logOutput, pushTargets] = await Promise.all([
      execGit(['branch', '--show-current'], gitRoot).catch(() => ''),
      execGit(['status', '--short', '--branch'], gitRoot).catch(() => ''),
      execGit(['log', '--oneline', '-8'], gitRoot).catch(() => ''),
      getGitPushTargets(gitRoot),
    ]);

    const files = await getChangedFiles(gitRoot);
    const changedFiles = toContextFiles(files);

    res.json({
      available: true,
      cwd: resolvedCwd,
      root: gitRoot,
      branch: branchOutput.trim() || null,
      ...pushTargets,
      status: statusOutput.trim(),
      recentCommits: logOutput.split('\n').map((line) => line.trim()).filter(Boolean),
      changedFiles,
      truncated: changedFiles.length >= MAX_GIT_CONTEXT_CHANGED_FILES,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.json({ available: false, error: message });
  }
});

// Combined payload for sidebar open — returns diff-files and git-context
// in one round-trip. Front-end fires this once when opening the right
// sidebar instead of two parallel requests, and the server reuses the
// resolved git root rather than running `rev-parse` twice.
router.get('/git-bundle', async (req: Request, res: Response) => {
  try {
    const cwd = req.query.cwd as string | undefined;
    if (!cwd) {
      res.json({ available: false, files: [], context: null, error: 'No cwd provided' });
      return;
    }

    const resolvedCwd = pathValidator.validatePath(cwd);
    const gitRoot = await findGitRoot(resolvedCwd);
    if (!gitRoot) {
      res.json({
        available: false,
        files: [],
        context: { available: false, cwd: resolvedCwd, error: 'Not a git repository' },
      });
      return;
    }

    res.json(await buildGitBundle(resolvedCwd, gitRoot));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.json({ available: false, files: [], context: null, error: message });
  }
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

    const resolvedCwd = pathValidator.validatePath(cwd);
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
      const pathspec = toGitPathspec(gitRoot, requestedPath);

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

    res.json({
      ok: true,
      action,
      message: output.trim() || 'Git action completed',
      output,
      bundle: await buildGitBundle(resolvedCwd, gitRoot),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git action failed';
    res.status(500).json({ error: message, code: 'GIT_ACTION_FAILED' });
  }
});

export default router;
