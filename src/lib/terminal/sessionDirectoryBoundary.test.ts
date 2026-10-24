import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
function sourceFiles(root: string): string[] { return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(path.join(root, entry.name)) : /\.tsx?$/.test(entry.name) && !/\.(?:test|browser)\./.test(entry.name) ? [path.join(root, entry.name)] : []); }
it('keeps UI session selectors on the reconciled directory instead of fetching another inventory', () => {
  const offenders = sourceFiles(path.resolve('src/lib/components')).filter(file => /\bgetSessionInventory\s*\(|['"]\/api\/terminal\/session-inventory['"]/.test(fs.readFileSync(file, 'utf8')));
  expect(offenders, 'Session UI must use useSessionDirectory; inventory reconciliation belongs to useSessionPersistence.').toEqual([]);
});
it('keeps one production writer for the shared session directory', () => {
  const writers = sourceFiles(path.resolve('src')).filter(file => /useSessionDirectoryStore\.getState\(\)\.replace\(/.test(fs.readFileSync(file, 'utf8'))).map(file => path.relative(process.cwd(), file));
  expect(writers).toEqual(['src/lib/hooks/useSessionPersistence.ts']);
});
it('keeps collaboration title consumers on projected titles instead of persistence names or cwd re-projection', () => {
  const files = ['src/lib/collaboration/display.ts',
    'src/lib/components/sidebar/AgentOperationsPanel.tsx',
    'src/lib/components/sidebar/CollaborationGroupLauncher.tsx',
    'src/lib/components/sidebar/CollaborationTaskWorkbench.tsx'];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    expect(source, file).not.toMatch(/\bgetSessionPresentation\s*\(/);
    expect(source, file).not.toMatch(/\b(?:session|member|targetSession|m)\??\.name\b/);
    if (file.endsWith('.tsx')) expect(source, file).toContain('useSessionPresentations');
  }
});
it('prevents new UI scenes from introducing their own raw title projection', () => {
  const callers = sourceFiles(path.resolve('src/lib/components')).filter(file =>
    /\bgetSession(?:Presentation|DisplayName|DisplayLines)\s*\(/.test(fs.readFileSync(file, 'utf8')),
  ).map(file => path.relative(process.cwd(), file));
  // This legacy handoff fallback has only a saved display name, never cwd/live metadata.
  expect(callers).toEqual(['src/lib/components/todos/TodoWorkspace.tsx']);
});
