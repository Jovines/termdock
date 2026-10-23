import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
function sourceFiles(root: string): string[] { return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(path.join(root, entry.name)) : /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path.join(root, entry.name)] : []); }
it('keeps UI session selectors on the reconciled directory instead of fetching another inventory', () => {
  const offenders = sourceFiles(path.resolve('src/lib/components')).filter(file => /\bgetSessionInventory\s*\(|['"]\/api\/terminal\/session-inventory['"]/.test(fs.readFileSync(file, 'utf8')));
  expect(offenders, 'Session UI must use useSessionDirectory; inventory reconciliation belongs to useSessionPersistence.').toEqual([]);
});
it('keeps one production writer for the shared session directory', () => {
  const writers = sourceFiles(path.resolve('src')).filter(file => /useSessionDirectoryStore\.getState\(\)\.replace\(/.test(fs.readFileSync(file, 'utf8'))).map(file => path.relative(process.cwd(), file));
  expect(writers).toEqual(['src/lib/hooks/useSessionPersistence.ts']);
});
