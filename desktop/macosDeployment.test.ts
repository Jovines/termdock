import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const forgeConfig = require('../forge.config.cjs');
const forgeSource = readFileSync(new URL('../forge.config.cjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('macOS deployment target', () => {
  it('keeps the launcher binary and Info.plist on macOS 12', () => {
    expect(forgeConfig.packagerConfig.extendInfo.LSMinimumSystemVersion).toBe('12.0');
    expect(forgeConfig.packagerConfig.extendInfo.NSUserNotificationAlertStyle).toBe('banner');
    expect(forgeSource).not.toContain('fs.renameSync(launcherPath, electronPath)');
    expect(forgeSource).toContain('afterCopyExtraResources: [signBundledRuntime]');
  });

  it('bundles the sandboxed preload into one CommonJS file', () => {
    const desktopBuild = packageJson.scripts['build:desktop'];
    expect(desktopBuild).toContain('esbuild desktop/preload.cts');
    expect(desktopBuild).toContain('--bundle');
    expect(desktopBuild).toContain('--format=cjs');
    expect(desktopBuild).toContain('--external:electron');
  });
});
