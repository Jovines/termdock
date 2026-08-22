import { describe, expect, it } from 'vitest';
import { shouldClearSessionFilePreview } from './rightSidebarSessionState';

describe('right sidebar session preview cleanup', () => {
  it('does not erase B preview state during the A-to-B transition frame', () => {
    const sessionBKey = 'session-b\u0000/workspace/shared';
    const staleSessionAKey = 'session-a\u0000/workspace/shared';

    expect(shouldClearSessionFilePreview(sessionBKey, staleSessionAKey, null)).toBe(false);
  });

  it('clears the preview only after the matching session has no selected file', () => {
    const sessionBKey = 'session-b\u0000/workspace/shared';

    expect(shouldClearSessionFilePreview(sessionBKey, sessionBKey, '/workspace/shared/b.md')).toBe(false);
    expect(shouldClearSessionFilePreview(sessionBKey, sessionBKey, null)).toBe(true);
  });
});
