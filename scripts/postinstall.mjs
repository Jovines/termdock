#!/usr/bin/env node

/**
 * Termdock postinstall — 确保原生模块可用 + 自动安装 tmux
 *
 * 对于 npm 全局安装 (npm i -g termdock) 的场景，npm 10+ 默认不运行
 * lifecycle scripts。此时 postinstall 不会执行，但 cli.ts 启动时的
 * bootCheck 会做同样的检查并写入 marker，确保首次启动时一切就绪。
 */

import { execSync, spawnSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require_ = createRequire(import.meta.url);
const pkgRoot = new URL('..', import.meta.url).pathname;

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

function runOk(cmd, opts = {}) {
  try { run(cmd, opts); return true; } catch { return false; }
}

function runQuiet(cmd, timeoutMs = 30_000) {
  try {
    const r = spawnSync(cmd, [], { shell: true, timeout: timeoutMs, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
  } catch {
    return { ok: false, stdout: '', stderr: '' };
  }
}

function which(bin) {
  try { execSync(`command -v ${bin} 2>/dev/null`, { stdio: 'pipe' }); return true; } catch { /* not in PATH */ }
  // macOS non-interactive SSH 的 PATH 不含 Homebrew，手动探测
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  for (const dir of extraPaths) {
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { /* not here */ }
  }
  return false;
}

// —— native modules: 实际 spawn 测试，不只是 require ——
console.log('\n=== Rebuilding native modules ===');

const PTY_PATH = require_.resolve('node-pty/package.json', { paths: [pkgRoot] }).replace('/package.json', '');
function testPty() {
  try {
    const pty = require_(PTY_PATH);
    const proc = pty.spawn(process.env.SHELL || '/bin/bash', [], { name: 'xterm', cols: 80, rows: 24 });
    proc.kill();
    return true;
  } catch { return false; }
}

if (testPty()) {
  console.log('  node-pty OK');
} else {
  console.log('  node-pty needs rebuild (prebuilt binary incompatible with this OS/Node version)...');
  runOk(`rm -rf ${PTY_PATH}/prebuilds/*`);
  run(`cd ${PTY_PATH} && npx --yes node-gyp rebuild`, { timeout: 120_000 });
  if (testPty()) {
    console.log('  ✓ node-pty rebuilt successfully');
  } else {
    console.log('  ⚠ node-pty rebuild failed — terminal shell spawn may not work.');
  }
}

// —— tmux ——
console.log('\n=== Checking tmux ===');
if (!which('tmux')) {
  console.log('  tmux not found, attempting auto-install...');
  const platform = process.platform;
  let installed = false;

  if (platform === 'darwin') {
    // macOS: try brew → macports → nix, in that order
    const brew = which('brew');
    if (brew) {
      installed = runOk('brew install tmux 2>&1', { timeout: 120_000 });
    } else if (which('port')) {
      installed = runOk('port install tmux 2>&1', { timeout: 120_000 });
    } else if (which('nix-env')) {
      installed = runOk('nix-env -iA nixpkgs.tmux 2>&1', { timeout: 120_000 });
    } else {
      console.log('  No package manager found (brew/port/nix).');
      console.log('  Install Homebrew: https://brew.sh — then reinstall termdock.');
    }
  } else if (platform === 'linux') {
    const managers = [
      { bin: 'apt-get',  cmd: 'apt-get install -y tmux', sudo: true },
      { bin: 'dnf',      cmd: 'dnf install -y tmux', sudo: true },
      { bin: 'yum',      cmd: 'yum install -y tmux', sudo: true },
      { bin: 'apk',      cmd: 'apk add tmux', sudo: false },
      { bin: 'pacman',   cmd: 'pacman -S --noconfirm tmux', sudo: true },
      { bin: 'zypper',   cmd: 'zypper install -y tmux', sudo: true },
    ];
    for (const m of managers) {
      if (!which(m.bin)) continue;
      const cmd = m.sudo ? `sudo ${m.cmd}` : m.cmd;
      if (runOk(`${cmd} 2>&1`, { timeout: 120_000 })) {
        installed = true;
        break;
      }
      // retry without sudo
      if (m.sudo && runOk(`${m.cmd} 2>&1`, { timeout: 120_000 })) {
        installed = true;
        break;
      }
    }
  }

  if (installed) {
    console.log('  ✓ tmux installed');
  } else {
    console.log('  ⚠ tmux not available — shell mode will be used.');
    console.log('  Termdock will check again on next start and try to fix automatically.');
  }
} else {
  const ver = execSync('tmux -V', { encoding: 'utf-8' }).trim();
  console.log(`  ✓ tmux ${ver}`);
}

// —— 写入 boot-check marker，避免 CLI 启动时重复检查 ——
// 只有 node-pty 和 tmux 都就绪才写 marker；否则 CLI 启动时 bootCheck 会补做
const markerDir = path.join(os.homedir(), '.termdock');
const markerFile = path.join(markerDir, '.boot-check-ok');
if (testPty() && which('tmux')) {
  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({
      checkedAt: new Date().toISOString(),
      source: 'postinstall',
      nodePty: { ok: true, rebuilt: false },
      tmux: { ok: true, version: execSync('tmux -V', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() },
    }), 'utf-8');
  } catch { /* non-critical */ }
} else {
  console.log('  ℹ Boot check marker not written (some checks failed).');
  console.log('  Termdock will re-check on first CLI start.');
}

console.log('\n✓ Termdock postinstall complete\n');
