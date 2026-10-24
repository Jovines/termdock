import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  OFFICIAL_NPM_REGISTRY,
  npmRuntimeEnvironment,
  buildNpmInstallArgs,
  buildNpmViewArgs,
  compareVersions,
  parseNpmVersionOutput,
  resolveRunningTermdockInstallation,
  verifyRunningTermdockInstallation,
  installTermdockVersion,
} from './npmUpdate.js';

describe('npmUpdate', () => {
  it('queries latest Termdock exclusively through the official npm registry', () => {
    expect(buildNpmViewArgs()).toEqual([
      'view',
      'termdock@latest',
      'version',
      '--json',
      '--registry',
      OFFICIAL_NPM_REGISTRY,
    ]);
    expect(buildNpmViewArgs(null)).toEqual([
      'view',
      'termdock@latest',
      'version',
      '--json',
    ]);
  });

  it('pins the registry version when installing globally', () => {
    expect(buildNpmInstallArgs('1.4.69')).toEqual([
      'install',
      '--global',
      'termdock@1.4.69',
      '--registry',
      OFFICIAL_NPM_REGISTRY,
      '--foreground-scripts',
    ]);
    expect(buildNpmInstallArgs('1.4.69', null)).toEqual([
      'install',
      '--global',
      'termdock@1.4.69',
      '--foreground-scripts',
    ]);
  });

  it('parses and compares stable and prerelease versions', () => {
    expect(parseNpmVersionOutput('"1.4.69"\n')).toBe('1.4.69');
    expect(compareVersions('1.4.69', '1.4.68')).toBeGreaterThan(0);
    expect(compareVersions('1.4.69-beta.2', '1.4.69')).toBeLessThan(0);
  });

  it('rejects malformed registry output and install versions', () => {
    expect(() => parseNpmVersionOutput('{"version":"1.4.69"}')).toThrow(/invalid Termdock version/);
    expect(() => buildNpmInstallArgs('latest; echo unsafe')).toThrow(/Invalid Termdock version/);
  });
});


describe('running installation update target', () => {
  it('executes npm against the verified running prefix and requires fresh matching on-disk metadata', async () => {
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'td npm target ')));
    const previous = { PATH: process.env.PATH, TD_NPM_RECORD: process.env.TD_NPM_RECORD, TD_NPM_MODE: process.env.TD_NPM_MODE, TD_NPM_OTHER: process.env.TD_NPM_OTHER,
      DEVELOPER_DIR: process.env.DEVELOPER_DIR, SDKROOT: process.env.SDKROOT, CC: process.env.CC, CXX: process.env.CXX, CPLUS_INCLUDE_PATH: process.env.CPLUS_INCLUDE_PATH };
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const toolchain = { DEVELOPER_DIR: '/explicit/Xcode', SDKROOT: '/explicit/SDK', CC: 'custom clang', CXX: 'custom clang++', CPLUS_INCLUDE_PATH: '/explicit/headers' };
    try {
      // A fully explicit Darwin environment must reach npm unchanged, without
      // requiring the host's xcrun (this regression runs on Linux too).
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.assign(process.env, toolchain);
      const prefix = path.join(temporary, 'running prefix');
      const packageRoot = path.join(prefix, 'lib/node_modules/termdock');
      const moduleFile = path.join(packageRoot, 'dist/server/utils/npmUpdate.js');
      fs.mkdirSync(path.dirname(moduleFile), { recursive: true }); fs.writeFileSync(moduleFile, '');
      const entry = path.join(packageRoot, 'dist/server/cli.js'); fs.writeFileSync(entry, '');
      const metadata = path.join(packageRoot, 'package.json');
      const writeVersion = (version: string) => fs.writeFileSync(metadata, JSON.stringify({ name: 'termdock', version }));
      writeVersion('1.4.318');
      const installation = resolveRunningTermdockInstallation(pathToFileURL(moduleFile).href, entry);
      expect(installation).toEqual({ packageRoot, prefix });
      expect(() => resolveRunningTermdockInstallation(pathToFileURL(moduleFile).href, moduleFile)).toThrow(/entry does not match/);
      const alias = path.join(temporary, 'td'); fs.symlinkSync(entry, alias);
      expect(resolveRunningTermdockInstallation(pathToFileURL(moduleFile).href, alias)).toEqual(installation);
      expect(() => verifyRunningTermdockInstallation('1.4.319', installation)).toThrow(/not completed/);
      const bin = path.join(temporary, 'bin'); fs.mkdirSync(bin);
      process.env.PATH = `${bin}${path.delimiter}${previous.PATH ?? ''}`;
      process.env.TD_NPM_RECORD = path.join(temporary, 'argv.json');
      process.env.TD_NPM_OTHER = path.join(temporary, 'unrelated-package.json');
      fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2); fs.writeFileSync(process.env.TD_NPM_RECORD, JSON.stringify({ args, toolchain: Object.fromEntries(['DEVELOPER_DIR', 'SDKROOT', 'CC', 'CXX', 'CPLUS_INCLUDE_PATH'].map(key => [key, process.env[key]])) }));
if (process.env.TD_NPM_MODE === 'fail') process.exit(2);
const dest = process.env.TD_NPM_MODE === 'wrong' ? process.env.TD_NPM_OTHER : path.join(args[args.indexOf('--prefix')+1], 'lib/node_modules/termdock/package.json');
if (process.env.TD_NPM_MODE !== 'noop') fs.writeFileSync(dest, JSON.stringify({ name:'termdock', version: args[2].split('@')[1] }));
`, { mode: 0o700 });
      for (const mode of ['noop', 'wrong', 'fail']) {
        process.env.TD_NPM_MODE = mode;
        await expect(installTermdockVersion('1.4.319', null, installation, path.join(bin, 'npm'))).rejects.toThrow(mode === 'fail' ? /exit code 2/ : /did not install/);
        expect(JSON.parse(fs.readFileSync(metadata, 'utf8')).version).toBe('1.4.318');
      }
      process.env.TD_NPM_MODE = 'correct';
      await installTermdockVersion('1.4.319', OFFICIAL_NPM_REGISTRY, installation, path.join(bin, 'npm'));
      expect(JSON.parse(fs.readFileSync(process.env.TD_NPM_RECORD, 'utf8'))).toEqual({ args: buildNpmInstallArgs('1.4.319', OFFICIAL_NPM_REGISTRY, prefix), toolchain });
      expect(() => verifyRunningTermdockInstallation('1.4.319', installation)).not.toThrow();
      writeVersion('1.4.318');
      expect(() => verifyRunningTermdockInstallation('1.4.319', installation)).toThrow(/not completed/);
      writeVersion('1.4.321');const previousArgs=fs.readFileSync(process.env.TD_NPM_RECORD,'utf8');
      await expect(installTermdockVersion('1.4.319',null,installation)).rejects.toThrow(/newer version/);expect(fs.readFileSync(process.env.TD_NPM_RECORD,'utf8')).toBe(previousArgs);
      fs.writeFileSync(metadata, JSON.stringify({ name: 'other', version: '1.4.999' }));
      expect(() => resolveRunningTermdockInstallation(pathToFileURL(moduleFile).href, entry)).toThrow(/invalid package/);
      expect(() => resolveRunningTermdockInstallation()).toThrow(/supported global/);
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});

it('pins Node for lifecycle scripts and discovers Homebrew tools when launched outside a login shell', () => {
 const inherited={PATH:'/old-node/bin:/usr/bin'};
 const env=npmRuntimeEnvironment('/node22/bin/node',inherited,'darwin');
 expect(env.PATH).toBe('/node22/bin:/opt/homebrew/bin:/usr/local/bin:/old-node/bin:/usr/bin');
 expect(inherited.PATH).toBe('/old-node/bin:/usr/bin');
});
