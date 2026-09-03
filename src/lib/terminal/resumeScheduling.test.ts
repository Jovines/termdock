import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_RESUME_INITIAL_DELAY_MS,
  BACKGROUND_RESUME_STAGGER_MS,
  FOREGROUND_RESUME_COALESCE_MS,
  VISIBLE_RECONNECT_WATCHDOG_MS,
  buildResumeDelayBySessionId,
  getVisibleReconnectWatchdogDelayMs,
  resolvePrioritySessionId,
  selectConnectionForegroundSessionId,
  shouldScheduleForegroundResume,
  shouldRunResumeRequest,
  shouldForceForegroundReconnect,
  shouldStartInitialConnection,
  shouldMountSessionViewport,
  shouldPublishSessionDataUpdate,
} from './resumeScheduling';

describe('resolvePrioritySessionId', () => {
  const sessions = [
    { id: 'frontend-a', backendSessionId: 'backend-a' },
    { id: 'frontend-b', backendSessionId: 'backend-b' },
  ];

  it('accepts both frontend and backend notification ids', () => {
    expect(resolvePrioritySessionId(sessions, 'frontend-b')).toBe('frontend-b');
    expect(resolvePrioritySessionId(sessions, 'backend-b')).toBe('frontend-b');
  });

  it('does not redirect an unknown notification to the wrong session', () => {
    expect(resolvePrioritySessionId(sessions, 'missing')).toBeNull();
    expect(resolvePrioritySessionId(sessions, null)).toBeNull();
  });
});

describe('selectConnectionForegroundSessionId', () => {
  it('uses notification priority ahead of the current and persisted session', () => {
    expect(selectConnectionForegroundSessionId({
      prioritySessionId: 'notification',
      activeSessionId: 'current',
      persistedActiveSessionId: 'persisted',
      firstSessionId: 'first',
    })).toBe('notification');
  });

  it('restores the persisted selection instead of falling back to the first tab', () => {
    expect(selectConnectionForegroundSessionId({
      prioritySessionId: null,
      activeSessionId: null,
      persistedActiveSessionId: 'persisted',
      firstSessionId: 'first',
    })).toBe('persisted');
  });
});

describe('shouldStartInitialConnection', () => {
  it('keeps background sessions out of the cold-start critical path', () => {
    expect(shouldStartInitialConnection({
      sessionId: 'selected',
      foregroundSessionId: 'selected',
      foregroundReady: false,
    })).toBe(true);
    expect(shouldStartInitialConnection({
      sessionId: 'background',
      foregroundSessionId: 'selected',
      foregroundReady: false,
    })).toBe(false);
  });

  it('releases background sessions after the selected session is ready', () => {
    expect(shouldStartInitialConnection({
      sessionId: 'background',
      foregroundSessionId: 'selected',
      foregroundReady: true,
    })).toBe(true);
  });

  it('does not deadlock startup when there is no selected session', () => {
    expect(shouldStartInitialConnection({
      sessionId: 'first',
      foregroundSessionId: null,
      foregroundReady: false,
    })).toBe(true);
  });
});

describe('shouldMountSessionViewport', () => {
  const visibleSessionIds = new Set(['selected', 'split-peer']);
  const deferredViewportSessionIds = new Set(['background']);

  it('mounts visible and previously warmed viewports', () => {
    for (const sessionId of visibleSessionIds) {
      expect(shouldMountSessionViewport({
        sessionId,
        foregroundSessionId: 'selected',
        visibleSessionIds,
        deferredViewportSessionIds,
      })).toBe(true);
    }
    expect(shouldMountSessionViewport({
      sessionId: 'background',
      foregroundSessionId: 'selected',
      visibleSessionIds,
      deferredViewportSessionIds,
    })).toBe(true);
    expect(shouldMountSessionViewport({
      sessionId: 'cold',
      foregroundSessionId: 'selected',
      visibleSessionIds,
      deferredViewportSessionIds,
    })).toBe(false);
  });
});

describe('shouldPublishSessionDataUpdate', () => {
  it('preserves cached tab chrome until runtime restoration completes', () => {
    expect(shouldPublishSessionDataUpdate(true)).toBe(false);
    expect(shouldPublishSessionDataUpdate(false)).toBe(true);
  });
});

describe('shouldRunResumeRequest', () => {
  it('runs the selected session first and holds the background wave', () => {
    expect(shouldRunResumeRequest({
      sessionId: 'selected', foregroundSessionId: 'selected', requestToken: 4, foregroundCompletedToken: 3,
    })).toBe(true);
    expect(shouldRunResumeRequest({
      sessionId: 'background', foregroundSessionId: 'selected', requestToken: 4, foregroundCompletedToken: 3,
    })).toBe(false);
  });

  it('releases the background wave only after foreground connected', () => {
    expect(shouldRunResumeRequest({
      sessionId: 'background', foregroundSessionId: 'selected', requestToken: 4, foregroundCompletedToken: 4,
    })).toBe(true);
  });
});

describe('shouldScheduleForegroundResume', () => {
  it('coalesces the focus and visibility events emitted by one foreground transition', () => {
    expect(shouldScheduleForegroundResume(null, 1_000)).toBe(true);
    expect(shouldScheduleForegroundResume(1_000, 1_000 + FOREGROUND_RESUME_COALESCE_MS - 1)).toBe(false);
    expect(shouldScheduleForegroundResume(1_000, 1_000 + FOREGROUND_RESUME_COALESCE_MS)).toBe(true);
  });
});

describe('shouldForceForegroundReconnect', () => {
  it('replaces the foreground socket after a real background or network resume', () => {
    expect(shouldForceForegroundReconnect({ wasPageHidden: true, reason: 'visibility' })).toBe(true);
    expect(shouldForceForegroundReconnect({ wasPageHidden: false, reason: 'bfcache' })).toBe(true);
    expect(shouldForceForegroundReconnect({ wasPageHidden: false, reason: 'online' })).toBe(true);
  });

  it('keeps an ordinary window focus on the lightweight probe path', () => {
    expect(shouldForceForegroundReconnect({ wasPageHidden: false, reason: 'focus' })).toBe(false);
    expect(shouldForceForegroundReconnect({ wasPageHidden: false, reason: 'pageshow' })).toBe(false);
  });
});

describe('buildResumeDelayBySessionId', () => {
  it('resumes every visible split pane immediately and staggers background sessions', () => {
    const delays = buildResumeDelayBySessionId(
      ['left-pane', 'right-pane', 'background-a', 'background-b'],
      new Set(['left-pane', 'right-pane']),
    );

    expect(delays.get('left-pane')).toBe(0);
    expect(delays.get('right-pane')).toBe(0);
    expect(delays.get('background-a')).toBe(BACKGROUND_RESUME_INITIAL_DELAY_MS);
    expect(delays.get('background-b')).toBe(
      BACKGROUND_RESUME_INITIAL_DELAY_MS + BACKGROUND_RESUME_STAGGER_MS,
    );
  });

  it('does not let visible sessions consume a background stagger slot', () => {
    const delays = buildResumeDelayBySessionId(
      ['background-a', 'visible', 'background-b'],
      new Set(['visible']),
    );

    expect(delays.get('background-a')).toBe(BACKGROUND_RESUME_INITIAL_DELAY_MS);
    expect(delays.get('visible')).toBe(0);
    expect(delays.get('background-b')).toBe(
      BACKGROUND_RESUME_INITIAL_DELAY_MS + BACKGROUND_RESUME_STAGGER_MS,
    );
  });

  it('promotes a background session to immediate when the user switches to it', () => {
    const beforeSwitch = buildResumeDelayBySessionId(
      ['first-tab', 'second-tab'],
      new Set(['first-tab']),
    );
    const afterSwitch = buildResumeDelayBySessionId(
      ['first-tab', 'second-tab'],
      new Set(['second-tab']),
    );

    expect(beforeSwitch.get('second-tab')).toBe(BACKGROUND_RESUME_INITIAL_DELAY_MS);
    expect(afterSwitch.get('second-tab')).toBe(0);
    expect(afterSwitch.get('first-tab')).toBe(BACKGROUND_RESUME_INITIAL_DELAY_MS);
  });
});

describe('getVisibleReconnectWatchdogDelayMs', () => {
  it('only watches a visible session that is still reconnecting', () => {
    expect(getVisibleReconnectWatchdogDelayMs({
      isActive: false,
      isStreamReady: false,
      reconnectStartedAt: 1_000,
      now: 2_000,
    })).toBeNull();
    expect(getVisibleReconnectWatchdogDelayMs({
      isActive: true,
      isStreamReady: true,
      reconnectStartedAt: 1_000,
      now: 2_000,
    })).toBeNull();
  });

  it('preserves the original reconnect deadline when a background tab becomes visible', () => {
    expect(getVisibleReconnectWatchdogDelayMs({
      isActive: true,
      isStreamReady: false,
      reconnectStartedAt: 10_000,
      now: 10_500,
    })).toBe(VISIBLE_RECONNECT_WATCHDOG_MS - 500);
    expect(getVisibleReconnectWatchdogDelayMs({
      isActive: true,
      isStreamReady: false,
      reconnectStartedAt: 10_000,
      now: 10_000 + VISIBLE_RECONNECT_WATCHDOG_MS + 1,
    })).toBe(0);
  });
});
