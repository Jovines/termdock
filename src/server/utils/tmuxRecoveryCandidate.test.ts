import { describe, expect, it } from 'vitest';
import { isTmuxRecoveryCandidate } from './tmuxRecoveryCandidate.js';

describe('isTmuxRecoveryCandidate', () => {
  const lostGuiSession = {
    managedByTermdock: true,
    sourceFrontendSessionId: 'frontend-1',
    guiDetachedAt: null,
    boundFrontendSessionId: null,
  };

  it('accepts a Termdock GUI session whose frontend binding was lost', () => {
    expect(isTmuxRecoveryCandidate(lostGuiSession)).toBe(true);
  });

  it('rejects ordinary tmux and Termdock CLI-only sessions', () => {
    expect(isTmuxRecoveryCandidate({
      ...lostGuiSession,
      managedByTermdock: false,
      sourceFrontendSessionId: null,
    })).toBe(false);
    expect(isTmuxRecoveryCandidate({
      ...lostGuiSession,
      sourceFrontendSessionId: null,
    })).toBe(false);
  });

  it('rejects explicitly detached and currently bound sessions', () => {
    expect(isTmuxRecoveryCandidate({ ...lostGuiSession, guiDetachedAt: Date.now() })).toBe(false);
    expect(isTmuxRecoveryCandidate({ ...lostGuiSession, boundFrontendSessionId: 'frontend-1' })).toBe(false);
  });
});
