import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { pathValidator } from '../utils/pathValidator.js';

const router = Router();

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const GIT_TIMEOUT_MS = 5000;

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

/** Find the top-level directory of the git repo containing `cwd`, or null. */
async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const root = await execGit(['rev-parse', '--show-toplevel'], cwd);
    return root.trim() || null;
  } catch {
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
    const stat = fs.statSync(resolvedPath);

    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' });
      return;
    }

    const showHidden = req.query.showHidden === 'true';
    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
      .filter(dirent => showHidden || !dirent.name.startsWith('.'))
      .map(dirent => {
        const fullPath = path.join(resolvedPath, dirent.name);
        const entry: {
          name: string;
          path: string;
          type: 'file' | 'directory' | 'symlink';
          size?: number;
          modified?: string;
        } = {
          name: dirent.name,
          path: fullPath,
          type: dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file',
        };

        try {
          const s = fs.statSync(fullPath);
          if (entry.type === 'file') entry.size = s.size;
          entry.modified = s.mtime.toISOString();
        } catch {
          // skip stat for inaccessible entries
        }

        return entry;
      })
      .sort((a, b) => {
        // Directories first, then files, alphabetical within each group
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ path: resolvedPath, entries });
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
    if (requestedPath) {
      const resolvedPath = pathValidator.validatePath(requestedPath);
      const stat = fs.statSync(resolvedPath);
      gitCwd = await findGitRoot(stat.isDirectory() ? resolvedPath : path.dirname(resolvedPath));
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
    if (requestedPath) args.push('--', requestedPath);

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
    const files: Array<{ path: string; status: string; oldPath?: string }> = [];
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i++];
      if (!status) break;

      if (status.startsWith('R')) {
        const oldPath = tokens[i++];
        const newPath = tokens[i++];
        if (newPath) {
          files.push({ path: newPath, status: 'renamed', ...(oldPath ? { oldPath } : {}) });
        }
        continue;
      }

      const filePath = tokens[i++];
      if (!filePath) continue;
      files.push({
        path: filePath,
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

export default router;
