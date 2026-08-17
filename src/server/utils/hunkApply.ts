import { spawn } from 'child_process';

// Hunk-level git operations (IntelliJ-style diff gutter actions). The client
// extracts one hunk from a diff we previously served and posts it back; we
// feed it to `git apply` over stdin (no temp files, no shell).
export type HunkApplyMode = 'stage' | 'revert-worktree' | 'revert-staged';

export const HUNK_APPLY_MODES: readonly HunkApplyMode[] = ['stage', 'revert-worktree', 'revert-staged'];

export const MAX_HUNK_PATCH_BYTES = 1024 * 1024; // 1MB, aligned with MAX_DIFF_BYTES

export class GitApplyError extends Error {
  readonly code = 'GIT_APPLY_FAILED';
  readonly stderr: string;

  constructor(stderr: string, exitCode: number | null) {
    super(stderr.trim() || `git apply exited with code ${exitCode ?? 'unknown'}`);
    this.name = 'GitApplyError';
    this.stderr = stderr;
  }
}

export function buildGitApplyArgs(mode: HunkApplyMode): string[] {
  // Array form only — never through a shell. `--` pathspec limiting is not
  // supported by git apply; confinement comes from validateHunkPatch instead.
  switch (mode) {
    case 'stage':
      return ['apply', '--cached'];
    case 'revert-worktree':
      return ['apply', '-R'];
    case 'revert-staged':
      return ['apply', '-R', '--cached'];
  }
}

// Decode git's C-style quoted paths ("a/weird\tname"). Returns null when the
// quoting is malformed so validation can fail closed.
function unquoteGitPath(raw: string): string | null {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return null;
  let out = '';
  for (let i = 1; i < raw.length - 1; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= raw.length - 1) return null;
    const esc = raw[i];
    switch (esc) {
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      default: {
        if (esc >= '0' && esc <= '7') {
          const octal = raw.slice(i, i + 3);
          if (/^[0-7]{3}$/.test(octal) && i + 2 < raw.length) {
            out += String.fromCharCode(parseInt(octal, 8));
            i += 2;
            break;
          }
        }
        return null;
      }
    }
  }
  return out;
}

// Normalize a path as it appears after `--- `/`+++ `/`rename from ` etc.
// Returns the plain repo-relative path, '/dev/null', or null when malformed.
function normalizePatchPath(raw: string, prefix: 'a' | 'b' | null): string | null {
  let value = raw.trimEnd();
  // Traditional diffs may append a tab-separated timestamp; our patches come
  // from `git diff`, but be lenient.
  const tabIndex = value.indexOf('\t');
  if (tabIndex >= 0) value = value.slice(0, tabIndex);
  if (value === '/dev/null') return '/dev/null';
  if (value.startsWith('"')) {
    const unquoted = unquoteGitPath(value);
    if (unquoted === null) return null;
    value = unquoted;
  }
  if (prefix && value.startsWith(`${prefix}/`)) return value.slice(prefix.length + 1);
  // Bare path without the a/ b/ prefix (e.g. from `rename from`).
  if (!prefix) return value;
  return null;
}

export type HunkPatchValidation = { ok: true } | { ok: false; error: string };

// Fail-closed validation: the patch must be a unified diff with at least one
// hunk, and every file it touches (---/+++, rename/copy headers) must be the
// validated pathspec. This confines the client-supplied patch to the single
// file the request was authorized for. Note git apply additionally
// cross-checks `diff --git` names against ---/+++ and refuses inconsistencies.
export function validateHunkPatch(patchText: string, pathspec: string): HunkPatchValidation {
  if (!patchText || !patchText.trim()) return { ok: false, error: 'Patch is empty' };
  if (Buffer.byteLength(patchText, 'utf8') > MAX_HUNK_PATCH_BYTES) {
    return { ok: false, error: `Patch exceeds ${MAX_HUNK_PATCH_BYTES} bytes` };
  }

  const touchedPaths: string[] = [];
  let hunkCount = 0;
  let hasOldHeader = false;
  let hasNewHeader = false;

  for (const line of patchText.split('\n')) {
    if (line.startsWith('@@ ')) {
      hunkCount += 1;
      continue;
    }
    let raw: string | null = null;
    let prefix: 'a' | 'b' | null = null;
    if (line.startsWith('--- ')) {
      raw = line.slice(4);
      prefix = 'a';
      hasOldHeader = true;
    } else if (line.startsWith('+++ ')) {
      raw = line.slice(4);
      prefix = 'b';
      hasNewHeader = true;
    } else if (line.startsWith('rename from ')) {
      raw = line.slice('rename from '.length);
    } else if (line.startsWith('copy from ')) {
      raw = line.slice('copy from '.length);
    } else if (line.startsWith('rename to ')) {
      raw = line.slice('rename to '.length);
    } else if (line.startsWith('copy to ')) {
      raw = line.slice('copy to '.length);
    }
    if (raw === null) continue;
    const normalized = normalizePatchPath(raw, prefix);
    if (normalized === null) return { ok: false, error: `Malformed patch header: ${line.slice(0, 120)}` };
    if (normalized !== '/dev/null') touchedPaths.push(normalized);
  }

  if (!hasOldHeader || !hasNewHeader) return { ok: false, error: 'Patch is missing ---/+++ file headers' };
  if (hunkCount === 0) return { ok: false, error: 'Patch contains no hunks' };
  for (const touched of touchedPaths) {
    if (touched !== pathspec) {
      return { ok: false, error: `Patch touches unexpected path "${touched}" (allowed: "${pathspec}")` };
    }
  }
  return { ok: true };
}

export function runGitApply(gitRoot: string, mode: HunkApplyMode, patchText: string, timeoutMs: number): Promise<string> {
  const args = buildGitApplyArgs(mode);
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const proc = spawn('git', args, { cwd: gitRoot, stdio: ['pipe', 'pipe', 'pipe'] });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      proc.kill();
      finish(() => reject(new Error('git apply timed out')));
    }, timeoutMs);

    proc.on('error', (error) => {
      finish(() => reject(error));
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64 * 1024) stderr = stderr.slice(0, 64 * 1024);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        finish(() => resolve(''));
      } else {
        finish(() => reject(new GitApplyError(stderr, code)));
      }
    });
    proc.stdin.on('error', () => {
      // E.g. EPIPE when git exits before reading all input; the close handler
      // reports the real failure.
    });
    proc.stdin.write(patchText.endsWith('\n') ? patchText : `${patchText}\n`);
    proc.stdin.end();
  });
}
