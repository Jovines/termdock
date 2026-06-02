import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { pathValidator } from '../utils/pathValidator.js';

const router = Router();

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const GIT_TIMEOUT_MS = 5000;
const MAX_DIRECTORY_ENTRIES = 1000;
const MAX_GIT_CONTEXT_CHANGED_FILES = 200;

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

    const diff = await execGit(args, gitCwd);
    res.json({ path: requestedPath ?? null, diff });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.json({ path: req.query.path ?? null, diff: '', error: message });
  }
});

// List changed files (git diff --name-status)
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

    const output = await execGit(['diff', '--name-status', '-z'], gitCwd);

    const tokens = output.split('\0').filter(Boolean);
    const files: Array<{ path: string; absolutePath: string; status: string; oldPath?: string }> = [];
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i++];
      if (!status) break;

      if (status.startsWith('R')) {
        const oldPath = tokens[i++];
        const newPath = tokens[i++];
        if (newPath) {
          files.push({ path: newPath, absolutePath: path.join(gitCwd, newPath), status: 'renamed', ...(oldPath ? { oldPath } : {}) });
        }
        continue;
      }

      const filePath = tokens[i++];
      if (!filePath) continue;
      files.push({
        path: filePath,
        absolutePath: path.join(gitCwd, filePath),
        status: status.startsWith('A') ? 'added' :
                status.startsWith('D') ? 'deleted' : 'modified',
      });
    }

    res.json({ files });
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

    const changedFiles = statusOutput
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_GIT_CONTEXT_CHANGED_FILES)
      .map((line) => {
        const status = line.slice(0, 2).trim() || line.slice(0, 1).trim();
        const file = line.slice(2).trim().replace(/^"|"$/g, '');
        const renameParts = file.split(' -> ');
        const filePath = renameParts[renameParts.length - 1] || file;
        return { path: filePath, absolutePath: path.join(gitRoot, filePath), status };
      });

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

    const [diffNameStatus, branchOutput, statusOutput, logOutput] = await Promise.all([
      execGit(['diff', '--name-status', '-z'], gitRoot).catch(() => ''),
      execGit(['branch', '--show-current'], gitRoot).catch(() => ''),
      execGit(['status', '--short', '--branch'], gitRoot).catch(() => ''),
      execGit(['log', '--oneline', '-8'], gitRoot).catch(() => ''),
    ]);

    // Parse diff --name-status -z
    const tokens = diffNameStatus.split('\0').filter(Boolean);
    const files: Array<{ path: string; absolutePath: string; status: string; oldPath?: string }> = [];
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i++];
      if (!status) break;
      if (status.startsWith('R')) {
        const oldPath = tokens[i++];
        const newPath = tokens[i++];
        if (newPath) {
          files.push({ path: newPath, absolutePath: path.join(gitRoot, newPath), status: 'renamed', ...(oldPath ? { oldPath } : {}) });
        }
        continue;
      }
      const filePath = tokens[i++];
      if (!filePath) continue;
      files.push({
        path: filePath,
        absolutePath: path.join(gitRoot, filePath),
        status: status.startsWith('A') ? 'added' : status.startsWith('D') ? 'deleted' : 'modified',
      });
    }

    // Parse status --short --branch for context
    const changedFiles = statusOutput
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_GIT_CONTEXT_CHANGED_FILES)
      .map((line) => {
        const status = line.slice(0, 2).trim() || line.slice(0, 1).trim();
        const file = line.slice(2).trim().replace(/^"|"$/g, '');
        const renameParts = file.split(' -> ');
        const filePath = renameParts[renameParts.length - 1] || file;
        return { path: filePath, absolutePath: path.join(gitRoot, filePath), status };
      });

    res.json({
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.json({ available: false, files: [], context: null, error: message });
  }
});

export default router;
