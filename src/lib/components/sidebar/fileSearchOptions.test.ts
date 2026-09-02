import { describe, expect, it } from 'vitest';
import { describeSearchScope, parseExcludePatterns, resolveSearchScopePath } from './fileSearchOptions';

describe('file search options', () => {
  it('accepts comma and newline separated exclusions without duplicates', () => {
    expect(parseExcludePatterns('dist/**, *.lock\n!dist/**')).toEqual(['dist/**', '*.lock']);
  });

  it('resolves relative or absolute search scopes', () => {
    expect(resolveSearchScopePath('/workspace/project', 'src/lib')).toBe('/workspace/project/src/lib');
    expect(resolveSearchScopePath('/workspace/project', '/tmp/demo')).toBe('/tmp/demo');
    expect(resolveSearchScopePath('/workspace/project', '.')).toBe('/workspace/project');
  });

  it('describes a nested scope relative to the explorer root', () => {
    expect(describeSearchScope('/workspace/project', '/workspace/project/src/lib')).toBe('src/lib');
    expect(describeSearchScope('/workspace/project', '/tmp/demo')).toBe('/tmp/demo');
  });
});
