import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { rebuildNodePty } = require('../scripts/ensure-node-pty.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock install '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const env = {
    ...process.env, HOME: root, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    npm_config_global: 'true', TERMDOCK_INSTALL_FIXTURE: root,
  };
  const executable = (name, code) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${code}`, { mode: 0o755 });
  executable('npx', `
    const fs = require('node:fs'), path = require('node:path');
    const root = process.env.TERMDOCK_INSTALL_FIXTURE;
    fs.writeFileSync(path.join(root, 'invocation.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), global: process.env.npm_config_global }));
    console.error('fixture node-gyp diagnostic');
    if (process.env.TERMDOCK_REBUILD_FAIL) process.exit(17);
    fs.writeFileSync(path.join(root, 'rebuilt'), 'ok');
  `);
  executable('tmux', "console.log('tmux 3.6a');");
  return { root, env };
}

for (const fail of [false, true]) test(`postinstall fallback with inherited global mode and a path containing spaces (${fail ? 'failure' : 'success'})`, t => {
  const { root, env } = fixture(t);
  const scripts = path.join(root, 'scripts');
  const pty = path.join(root, 'node_modules/node-pty');
  fs.mkdirSync(scripts);
  fs.mkdirSync(path.join(pty, 'prebuilds'), { recursive: true });
  for (const name of ['postinstall.mjs', 'ensure-node-pty.cjs', 'node-pty-darwin-spawn.inc']) {
    fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(scripts, name));
  }
  // This exercises the cross-platform fallback, independently of the Darwin patch gate.
  fs.writeFileSync(path.join(pty, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'index.cjs' }));
  fs.writeFileSync(path.join(pty, 'index.cjs'), `
    exports.spawn = () => {
      if (!require('node:fs').existsSync(require('node:path').join(process.env.TERMDOCK_INSTALL_FIXTURE, 'rebuilt'))) throw new Error('incompatible binary');
      return { kill() {} };
    };
  `);
  const script = path.join(scripts, 'postinstall.mjs');
  const result = spawnSync(process.execPath, ['-e', `Object.defineProperty(process, 'platform', { value: 'linux' }); import(${JSON.stringify(pathToFileURL(script).href)});`], {
    env: { ...env, ...(fail ? { TERMDOCK_REBUILD_FAIL: '1' } : {}) }, encoding: 'utf8', timeout: 30_000,
  });
  if (fail) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exit status=17/);
    assert.doesNotMatch(result.stdout, /postinstall complete/);
  } else {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /node-pty rebuilt successfully/);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'invocation.json'))), {
    args: ['--global=false', '--yes', 'node-gyp', 'rebuild'], cwd: pty, global: 'true',
  });
  assert.equal(fs.existsSync(path.join(pty, 'prebuilds')), false);
  assert.equal(fs.existsSync(path.join(root, '.termdock/.boot-check-ok')), !fail);
});

test('rebuild failures preserve native tool output, cwd and exit status', t => {
  const { root, env } = fixture(t);
  const script = require.resolve('../scripts/ensure-node-pty.cjs');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(script)}).rebuildNodePty(${JSON.stringify(root)});`], {
    env: { ...env, TERMDOCK_REBUILD_FAIL: '1' }, encoding: 'utf8', timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture node-gyp diagnostic/);
  assert.ok(result.stderr.includes(`cwd=${root}; exit status=17`));
  assert.doesNotMatch(result.stderr, /install Xcode Command Line Tools and retry/);
  assert.equal(fs.existsSync(path.join(root, 'rebuilt')), false);
});

test('missing npx retains the spawn error as its cause', t => {
  const { root } = fixture(t);
  const previous = process.env.PATH;
  t.after(() => { process.env.PATH = previous; });
  process.env.PATH = path.join(root, 'missing-bin');
  assert.throws(() => rebuildNodePty(root), error => {
    assert.equal(error.cause.code, 'ENOENT');
    assert.match(error.message, /exit status=none; ENOENT/);
    return true;
  });
});
