/**
 * Termdock 启动自检 — 确保原生模块和系统依赖在启动时可用
 *
 * 设计目标：覆盖 npm 全局安装不跑 postinstall 的缺口。
 * 每次 CLI 启动时检查，通过后写 marker 避免重复检查。
 *
 * 检查项目：
 *   1. node-pty : 实际 spawn 测试 → 失败则从源码重编译
 *   2. tmux     : 检测是否安装 → 缺失则尝试自动安装
 *
 * —— 如何新增检查项 ——
 *   在 BootChecks 接口加字段，在 runBootChecks() 加 step，
 *   在 formatBootCheckReport() 加对应的输出行。
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PtyCheckResult {
  ok: boolean;
  rebuilt: boolean;
  error?: string;
}

export interface TmuxCheckResult {
  ok: boolean;
  installed: boolean;
  version?: string;
  error?: string;
}

export interface BootChecks {
  nodePty: PtyCheckResult;
  tmux: TmuxCheckResult;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MARKER_FILE = path.join(os.homedir(), '.termdock', '.boot-check-ok');

function which(bin: string): string | null {
  // 先查 PATH
  try {
    const result = execSync(`command -v ${bin} 2>/dev/null`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (result) return result;
  } catch { /* not in PATH */ }

  // macOS non-interactive SSH 的 PATH 不包含 Homebrew 路径，手动检查
  const extraPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',    // MacPorts
  ];
  for (const dir of extraPaths) {
    const fullPath = path.join(dir, bin);
    try {
      fs.accessSync(fullPath, fs.constants.X_OK);
      return fullPath;
    } catch { /* not here */ }
  }
  return null;
}

function runQuiet(cmd: string, timeoutMs = 30_000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = spawnSync(cmd, [], {
      shell: true,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
  } catch {
    return { ok: false, stdout: '', stderr: '' };
  }
}

// ---------------------------------------------------------------------------
// 1. node-pty 验证 + 重建
// ---------------------------------------------------------------------------

function checkNodePty(): PtyCheckResult {
  const result: PtyCheckResult = { ok: false, rebuilt: false };

  try {
    const require_ = createRequire(import.meta.url);
    let ptyPath: string;
    try {
      ptyPath = require_.resolve('node-pty/package.json').replace('/package.json', '');
    } catch {
      result.error = 'node-pty not found in module resolution path';
      return result;
    }
    const pty = require_(ptyPath);

    // 实际 spawn 测试（不仅仅是 require，macOS ARM 预编译包可能 require 成功但 spawn 失败）
    const proc = pty.spawn(process.env.SHELL || '/bin/bash', [], { name: 'xterm', cols: 80, rows: 24 });
    proc.kill();
    result.ok = true;
    return result;
  } catch (e) {
    // require 失败或 spawn 失败 → 尝试重编译
  }

  try {
    const require_ = createRequire(import.meta.url);
    let ptyPath: string;
    try {
      ptyPath = require_.resolve('node-pty/package.json').replace('/package.json', '');
    } catch {
      result.error = 'node-pty not found in module resolution path';
      return result;
    }

    // 清除预编译二进制缓存
    const prebuildsDir = path.join(ptyPath, 'prebuilds');
    if (fs.existsSync(prebuildsDir)) {
      fs.rmSync(prebuildsDir, { recursive: true, force: true });
    }

    const rebuild = runQuiet(`cd ${ptyPath} && npx --yes node-gyp rebuild`, 120_000);
    if (rebuild.ok) {
      // 重试 spawn
      try {
        const pty = require_(ptyPath);
        const proc = pty.spawn(process.env.SHELL || '/bin/bash', [], { name: 'xterm', cols: 80, rows: 24 });
        proc.kill();
        result.ok = true;
        result.rebuilt = true;
        return result;
      } catch {
        result.error = 'node-pty 重编译成功但 spawn 仍然失败';
        return result;
      }
    }
    result.error = `node-pty 重编译失败: ${rebuild.stderr.slice(0, 200)}`;
    return result;
  } catch (e) {
    result.error = `node-pty 未找到或无法初始化: ${String(e).slice(0, 200)}`;
    return result;
  }
}

// ---------------------------------------------------------------------------
// 2. tmux 检测 + 自动安装
// ---------------------------------------------------------------------------

function checkTmux(): TmuxCheckResult {
  const result: TmuxCheckResult = { ok: false, installed: false };

  // 先检查是否已安装
  const tmuxPath = which('tmux');
  if (tmuxPath) {
    try {
      result.version = execSync('tmux -V', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { /* ignore */ }
    result.ok = true;
    result.installed = false; // 没有新安装
    return result;
  }

  // —— 尝试自动安装 ——
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: 尝试多个包管理器
    const brew = which('brew');
    if (brew) {
      const r = runQuiet(`${brew} install tmux 2>&1`, 120_000);
      if (r.ok || which('tmux')) {
        try {
          result.version = execSync('tmux -V', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* ignore */ }
        result.ok = true;
        result.installed = true;
        return result;
      }
    }

    const port = which('port'); // MacPorts
    if (port) {
      const r = runQuiet(`${port} install tmux 2>&1`, 120_000);
      if (r.ok || which('tmux')) {
        try {
          result.version = execSync('tmux -V', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* ignore */ }
        result.ok = true;
        result.installed = true;
        return result;
      }
    }

    const nixEnv = which('nix-env');
    if (nixEnv) {
      const r = runQuiet(`${nixEnv} -iA nixpkgs.tmux 2>&1`, 120_000);
      if (r.ok || which('tmux')) {
        try {
          result.version = execSync('tmux -V', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* ignore */ }
        result.ok = true;
        result.installed = true;
        return result;
      }
    }

    result.error = 'tmux 未安装且未找到包管理器 (brew/port/nix)。请安装 Homebrew: https://brew.sh';
    return result;
  }

  if (platform === 'linux') {
    // 尝试多种 Linux 包管理器
    const managers = [
      { bin: 'apt-get',  cmd: 'apt-get install -y tmux' },
      { bin: 'dnf',      cmd: 'dnf install -y tmux' },
      { bin: 'yum',      cmd: 'yum install -y tmux' },
      { bin: 'apk',      cmd: 'apk add tmux' },
      { bin: 'pacman',   cmd: 'pacman -S --noconfirm tmux' },
      { bin: 'zypper',   cmd: 'zypper install -y tmux' },
    ];

    for (const m of managers) {
      if (!which(m.bin)) continue;
      // 需要 root 权限
      const r = runQuiet(`sudo ${m.cmd} 2>&1`, 120_000);
      if (r.ok || which('tmux')) {
        try {
          result.version = execSync('tmux -V', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* ignore */ }
        result.ok = true;
        result.installed = true;
        return result;
      }
      // 也试一下不用 sudo
      const r2 = runQuiet(`${m.cmd} 2>&1`, 120_000);
      if (r2.ok || which('tmux')) {
        try {
          result.version = execSync('tmux -V', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* ignore */ }
        result.ok = true;
        result.installed = true;
        return result;
      }
    }

    result.error = 'tmux 未安装。请用系统包管理器安装，例如: sudo apt install tmux';
    return result;
  }

  // 其他平台
  result.error = `不支持在 ${platform} 上自动安装 tmux。请手动安装。`;
  return result;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

let _cachedResult: BootChecks | null = null;

export function runBootChecks(): BootChecks {
  if (_cachedResult) return _cachedResult;

  // 如果 marker 存在且有效，读取缓存的检查结果
  if (fs.existsSync(MARKER_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf-8'));
      if (cached.nodePty?.ok && cached.tmux?.ok) {
        _cachedResult = {
          nodePty: cached.nodePty,
          tmux: cached.tmux,
        };
        return _cachedResult;
      }
      // marker 存在但状态不完整（例如 postinstall 部分失败）→ 重新检查
    } catch { /* marker 损坏 → 重新检查 */ }
  }

  const nodePty = checkNodePty();
  const tmux = checkTmux();

  _cachedResult = { nodePty, tmux };

  // 全部通过则写 marker
  if (nodePty.ok && tmux.ok) {
    try {
      fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
      fs.writeFileSync(MARKER_FILE, JSON.stringify({ checkedAt: new Date().toISOString(), nodePty, tmux }), 'utf-8');
    } catch { /* 非关键 */ }
  }

  return _cachedResult;
}

export function getBootChecks(): BootChecks {
  return _cachedResult ?? runBootChecks();
}

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
