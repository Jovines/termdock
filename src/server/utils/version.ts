import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const TERMDOCK_PROTOCOL_VERSION = 1;

export const TERMDOCK_CAPABILITIES = [
  'auth-cookie',
  'client-state-ws',
  'desktop-service-discovery',
  'filesystem',
  'local-api',
  'terminal-ws',
  'tmux',
] as const;

export function getTermdockVersion(): string {
  const override = process.env.TERMDOCK_VERSION?.trim();
  if (override) return override;
  try {
    const require_ = createRequire(import.meta.url);
    const packagePath = path.resolve(currentDir, '..', '..', '..', 'package.json');
    const packageJson = require_(packagePath) as { version?: unknown };
    if (typeof packageJson.version === 'string' && packageJson.version.trim()) {
      return packageJson.version.trim();
    }
  } catch {
    // Packagers may omit the root package file. The desktop launcher sets
    // TERMDOCK_VERSION explicitly, so this is only a backwards-compatible
    // fallback for unusual distributions.
  }
  return '0.0.0';
}
