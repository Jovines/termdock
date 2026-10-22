import { describe, expect, it } from 'vitest';
import { detectTmuxRecoveryIncident, normalizeTmuxRecoveryIncident, retainDismissedTmuxSessions } from './tmuxRecovery.js';

const candidates = [
  { sessionId: 'a', tmuxSessionName: 'tmux-a', resumable: true },
  { sessionId: 'b', tmuxSessionName: 'tmux-b', resumable: true },
  { sessionId: 'c', tmuxSessionName: 'tmux-c', resumable: false },
];

describe('tmux recovery detection', () => {
  it('reports resumable sessions after the shared server disappears', () => {
    expect(detectTmuxRecoveryIncident({
      authoritativeTmuxList: true,
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

  it('does not infer loss from a PID change when all sessions still exist', () => {
    expect(detectTmuxRecoveryIncident({
      authoritativeTmuxList: true,
      previousServerPid: 100,
      currentServerPid: 200,
      candidates,
      liveSessionNames: new Set(['tmux-a', 'tmux-b', 'tmux-c']),
      now: 124,
    })).toBeNull();
  });

  it('includes only missing sessions after a PID change', () => {
    expect(detectTmuxRecoveryIncident({
      authoritativeTmuxList: true, previousServerPid: 100, currentServerPid: 200,
      candidates, liveSessionNames: new Set(['tmux-b', 'tmux-c']),
    })?.affectedSessionIds).toEqual(['a']);
  });

  it('reports unexpected single-session loss but ignores intentional deletion', () => {
    expect(detectTmuxRecoveryIncident({
      authoritativeTmuxList: true,
      previousServerPid: 100,
      currentServerPid: 100,
      candidates,
      liveSessionNames: new Set(['tmux-b', 'tmux-c']),
    })?.affectedSessionIds).toEqual(['a']);
    expect(detectTmuxRecoveryIncident({
      authoritativeTmuxList: true,
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

describe('persisted recovery reconciliation', () => {
  const existingIncident = normalizeTmuxRecoveryIncident({
    id: 'old', detectedAt: 123, previousServerPid: 100, currentServerPid: 200,
    affectedSessionIds: ['a', 'b', 'deleted'],
  })!;
  const input = {
    authoritativeTmuxList: true, previousServerPid: 200, currentServerPid: 200,
    candidates, liveSessionNames: new Set(['tmux-a', 'tmux-b', 'tmux-c']), existingIncident,
  };

  it('removes verified running Agents and deleted records from an old incident', () => {
    expect(detectTmuxRecoveryIncident({ ...input, restoredSessionIds: new Set(['a']) }))
      .toEqual({ ...existingIncident, affectedSessionIds: ['b'] });
    expect(detectTmuxRecoveryIncident({ ...input, restoredSessionIds: new Set(['a', 'b']) }))
      .toBeNull();
  });

  it('keeps a recreated shell pending until its Agent is verified running', () => {
    const pending = { ...existingIncident, affectedSessionIds: ['a', 'b'] };
    expect(detectTmuxRecoveryIncident({ ...input, existingIncident: pending })).toBe(pending);
  });

  it('merges new losses while clearing recovered entries', () => {
    expect(detectTmuxRecoveryIncident({
      ...input, existingIncident: { ...existingIncident, affectedSessionIds: ['a'] },
      liveSessionNames: new Set(['tmux-a', 'tmux-c']), restoredSessionIds: new Set(['a']),
    })).toEqual({ ...existingIncident, affectedSessionIds: ['b'] });
  });

  it('drops acknowledged, intentionally deleted and no longer resumable entries', () => {
    expect(detectTmuxRecoveryIncident({
      ...input, dismissedSessionIds: new Set(['a']), intentionallyDeleting: new Set(['tmux-b']),
    })).toBeNull();
    expect(detectTmuxRecoveryIncident({
      ...input, candidates: candidates.map(candidate => ({ ...candidate, resumable: false })),
    })).toBeNull();
  });
});

describe('dismissed tmux losses', () => {
  it('does not recreate a dismissed incident on refresh or a replacement server', () => {
    for (const currentServerPid of [null, 200]) {
      expect(detectTmuxRecoveryIncident({
        authoritativeTmuxList: true,
        previousServerPid: 100, currentServerPid, candidates,
        liveSessionNames: new Set(), dismissedSessionIds: new Set(['a', 'b']),
      })).toBeNull();
    }
  });

  it('still reports another session loss', () => {
    expect(detectTmuxRecoveryIncident({
      authoritativeTmuxList: true,
      previousServerPid: 100, currentServerPid: null, candidates,
      liveSessionNames: new Set(), dismissedSessionIds: new Set(['a']),
    })?.affectedSessionIds).toEqual(['b']);
  });

  it('rearms recovered sessions for a future loss and drops deleted records', () => {
    const dismissed = retainDismissedTmuxSessions(
      ['a', 'b', 'deleted'], candidates, new Set(['tmux-a']),
    );
    expect(dismissed).toEqual(['b']);
    expect(detectTmuxRecoveryIncident({
      authoritativeTmuxList: true,
      previousServerPid: 200, currentServerPid: 200, candidates,
      liveSessionNames: new Set(), dismissedSessionIds: new Set(dismissed),
    })?.affectedSessionIds).toEqual(['a']);
  });
});

describe('unknown tmux inventory', () => {
  it('does not turn failed scans into loss, even with an unchanged or changed pid', () => {
    for (const currentServerPid of [137991, 200, null]) {
      expect(detectTmuxRecoveryIncident({
        authoritativeTmuxList: false, previousServerPid: 137991, currentServerPid,
        candidates, liveSessionNames: new Set(),
      })).toBeNull();
    }
  });

  it('preserves an existing incident until a successful observation', () => {
    const existingIncident = normalizeTmuxRecoveryIncident({ id: 'existing', affectedSessionIds: ['a'] })!;
    expect(detectTmuxRecoveryIncident({
      authoritativeTmuxList: false, previousServerPid: 137991, currentServerPid: 137991,
      candidates, liveSessionNames: new Set(), existingIncident,
    })).toBe(existingIncident);
  });
});
