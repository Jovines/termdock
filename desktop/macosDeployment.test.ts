import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const forgeConfig = require('../forge.config.cjs');
const forgeSource = readFileSync(new URL('../forge.config.cjs', import.meta.url), 'utf8');

describe('macOS deployment target', () => {
  it('keeps the launcher binary and Info.plist on macOS 12', () => {
    expect(forgeConfig.packagerConfig.extendInfo.LSMinimumSystemVersion).toBe('12.0');
    expect(forgeConfig.packagerConfig.extendInfo.NSUserNotificationAlertStyle).toBe('banner');
    expect(forgeSource).toContain('`-mmacosx-version-min=${macosDeploymentTarget}`');
    expect(forgeSource).toContain("'vtool'");
    expect(forgeSource).toContain("'-show-build'");
  });
});
