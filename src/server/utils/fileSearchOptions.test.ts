import { describe, expect, it } from 'vitest';
import { appendRipgrepExcludeArgs, createExcludeMatcher, normalizeExcludePatterns } from './fileSearchOptions.js';

describe('file search exclusions', () => {
  it('normalizes comma, newline and repeated query values within safe limits', () => {
    expect(normalizeExcludePatterns(['node_modules, *.lock', '!dist/**\nnode_modules'])).toEqual([
      'node_modules', '*.lock', 'dist/**',
    ]);
  });

  it('translates plain directory names and globs into ripgrep filters', () => {
    const args: string[] = [];
    appendRipgrepExcludeArgs(args, ['node_modules', '*.lock']);
    expect(args).toEqual([
      '--glob', '!node_modules', '--glob', '!**/node_modules/**', '--glob', '!*.lock',
    ]);
  });

  it('applies the same useful exclusions in the fallback walker', () => {
    const excluded = createExcludeMatcher(['node_modules', 'dist/**', '*.lock']);
    expect(excluded('packages/app/node_modules/react/index.js')).toBe(true);
    expect(excluded('dist/client/app.js')).toBe(true);
    expect(excluded('package-lock.lock')).toBe(true);
    expect(excluded('src/app.ts')).toBe(false);
  });
});
