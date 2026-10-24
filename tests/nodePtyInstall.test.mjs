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
  // macOS exposes /var through /private/var; child process.cwd() resolves that
  // alias. Compare the same real directory while retaining the spaces fixture.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'termdock install ')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const env = {
    ...process.env, HOME: root, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    npm_config_global: 'true', SHELL: '/nonexistent/login-shell', TERMDOCK_INSTALL_FIXTURE: root,
  };
  const executable = (name, code) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${code}`, { mode: 0o755 });
  executable('npx', `
    const fs = require('node:fs'), path = require('node:path');
    const root = process.env.TERMDOCK_INSTALL_FIXTURE;
    fs.writeFileSync(path.join(root, 'invocation.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), global: process.env.npm_config_global,
      ...(process.env.TERMDOCK_RECORD_TOOLCHAIN ? { toolchain: Object.fromEntries(['DEVELOPER_DIR', 'SDKROOT', 'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'CPLUS_INCLUDE_PATH'].map(key => [key, process.env[key]])) } : {}) }));
    console.error('fixture node-gyp diagnostic');
    if (process.env.TERMDOCK_REBUILD_FAIL) process.exit(17);
    fs.writeFileSync(path.join(root, 'rebuilt'), 'ok');
  `);
  executable('tmux', "console.log('tmux 3.6a');");
  return { root, env };
}

for (const fail of [false, true, 'probe']) test(`postinstall fallback with inherited global mode and a path containing spaces (${fail === 'probe' ? 'probe still fails' : fail ? 'build failure' : 'success'})`, t => {
  const { root, env } = fixture(t);
  const scripts = path.join(root, 'scripts');
  const pty = path.join(root, 'node_modules/node-pty');
  fs.mkdirSync(scripts);
  fs.mkdirSync(path.join(pty, 'prebuilds'), { recursive: true });
  for (const name of ['postinstall.mjs', 'ensure-node-pty.cjs', 'native-build-env.cjs', 'node-pty-darwin-spawn.inc', 'install-utils.cjs']) {
    fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(scripts, name));
  }
  // This exercises the cross-platform fallback, independently of the Darwin patch gate.
  fs.writeFileSync(path.join(pty, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'index.cjs' }));
  fs.writeFileSync(path.join(pty, 'index.cjs'), `
    exports.spawn = () => {
      if (process.env.TERMDOCK_PROBE_FAIL || !require('node:fs').existsSync(require('node:path').join(process.env.TERMDOCK_INSTALL_FIXTURE, 'rebuilt'))) throw new Error('incompatible binary');
      return { kill() {} };
    };
  `);
  const script = path.join(scripts, 'postinstall.mjs');
  const result = spawnSync(process.execPath, ['-e', `Object.defineProperty(process, 'platform', { value: 'linux' }); import(${JSON.stringify(pathToFileURL(script).href)});`], {
    env: { ...env, ...(fail === true ? { TERMDOCK_REBUILD_FAIL: '1' } : fail === 'probe' ? { TERMDOCK_PROBE_FAIL: '1' } : {}) }, encoding: 'utf8', timeout: 30_000,
  });
  if (fail) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, fail === 'probe' ? /terminal still cannot be created/ : /exit status=17/);
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

function macFixture(t) {
  const { root, env } = fixture(t);
  const developers = [path.join(root, 'Selected Xcode'), path.join(root, 'Explicit Xcode')];
  const toolchain = developer => ({ DEVELOPER_DIR: developer,
    SDKROOT: path.join(developer, 'SDKs/MacOSX26.2.sdk'),
    CC: path.join(developer, 'Toolchains/usr/bin/clang'),
    CXX: path.join(developer, 'Toolchains/usr/bin/clang++'),
  });
  for (const developer of developers) {
    const tools = toolchain(developer);
    fs.mkdirSync(tools.SDKROOT, { recursive: true });
    fs.mkdirSync(path.dirname(tools.CC), { recursive: true });
    for (const compiler of [tools.CC, tools.CXX]) fs.writeFileSync(compiler, `#!${process.execPath}\nconsole.log('COMPILER_OK');`, { mode: 0o755 });
  }
  for (const key of ['DEVELOPER_DIR', 'SDKROOT', 'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'CPLUS_INCLUDE_PATH']) delete env[key];
  function run(overrides = {}, failure = null, platform = 'darwin') {
    const code = `
      const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
      const cp = require('node:child_process'), original = cp.spawnSync;
      const calls = [], before = { ...process.env };
      const failure = ${JSON.stringify(failure)};
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      cp.spawnSync = (command, args, options) => {
        if (!command.startsWith('/usr/bin/')) return original(command, args, options);
        calls.push({ command, args, developer: options.env.DEVELOPER_DIR, sdk: options.env.SDKROOT });
        fs.writeFileSync(${JSON.stringify(path.join(root, 'discovery.json'))}, JSON.stringify(calls));
        if (command === '/usr/bin/xcode-select') {
          assert.deepEqual(args, ['-p']);
          return { status: 0, stdout: ${JSON.stringify(developers[0])} + '\\n' };
        }
        assert.equal(command, '/usr/bin/xcrun');
        assert.deepEqual(args.slice(0, 2), ['--sdk', 'macosx']);
        assert.ok(options.env.DEVELOPER_DIR);
        if (failure === 'exit') return { status: 72, stderr: 'fixture SDK is unavailable' };
        if (failure === 'spawn') return { status: null, error: Object.assign(new Error('fixture timed out'), { code: 'ETIMEDOUT' }) };
        if (failure === 'relative') return { status: 0, stdout: 'relative/sdk' };
        if (failure === 'missing') return { status: 0, stdout: '/nonexistent/termdock-sdk' };
        if (failure === 'empty') return { status: 0, stdout: '' };
        return { status: 0, stdout: path.join(options.env.DEVELOPER_DIR,
          args[2] === '--show-sdk-path' ? 'SDKs/MacOSX26.2.sdk' : 'Toolchains/usr/bin/' + args[3]) + '\\n' };
      };
      try {
        require(${JSON.stringify(require.resolve('../scripts/ensure-node-pty.cjs'))}).rebuildNodePty(${JSON.stringify(root)});
      } finally { assert.deepEqual({ ...process.env }, before); }
    `;
    return spawnSync(process.execPath, ['-e', code], {
      env: { ...env, TERMDOCK_RECORD_TOOLCHAIN: '1', ...overrides }, encoding: 'utf8', timeout: 30_000,
    });
  }
  const commands = developer => {
    const tools = toolchain(developer);
    return { ...tools, CC: `'${tools.CC}'`, CXX: `'${tools.CXX}'` };
  };
  return { root, run, selected: commands(developers[0]), explicit: commands(developers[1]),
    invocation: () => JSON.parse(fs.readFileSync(path.join(root, 'invocation.json'))),
    discovery: () => fs.existsSync(path.join(root, 'discovery.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'discovery.json'))) : [],
  };
}

for (const explicitDeveloper of [false, true]) test(`Darwin rebuild pairs SDK and compilers from ${explicitDeveloper ? 'explicit' : 'selected'} Xcode, including paths with spaces`, t => {
  const f = macFixture(t);
  const expected = explicitDeveloper ? f.explicit : f.selected;
  const result = f.run(explicitDeveloper ? { DEVELOPER_DIR: expected.DEVELOPER_DIR } : {});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.invocation().toolchain, expected);
  for (const command of [expected.CC, expected.CXX]) {
    const probe = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /COMPILER_OK/);
  }
  const calls = f.discovery();
  assert.equal(calls.length, explicitDeveloper ? 3 : 4);
  for (const call of calls.filter(call => call.command.endsWith('/xcrun'))) assert.equal(call.developer, expected.DEVELOPER_DIR);
});

test('Darwin rebuild preserves a fully explicit toolchain and flags without probing Xcode', t => {
  const f = macFixture(t);
  const overrides = { ...f.explicit, CFLAGS: '-custom-c', CXXFLAGS: '-custom-cxx', LDFLAGS: '-custom-link', CPLUS_INCLUDE_PATH: '/custom/headers' };
  const result = f.run(overrides);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.invocation().toolchain, overrides);
  assert.deepEqual(f.discovery(), []);
});

for (const key of ['SDKROOT', 'CC', 'CXX']) test(`Darwin rebuild preserves explicit ${key} while resolving missing settings`, t => {
  const f = macFixture(t);
  const value = key === 'SDKROOT' ? f.explicit.SDKROOT : 'custom compiler --flag';
  const result = f.run({ [key]: value });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.invocation().toolchain, { ...f.selected, [key]: value });
  assert.equal(f.discovery().length, 3);
});

for (const failure of ['exit', 'spawn', 'relative', 'missing', 'empty']) test(`Darwin discovery fails with actionable diagnostics before node-gyp (${failure})`, t => {
  const f = macFixture(t);
  const result = f.run({}, failure);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot resolve macOS native build tools/);
  assert.match(result.stderr, /xcrun --sdk macosx --show-sdk-path/);
  assert.ok(result.stderr.includes(f.selected.DEVELOPER_DIR));
  if (failure === 'exit') assert.match(result.stderr, /fixture SDK is unavailable/);
  if (failure === 'spawn') assert.match(result.stderr, /fixture timed out/);
  assert.equal(fs.existsSync(path.join(f.root, 'invocation.json')), false);
});

test('Darwin native build failure reports the selected toolchain and original linker output', t => {
  const f = macFixture(t);
  const result = f.run({ TERMDOCK_REBUILD_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture node-gyp diagnostic/);
  assert.match(result.stderr, /exit status=17/);
  for (const [key, value] of Object.entries(f.selected)) assert.ok(result.stderr.includes(`${key}=${value}`));
});

test('non-Darwin rebuild skips Apple discovery and preserves the build environment', t => {
  const f = macFixture(t);
  const result = f.run({ CC: 'custom cc', CXXFLAGS: '-custom-flag' }, null, 'linux');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.invocation().toolchain, { CC: 'custom cc', CXXFLAGS: '-custom-flag' });
  assert.deepEqual(f.discovery(), []);
});
