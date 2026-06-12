import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { pathValidator } from '../utils/pathValidator.js';

const router = Router();

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_IMAGE_PREVIEW_SIZE = 20 * 1024 * 1024; // 20MB
const GIT_TIMEOUT_MS = 5000;
const MAX_DIRECTORY_ENTRIES = 1000;
const MAX_GIT_CONTEXT_CHANGED_FILES = 200;
const RESTORE_CONFIRM_PHRASES = new Set(['丢弃改动', 'discard changes']);

type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'unknown';

type GitAction = 'stage-file' | 'stage-all' | 'unstage-file' | 'stash-file' | 'stash-all' | 'restore-worktree-file';

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
    status?: string;
    recentCommits?: string[];
    changedFiles?: Array<{ path: string; absolutePath: string; status: string }>;
    truncated?: boolean;
    error?: string;
  } | null;
  error?: string;
}

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

function normalizeNameStatus(status: string): GitChangeStatus {
  if (status.startsWith('R')) return 'renamed';
  if (status.startsWith('A')) return 'added';
  if (status.startsWith('D')) return 'deleted';
  if (status.startsWith('U')) return 'conflicted';
  if (status.includes('U')) return 'conflicted';
  if (status.startsWith('?')) return 'untracked';
  if (status.startsWith('M') || status.startsWith('T')) return 'modified';
  return 'modified';
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
    if (rawStatus.startsWith('R')) {
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
      status: file.untracked ? 'untracked' : file.status === 'unknown' ? 'modified' : file.status,
      canStage: file.unstaged || file.untracked,
      canUnstage: file.staged,
      canStash: file.unstaged || file.untracked,
      canRestoreWorktree: file.tracked && file.unstaged && !file.untracked,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function getChangedFiles(gitRoot: string): Promise<GitChangedFile[]> {
  const [stagedOutput, unstagedOutput, untrackedOutput] = await Promise.all([
    execGit(['diff', '--cached', '--name-status', '-z'], gitRoot).catch(() => ''),
    execGit(['diff', '--name-status', '-z'], gitRoot).catch(() => ''),
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

async function buildGitBundle(resolvedCwd: string, gitRoot: string): Promise<GitBundlePayload> {
  const [files, branchOutput, statusOutput, logOutput] = await Promise.all([
    getChangedFiles(gitRoot),
    execGit(['branch', '--show-current'], gitRoot).catch(() => ''),
    execGit(['status', '--short', '--branch'], gitRoot).catch(() => ''),
    execGit(['log', '--oneline', '-8'], gitRoot).catch(() => ''),
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
      .sort((a, b) => {
        // Directories first, then files, alphabetical within each group
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_DIRECTORY_ENTRIES);

    res.json({ path: resolvedPath, entries, truncated: visibleDirents.length > entries.length, total: visibleDirents.length });
  } catch (error) {
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

    const args = ['diff'];
    if (cached) args.push('--cached');
    if (requestedPath) args.push('--', toGitPathspec(gitCwd, requestedPath));

    let diff = await execGit(args, gitCwd).catch(() => '');

    // If git diff produced no output for a specific file, it might be an
    // untracked (new) file.  Use `git diff --no-index /dev/null <path>` to
    // show the entire file contents as additions.
    // Note: git diff --no-index exits with code 1 when there are differences,
    // but stdout still contains the valid diff text.
    if (!diff && requestedPath && !cached) {
      const relPath = toGitPathspec(gitCwd, requestedPath);
      diff = await execGitNoIndex(['diff', '--no-index', '--', '/dev/null', relPath], gitCwd).catch(() => '');
    }

    // When viewing the full repo diff (no specific file), also append diffs
    // for untracked files — `git diff` silently skips them.
    if (!requestedPath && !cached) {
      const untracked = await execGit(['ls-files', '--others', '--exclude-standard', '-z'], gitCwd).catch(() => '');
      for (const p of untracked.split('\0').filter(Boolean)) {
        const partial = await execGitNoIndex(['diff', '--no-index', '--', '/dev/null', p], gitCwd).catch(() => '');
        if (partial) diff += '\n' + partial;
      }
    }

    res.json({ path: requestedPath ?? null, diff });
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

    const [branchOutput, statusOutput, logOutput] = await Promise.all([
      execGit(['branch', '--show-current'], gitRoot).catch(() => ''),
      execGit(['status', '--short', '--branch'], gitRoot).catch(() => ''),
      execGit(['log', '--oneline', '-8'], gitRoot).catch(() => ''),
    ]);

    const files = await getChangedFiles(gitRoot);
    const changedFiles = toContextFiles(files);

    res.json({
      available: true,
      cwd: resolvedCwd,
      root: gitRoot,
      branch: branchOutput.trim() || null,
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
    if (!action || !['stage-file', 'stage-all', 'unstage-file', 'stash-file', 'stash-all', 'restore-worktree-file'].includes(action)) {
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
