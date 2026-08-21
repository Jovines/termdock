import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_RESUME_INITIAL_DELAY_MS,
  BACKGROUND_RESUME_STAGGER_MS,
  VISIBLE_RECONNECT_WATCHDOG_MS,
  buildResumeDelayBySessionId,
  getVisibleReconnectWatchdogDelayMs,
} from './resumeScheduling';

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
