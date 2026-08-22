import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APPDMG_VERSION = '0.6.6';

if (process.platform === 'darwin') {
  try {
    require.resolve('appdmg');
  } catch {
    // electron-installer-dmg declares appdmg as an optional dependency. npm can
    // omit it when npm ci consumes a lockfile generated on another platform,
    // so make the macOS-only packaging prerequisite explicit and reproducible.
    execFileSync('npm', [
      'install',
      '--no-save',
      '--no-package-lock',
      `appdmg@${APPDMG_VERSION}`,
    ], { stdio: 'inherit' });
  }
}
