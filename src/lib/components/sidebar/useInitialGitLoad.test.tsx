// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInitialGitLoad, waitForGitPreferences } from './useInitialGitLoad';

describe('initial sidebar Git request', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('continues after a settings request stalls, even if it rejects later', async () => {
    let reject!: (error: Error) => void;
    const settings = new Promise<void>((_, fail) => { reject = fail; });
    const completed = vi.fn();
    const waiting = waitForGitPreferences(() => settings).then(completed);
    await vi.advanceTimersByTimeAsync(3_000);
    await waiting;
    expect(completed).toHaveBeenCalledOnce();
    reject(new Error('Disconnected'));
    await Promise.resolve();
  });

  it('continues immediately when preferences fail and clears its timer', async () => {
    await waitForGitPreferences(() => Promise.reject(new Error('Offline')));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for successful preferences without retaining the timeout', async () => {
    await waitForGitPreferences(() => Promise.resolve());
    expect(vi.getTimerCount()).toBe(0);
  });

  function setup() {
    const props = {
      active: true, rootPath: '/workspace', loading: false, delay: 200,
      lastStartedRoot: { current: null as string | null }, load: vi.fn(),
    };
    return { props, ...renderHook(useInitialGitLoad, { initialProps: props }) };
  }

  it('reschedules when a render replaces the callback before the request starts', () => {
    const { props, rerender } = setup();
    const nextLoad = vi.fn();
    act(() => vi.advanceTimersByTime(100));
    rerender({ ...props, load: nextLoad });
    act(() => vi.advanceTimersByTime(200));
    expect(props.load).not.toHaveBeenCalled();
    expect(nextLoad).toHaveBeenCalledExactlyOnceWith('/workspace');
  });

  it('loads after closing and reopening during the initial delay', () => {
    const { props, rerender } = setup();
    rerender({ ...props, active: false });
    act(() => vi.advanceTimersByTime(500));
    expect(props.lastStartedRoot.current).toBeNull();
    rerender(props);
    act(() => vi.advanceTimersByTime(200));
    expect(props.load).toHaveBeenCalledExactlyOnceWith('/workspace');
  });

  it('loads when switching from delayed Changes to immediate desktop Git', () => {
    const { props, rerender } = setup();
    rerender({ ...props, delay: 0 });
    act(() => vi.advanceTimersByTime(0));
    expect(props.load).toHaveBeenCalledExactlyOnceWith('/workspace');
  });

  it('only requests the new workspace when switching during the delay', () => {
    const { props, rerender } = setup();
    rerender({ ...props, rootPath: '/other' });
    act(() => vi.advanceTimersByTime(200));
    expect(props.load).toHaveBeenCalledExactlyOnceWith('/other');
  });

  it('does not duplicate a started request when loading state changes', () => {
    const { props, rerender } = setup();
    act(() => vi.advanceTimersByTime(200));
    rerender({ ...props, loading: true });
    rerender(props);
    act(() => vi.advanceTimersByTime(500));
    expect(props.load).toHaveBeenCalledTimes(1);
  });
});
