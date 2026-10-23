import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkTmux, tmuxInstallPlan, findExecutable } = require('../scripts/install-utils.cjs');

for (const [platform, manager, expected] of [
  ['linux', 'apt-get', ['install', '-y', 'tmux']], ['linux', 'dnf', ['install', '-y', 'tmux']],
  ['linux', 'yum', ['install', '-y', 'tmux']], ['linux', 'apk', ['add', 'tmux']],
  ['linux', 'pacman', ['-S', '--noconfirm', 'tmux']], ['linux', 'zypper', ['--non-interactive', 'install', 'tmux']],
  ['linux', 'nix-env', ['-iA', 'nixpkgs.tmux']], ['darwin', 'brew', ['install', 'tmux']],
  ['darwin', 'port', ['install', 'tmux']], ['darwin', 'nix-env', ['-iA', 'nixpkgs.tmux']],
]) test(`uses the ${platform}/${manager} executable and arguments without a shell`, () => {
  const find = name => name === manager ? `/package manager/${name}` : null;
  assert.deepEqual(tmuxInstallPlan(platform, find).args, expected);
  assert.equal(tmuxInstallPlan(platform, find).command, `/package manager/${manager}`);
});

for (const uid of [0, 1000]) test(`installs and verifies tmux with uid=${uid}`, () => {
  const calls = []; let ready = false;
  const find = name => ['apt-get', 'sudo'].includes(name) || name === 'tmux' && ready ? `/tools with spaces/${name}` : null;
  const run = (command, args) => {
    calls.push({ command, args });
    if (args.includes('install')) ready = true;
    return { ok: true, stdout: args.includes('-V') ? 'tmux 3.6a\n' : '', stderr: '' };
  };
  assert.deepEqual(checkTmux({ uid, platform: 'linux', find, run }), { ok: true, installed: true, version: 'tmux 3.6a' });
  const install = calls.find(call => call.args.includes('install'));
  if (uid === 0) assert.equal(install.command, '/tools with spaces/apt-get');
  else assert.deepEqual(install.args, ['-n', '/tools with spaces/apt-get', 'install', '-y', 'tmux']);
});

for (const sudo of [false, true]) test(`does not prompt without root/passwordless sudo (sudo exists=${sudo})`, () => {
  const calls = [];
  const find = name => name === 'apk' || name === 'sudo' && sudo ? '/tools/' + name : null;
  const result = checkTmux({ uid: 1000, platform: 'linux', find, run: (command, args) => { calls.push(args); return { ok: false }; } });
  assert.equal(result.ok, false); assert.match(result.error, /sudo apk add tmux/);
  assert.deepEqual(calls, sudo ? [['-n', 'true']] : []);
});

test('does not report an installation as successful until tmux -V works', () => {
  const result = checkTmux({ uid: 0, platform: 'linux', find: name => '/tools/' + name,
    run: (_command, args) => ({ ok: true, stdout: args.includes('-V') ? 'not tmux' : '', stderr: '' }) });
  assert.equal(result.ok, false); assert.match(result.error, /usable executable/);
});

test('a working tmux never starts an installer', () => {
  const calls = [];
  assert.equal(checkTmux({ find: name => name === 'tmux' ? '/actual/tmux' : null,
    run: (command, args) => { calls.push(args); return { ok: true, stdout: 'tmux 3.5a' }; } }).ok, true);
  assert.deepEqual(calls, [['-V']]);
});

test('resolves executable user directories even with a restricted PATH', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock tool paths '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.local/bin'), { recursive: true });
  const tool = path.join(root, '.local/bin/unique-termdock-tool');
  fs.writeFileSync(tool, '#!/bin/sh\n', { mode: 0o700 });
  assert.equal(findExecutable('unique-termdock-tool', { env: { PATH: '/missing' }, home: root }), tool);
  fs.chmodSync(tool, 0o600);
  assert.equal(findExecutable('unique-termdock-tool', { env: { PATH: '/missing' }, home: root }), null);
});
