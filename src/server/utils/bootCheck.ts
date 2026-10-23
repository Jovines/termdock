import { ensureNodePty } from './ensureNodePty.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export interface PtyCheckResult { ok: boolean; rebuilt: boolean; error?: string }
export interface TmuxCheckResult { ok: boolean; installed: boolean; version?: string; error?: string }
export interface BootChecks { nodePty: PtyCheckResult; tmux: TmuxCheckResult }

const require = createRequire(import.meta.url);
const tools = require('../../../scripts/install-utils.cjs') as {
  checkTmux(): TmuxCheckResult;
  probeNodePty(root: string): void;
  clearPtyModuleCache(root: string): void;
};
const { rebuildNodePty } = require('../../../scripts/ensure-node-pty.cjs') as {
  rebuildNodePty(root: string, options?: { timeout?: number }): void;
};
const MARKER_FILE = path.join(os.homedir(), '.termdock', '.boot-check-ok');

function checkNodePty(): PtyCheckResult {
  let ptyPath: string;
  try {
    // Never bypass the Darwin FD patch after a repair failure.
    ensureNodePty();
    ptyPath = path.dirname(require.resolve('node-pty/package.json'));
  } catch (error) { return { ok: false, rebuilt: false, error: String(error) }; }
  try { tools.probeNodePty(ptyPath); return { ok: true, rebuilt: false }; }
  catch { /* An incompatible addon needs a rebuild in a non-global npx. */ }
  try {
    fs.rmSync(path.join(ptyPath, 'prebuilds'), { recursive: true, force: true });
    rebuildNodePty(ptyPath, { timeout: 120_000 });
    tools.clearPtyModuleCache(ptyPath);
    tools.probeNodePty(ptyPath);
    return { ok: true, rebuilt: true };
  } catch (error) { return { ok: false, rebuilt: false, error: String(error) }; }
}

let cachedResult: BootChecks | null = null;
export function runBootChecks(): BootChecks {
  if (cachedResult) return cachedResult;
  // The on-disk marker is diagnostic only. Node upgrades, a removed tmux, or
  // another installation must never be accepted solely because it says "ok".
  const nodePty = checkNodePty(), tmux = tools.checkTmux();
  cachedResult = { nodePty, tmux };
  if (nodePty.ok && tmux.ok) {
    try {
      fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(MARKER_FILE, JSON.stringify({ checkedAt: new Date().toISOString(), nodePty, tmux,
        runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch } }), { mode: 0o600 });
    } catch { /* A read-only home does not prevent running the terminal. */ }
  } else {
    try { fs.rmSync(MARKER_FILE, { force: true }); } catch { /* Diagnostic only. */ }
  }
  return cachedResult;
}
export function getBootChecks(): BootChecks { return cachedResult ?? runBootChecks(); }

/**
 * 格式化启动检查报告，用于 CLI 启动时显示给用户。
 */
export function formatBootCheckReport(checks: BootChecks, enableColor: boolean): string[] {
  const lines: string[] = [];
  const g = (s: string) => enableColor ? `\x1b[32m${s}\x1b[0m` : s;
  const y = (s: string) => enableColor ? `\x1b[33m${s}\x1b[0m` : s;
  const r = (s: string) => enableColor ? `\x1b[31m${s}\x1b[0m` : s;
  const dim = (s: string) => enableColor ? `\x1b[2m${s}\x1b[0m` : s;

  // node-pty
  if (checks.nodePty.ok) {
    const tag = checks.nodePty.rebuilt ? ' (rebuilt)' : '';
    lines.push(`  ${g('✓')} node-pty${dim(tag)}`);
  } else {
    lines.push(`  ${r('✗')} node-pty — ${checks.nodePty.error || 'unknown'}`);
  }

  // tmux
  if (checks.tmux.ok) {
    const detail = checks.tmux.installed
      ? ' (just installed)'
      : checks.tmux.version
        ? ` ${dim(checks.tmux.version)}`
        : '';
    lines.push(`  ${g('✓')} tmux${detail}`);
  } else {
    lines.push(`  ${y('!')} tmux — ${checks.tmux.error || 'not found'} (shell mode will be used)`);
  }

  return lines;
}
