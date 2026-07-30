import { describe, expect, it } from 'vitest';
import {
  buildLineReference,
  buildPromptReference,
  buildReferenceInputText,
  resolveAbsoluteReferencePath,
} from './referencePaths';

describe('sidebar reference paths', () => {
  it('resolves workspace-relative paths to absolute paths', () => {
    expect(resolveAbsoluteReferencePath('src/App.tsx', '/workspace/project')).toBe('/workspace/project/src/App.tsx');
    expect(resolveAbsoluteReferencePath('./src/App.tsx', '/workspace/project/')).toBe('/workspace/project/src/App.tsx');
    expect(resolveAbsoluteReferencePath('/other/file.ts', '/workspace/project')).toBe('/other/file.ts');
  });

  it('keeps inserted and copied path references on the same absolute path', () => {
    expect(buildPromptReference('src/App.tsx', '/workspace/project')).toBe('/workspace/project/src/App.tsx');
    expect(buildReferenceInputText('src/App.tsx', '/workspace/project')).toBe('/workspace/project/src/App.tsx ');
    expect(buildLineReference('src/App.tsx', '/workspace/project', { start: 12, end: 18 }))
      .toBe('/workspace/project/src/App.tsx:12-18');
  });

  it('quotes absolute references containing spaces', () => {
    expect(buildPromptReference('docs/user guide.md', '/workspace/project'))
      .toBe('"/workspace/project/docs/user guide.md"');
    expect(buildReferenceInputText('docs/user guide.md', '/workspace/project'))
      .toBe('"/workspace/project/docs/user guide.md" ');
  });
});
