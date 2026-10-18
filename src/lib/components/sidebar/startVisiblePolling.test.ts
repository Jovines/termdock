// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SECURE_READY_EVENT } from '../../federation/connectionRecovery';
import { startVisiblePolling } from './startVisiblePolling';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

describe('visible-only sidebar polling', () => {
  it('pauses all hidden idle intervals and resumes once on visibility or secure recovery', () => {
    vi.useFakeTimers();
    const inboxRequest = vi.fn(), groupRequest = vi.fn();
    setHidden(false);
    const stopInbox = startVisiblePolling(inboxRequest, 5_000, [SECURE_READY_EVENT]);
    const stopGroups = startVisiblePolling(groupRequest, 10_000, ['focus', SECURE_READY_EVENT]);
    expect([inboxRequest, groupRequest].map(request => request.mock.calls.length)).toEqual([1, 1]);
    expect(vi.getTimerCount()).toBe(2);

    setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect([inboxRequest, groupRequest].map(request => request.mock.calls.length)).toEqual([1, 1]);

    window.dispatchEvent(new Event(SECURE_READY_EVENT));
    expect([inboxRequest, groupRequest].map(request => request.mock.calls.length)).toEqual([1, 1]);
    setHidden(false);
    expect([inboxRequest, groupRequest].map(request => request.mock.calls.length)).toEqual([2, 2]);
    expect(vi.getTimerCount()).toBe(2);

    window.dispatchEvent(new Event(SECURE_READY_EVENT));
    expect([inboxRequest, groupRequest].map(request => request.mock.calls.length)).toEqual([3, 3]);
    stopInbox(); stopGroups();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replays the pre-patch one-minute hidden collaboration idle budget', () => {
    vi.useFakeTimers();
    const previous = {
      inboxWakeups: 0, inboxRequests: 0,
      sidebarGroupWakeups: 0, sidebarGroupRequests: 0,
      agentPanelWakeups: 0, agentPanelRequests: 0,
      messageWakeups: 0, messageRequests: 0,
      taskWakeups: 0, taskRequests: 0,
      mainWorkspaceWakeups: 0, mainWorkspaceRequests: 0,
      archiveWakeups: 0, archiveRequests: 0,
      kanbanWakeups: 0, kanbanRequests: 0,
    };
    setHidden(true);
    const timers = [
      window.setInterval(() => { previous.inboxWakeups++; if (!document.hidden) previous.inboxRequests++; }, 5_000),
      window.setInterval(() => { previous.sidebarGroupWakeups++; previous.sidebarGroupRequests++; }, 10_000),
      window.setInterval(() => { previous.agentPanelWakeups++; previous.agentPanelRequests += 3; }, 10_000),
      window.setInterval(() => { previous.messageWakeups++; if (!document.hidden) previous.messageRequests++; }, 3_000),
      window.setInterval(() => { previous.taskWakeups++; if (!document.hidden) previous.taskRequests++; }, 2_500),
      window.setInterval(() => { previous.mainWorkspaceWakeups++; if (!document.hidden) previous.mainWorkspaceRequests++; }, 10_000),
      window.setInterval(() => { previous.archiveWakeups++; if (!document.hidden) previous.archiveRequests++; }, 10_000),
      window.setInterval(() => { previous.kanbanWakeups++; }, 30_000),
    ];
    vi.advanceTimersByTime(60_000);
    for (const timer of timers) window.clearInterval(timer);
    expect(previous).toEqual({
      inboxWakeups: 12, inboxRequests: 0,
      sidebarGroupWakeups: 6, sidebarGroupRequests: 6,
      agentPanelWakeups: 6, agentPanelRequests: 18,
      messageWakeups: 20, messageRequests: 0,
      taskWakeups: 24, taskRequests: 0,
      mainWorkspaceWakeups: 6, mainWorkspaceRequests: 0,
      archiveWakeups: 6, archiveRequests: 0,
      kanbanWakeups: 2, kanbanRequests: 0,
    });
  });

  it('counts zero timer callbacks and requests during a hidden 60-second window across active panes', () => {
    vi.useFakeTimers();
    const periods = [5_000, 10_000, 10_000, 3_000, 2_500, 10_000, 10_000, 30_000];
    const requests = periods.map(() => vi.fn());
    let hiddenTimerCallbacks = 0;
    const setInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      return setInterval(typeof handler === 'function' ? (...callbackArgs: unknown[]) => {
        hiddenTimerCallbacks++;
        handler(...callbackArgs);
      } : handler, timeout, ...args);
    }) as typeof window.setInterval);
    setHidden(true);
    const stops = periods.map((period, index) => startVisiblePolling(requests[index], period, [SECURE_READY_EVENT]));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(hiddenTimerCallbacks).toBe(0);
    expect(requests.map(request => request.mock.calls.length)).toEqual(periods.map(() => 0));

    setHidden(false);
    expect(requests.map(request => request.mock.calls.length)).toEqual(periods.map(() => 1));
    expect(vi.getTimerCount()).toBe(periods.length);
    for (const stop of stops) stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
