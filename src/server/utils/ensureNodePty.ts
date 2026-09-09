import { createRequire } from 'node:module';

// Both src/server/utils and dist/server/utils resolve to the shipped scripts.
const require = createRequire(import.meta.url);
export function ensureNodePty(): void {
  if (process.platform !== 'darwin') return;
  const { ensureNodePty: ensure } = require('../../../scripts/ensure-node-pty.cjs') as {
    ensureNodePty(root: string): void;
  };
  ensure(require.resolve('node-pty/package.json').replace(/[/\\]package\.json$/, ''));
}
