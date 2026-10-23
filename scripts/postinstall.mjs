#!/usr/bin/env node

/** Ensure native modules work even when installed with a restricted lifecycle
 * environment. --ignore-scripts/policy skips are repaired at first CLI start. */

import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

const { checkTmux, probeNodePty, clearPtyModuleCache } = require_('./install-utils.cjs');

// —— native modules: 实际 spawn 测试，不只是 require ——
console.log('\n=== Rebuilding native modules ===');

const { ensureNodePty, rebuildNodePty } = require_('./ensure-node-pty.cjs');
const PTY_PATH = require_.resolve('node-pty/package.json', { paths: [pkgRoot] }).replace('/package.json', '');

ensureNodePty(PTY_PATH);

// Ensure node-pty prebuild spawn-helper binaries have execute permissions.
// npm may strip +x during install, which causes terminal creation to fail.
function fixSpawnHelperPermissions() {
  const prebuildsDir = path.join(PTY_PATH, 'prebuilds');
  if (!fs.existsSync(prebuildsDir)) return 0;
  let fixed = 0;
  try {
    for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const helperPath = path.join(prebuildsDir, entry.name, 'spawn-helper');
      if (!fs.existsSync(helperPath)) continue;
      try {
        const mode = fs.statSync(helperPath).mode;
        const needsX = (mode & 0o111) === 0;
        if (needsX) {
          fs.chmodSync(helperPath, mode | 0o111);
          fixed++;
        }
      } catch { /* skip permission errors */ }
    }
  } catch { /* directory listing failed */ }
  if (fixed > 0) console.log(`  ✓ fixed execute permissions on ${fixed} spawn-helper(s)`);
  return fixed;
}
fixSpawnHelperPermissions();
function testPty() {
  try { probeNodePty(PTY_PATH); return true; } catch { return false; }
}
let rebuilt = false;
if (testPty()) {
  console.log('  node-pty OK');
} else {
  console.log('  node-pty needs rebuild (prebuilt binary incompatible with this OS/Node version)...');
  fs.rmSync(path.join(PTY_PATH, 'prebuilds'), { recursive: true, force: true });
  rebuildNodePty(PTY_PATH, { timeout: 120_000 });
  clearPtyModuleCache(PTY_PATH);
  if (!testPty()) throw new Error('node-pty rebuilt, but a terminal still cannot be created. Check the native module output above.');
  rebuilt = true;
  console.log('  ✓ node-pty rebuilt successfully');
}

// —— tmux ——
console.log('\n=== Checking tmux ===');
const tmux = checkTmux();
if (tmux.ok) console.log(`  ✓ ${tmux.version}${tmux.installed ? ' (just installed)' : ''}`);
else console.log(`  ⚠ ${tmux.error}\n  Shell mode will be used; Termdock retries on the next start.`);

// Diagnostic marker only: CLI revalidates dependencies even after installation.
const markerDir = path.join(os.homedir(), '.termdock');
const markerFile = path.join(markerDir, '.boot-check-ok');
if (tmux.ok) {
  try {
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerFile, JSON.stringify({
      checkedAt: new Date().toISOString(),
      source: 'postinstall',
      nodePty: { ok: true, rebuilt },
      tmux,
      runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, ptyPath: PTY_PATH },
    }), { encoding: 'utf-8', mode: 0o600 });
  } catch { /* non-critical */ }
} else {
  console.log('  ℹ Boot check marker not written (some checks failed).');
  console.log('  Termdock will re-check on first CLI start.');
}

console.log('\n✓ Termdock postinstall complete\n');
