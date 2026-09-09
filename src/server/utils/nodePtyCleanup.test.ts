// @vitest-environment node
import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { patchSource } = require('../../../scripts/ensure-node-pty.cjs');

it('patches exactly the pinned upstream source, including kqueue and errno', () => {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const original = path.join(root, 'src/unix/pty.cc.termdock-original');
  const source = fs.readFileSync(fs.existsSync(original) ? original : path.join(root, 'src/unix/pty.cc'), 'utf8');
  const patched = patchSource(source);
  expect(patched).toContain('if (kq >= 0) close(kq);');
  expect(patched).toContain('posix_spawnp failed: errno=');
  expect(patched).toContain('parent_master.fd = -1;');
  expect(() => patchSource(source + '\n')).toThrow('Unrecognized');
});

it('rebuilds replaced binaries, survives skipped install scripts, and fails closed on build failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-pty-install-'));
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    const original = path.join(root, 'src/unix/pty.cc.termdock-original');
    fs.mkdirSync(path.join(dir, 'src/unix'), { recursive: true });
    fs.copyFileSync(fs.existsSync(original) ? original : path.join(root, 'src/unix/pty.cc'), path.join(dir, 'src/unix/pty.cc'));
    const code = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      Object.defineProperty(process, 'platform', {value:'darwin'});
      const root = ${JSON.stringify(dir)};
      const script = ${JSON.stringify(path.resolve('scripts/ensure-node-pty.cjs'))};
      const binary = path.join(root, 'build/Release/pty.node');
      let builds=0, fail=false;
      require('node:child_process').spawnSync = () => {
        builds++;
        if (fail) return {status:1};
        fs.mkdirSync(path.dirname(binary), {recursive:true});
        fs.writeFileSync(binary, 'patched-binary-'+builds);
        fs.writeFileSync(path.join(path.dirname(binary), 'spawn-helper'), 'helper');
        return {status:0};
      };
      const start = () => {delete require.cache[script]; require(script).ensureNodePty(root);};
      start(); assert.equal(builds,1); // No postinstall/marker: repair before loading.
      start(); assert.equal(builds,1); // Cached binary hash is still valid.
      fs.writeFileSync(binary,'old prebuild');
      start(); assert.equal(builds,2); // A success-only spawn probe would miss this.
      fs.writeFileSync(binary,'old prebuild');
      fail=true;
      assert.throws(start, /rebuild failed/);
      assert.equal(fs.existsSync(path.join(root,'.termdock-fd-fix.json')),false);
      console.log('install gate passed');
    `;
    expect(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' })).toContain('install gate passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('releases all FDs and initialized actions on every injected failure and closed-stdio combination', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-pty-cleanup-'));
  try {
    const fixture = path.resolve('src/server/utils/__fixtures__/ptySpawnCleanup.cc');
    execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', path.resolve('scripts'), fixture, '-o', path.join(dir, 'test')]);
    expect(execFileSync(path.join(dir, 'test'), { encoding: 'utf8' })).toContain('cleanup cases passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'darwin')('keeps macOS ptmx and total FDs bounded across 1000 exit/kill cycles and 1000 failed spawns', () => {
  // Separate process excludes Vitest descriptors. lsof queries this child, never the test runner.
  const root = path.dirname(require.resolve('node-pty/package.json'));
  require('../../../scripts/ensure-node-pty.cjs').ensureNodePty(root);
  const code = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const pty = require(${JSON.stringify(root)});
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const count = () => ({
      total: fs.readdirSync('/dev/fd').length,
      ptmx: execFileSync('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-Fn'], {encoding:'utf8'}).split('\\n').filter(l => l === 'n/dev/ptmx').length,
    });
    async function cycle(kill) {
      const p = pty.spawn(kill ? '/bin/sleep' : '/usr/bin/true', kill ? ['60'] : [], {env:process.env});
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { p.kill(); reject(new Error('exit timeout')); }, 5000);
        p.onExit(() => {clearTimeout(timer); resolve();});
        if (kill) p.kill();
      });
    }
    (async () => {
      for (let i=0;i<10;i++) await cycle(i%2);
      await delay(250);
      const baseline = count();
      const check = () => { const current=count(); assert.equal(current.ptmx, baseline.ptmx); assert.ok(current.total <= baseline.total+2, JSON.stringify({baseline,current})); };
      for (let i=0;i<1000;i++) { await cycle(i%2); if (i%100===99) { await delay(250); check(); } }
      const huge='x'.repeat(3*1024*1024);
      for (let i=0;i<1000;i++) { assert.throws(() => pty.spawn('/bin/echo', [huge]), /errno=/); if (i%100===99) check(); }
      console.log(JSON.stringify({baseline,after:count()}));
    })().catch(e => {console.error(e); process.exit(1);});
  `;
  expect(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 180_000 })).toContain('baseline');
}, 190_000);
