import { describe, expect, it } from 'vitest';
import { detectTmuxRecoveryIncident, normalizeTmuxRecoveryIncident } from './tmuxRecovery.js';

const candidates = [
  { sessionId: 'a', tmuxSessionName: 'tmux-a', resumable: true },
  { sessionId: 'b', tmuxSessionName: 'tmux-b', resumable: true },
  { sessionId: 'c', tmuxSessionName: 'tmux-c', resumable: false },
];

describe('tmux recovery detection', () => {
  it('reports resumable sessions after the shared server disappears', () => {
    expect(detectTmuxRecoveryIncident({
      previousServerPid: 100,
      currentServerPid: null,
      candidates,
      liveSessionNames: new Set(),
      now: 123,
    })).toEqual({
      id: 'tmux-loss-3f',
      detectedAt: 123,
      previousServerPid: 100,
      currentServerPid: null,
      affectedSessionIds: ['a', 'b'],
    });
  });

  it('reports recoverable blank replacements when the server pid changed', () => {
    expect(detectTmuxRecoveryIncident({
      previousServerPid: 100,
      currentServerPid: 200,
      candidates,
      liveSessionNames: new Set(['tmux-a', 'tmux-b', 'tmux-c']),
      now: 124,
    })?.affectedSessionIds).toEqual(['a', 'b']);
  });

  it('reports unexpected single-session loss but ignores intentional deletion', () => {
    expect(detectTmuxRecoveryIncident({
      previousServerPid: 100,
      currentServerPid: 100,
      candidates,
      liveSessionNames: new Set(['tmux-b', 'tmux-c']),
    })?.affectedSessionIds).toEqual(['a']);
    expect(detectTmuxRecoveryIncident({
      previousServerPid: 100,
      currentServerPid: null,
      candidates,
      liveSessionNames: new Set(),
      intentionallyDeleting: new Set(['tmux-a', 'tmux-b']),
    })).toBeNull();
  });

  it('normalizes persisted incidents and removes duplicate ids', () => {
    expect(normalizeTmuxRecoveryIncident({
      id: 'incident', detectedAt: 4, previousServerPid: 1,
      affectedSessionIds: ['a', 'a', '', 1],
    })).toMatchObject({ affectedSessionIds: ['a'], currentServerPid: null });
  });
});
