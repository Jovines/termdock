// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { expect, it } from 'vitest';

it('requires product sortable contexts to use the interruption-aware wrapper', () => {
  const root = resolve(process.cwd(), 'src');
  const violations: string[] = [];
  for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file) || /\.test\./.test(file)) continue;
    const path = resolve(root, file);
    if (relative(root, path) === 'lib/components/DragDropContext.tsx') continue;
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]@hello-pangea\/dnd['"]/g)) {
      if (/\bDragDropContext\b/.test(match[1])) violations.push(file);
    }
  }
  expect(violations).toEqual([]);
});
