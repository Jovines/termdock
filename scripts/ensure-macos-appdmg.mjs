import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APPDMG_VERSION = '0.6.6';
const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'ELECTRON_MIRROR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'npm_config_cache',
];

function packagingEnvironment() {
  return Object.fromEntries(
    SAFE_ENV_KEYS.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []),
  );
}

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
    ], {
      stdio: 'inherit',
      env: packagingEnvironment(),
    });
  }
}
