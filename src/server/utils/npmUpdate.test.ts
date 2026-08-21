import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_NPM_REGISTRY,
  buildNpmInstallArgs,
  buildNpmViewArgs,
  compareVersions,
  parseNpmVersionOutput,
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
