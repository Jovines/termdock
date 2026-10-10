import { describe, expect, it } from 'vitest';
import { parseScopePaths, relativeScopePath } from './scopePaths';
import { analysisFile, buildArchitecturePrompt, DEFAULT_ANALYSIS } from './model';

describe('architecture scope references', () => {
  it('converts explorer file/line references, escaped spaces and quoted paths to project-relative paths', () => {
    expect(parseScopePaths('/project/src/auth.ts:12-18\n@/project/src/auth.ts:22\n`/project/my\\ folder/file.ts`:6\n./src', '/project')).toEqual(['src/auth.ts', 'my folder/file.ts', 'src']);
    expect(relativeScopePath('/project-two/src/auth.ts:12', '/project')).toBeNull();
    expect(relativeScopePath('/project/../outside/file.ts', '/project')).toBeNull();
    expect(parseScopePaths('src\nhttps://example.com/source', '/project')).toBeNull();
    expect(parseScopePaths(Array.from({ length: 21 }, (_, index) => `src/${index}`).join('\n'), '/project')).toBeNull();
  });
  it('imports selected diff locations without treating code as paths', () => {
    expect(parseScopePaths('```diff\n# /project/src/auth.ts: hunk 1, old lines 1 -> new lines 2\n+secret code\n# /project/src/ui.ts: hunk 2, old lines 4 -> new lines 5\n-code\n```', '/project')).toEqual(['src/auth.ts', 'src/ui.ts']);
  });
  it('binds a feature to the selected module scope and includes the user request while preserving scope identity', () => {
    const scope = { ...DEFAULT_ANALYSIS, kind: 'feature' as const, target: 'Login retries', paths: ['packages/auth'], focus: 'Explain retry state and cancellation' };
    const boundary = buildArchitecturePrompt('/project', 'en', scope);
    expect(boundary).toContain('WITHIN these directories/files');
    expect(boundary).toContain(scope.focus);
    expect(boundary).toContain('packages/auth');
    expect(buildArchitecturePrompt('/project', 'en', { ...scope, depth: 'dependencies' })).toContain('follow only directly relevant calls and dependencies outside them');
    expect(analysisFile({ ...scope, focus: 'Different question', depth: 'dependencies' })).toBe(analysisFile(scope));
    expect(analysisFile({ ...scope, paths: ['packages/billing'] })).not.toBe(analysisFile(scope));
  });
});
