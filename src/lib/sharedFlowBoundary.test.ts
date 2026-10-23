import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// A new entry must use the shared operation, rather than copying a platform
// decision tree and silently missing subsequent fixes to other input surfaces.
it('keeps clipboard reading policy out of UI components', () => {
  const root = resolve('src/lib/components');
  const files = readdirSync(root, { recursive: true }).map(String)
    .filter(file => /\.tsx?$/.test(file) && !file.includes('.test.'));
  const offenders = files.filter(file => /navigator\.clipboard\.(?:read|readText)\s*\(|\breadTerminalClipboard(?:Files|Image|Videos)\s*\(/.test(readFileSync(resolve(root, file), 'utf8')));
  expect(offenders).toEqual([]);
});
it('routes component exports through the shared platform save flow', () => {
  const root = resolve('src');
  const files = readdirSync(root, { recursive: true }).map(String)
    .filter(file => /\.tsx$/.test(file) && !file.includes('.test.'));
  const offenders = files.filter(file => /\.download\s*=/.test(readFileSync(resolve(root, file), 'utf8')));
  expect(offenders).toEqual([]);
});
