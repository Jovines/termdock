// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNativeViewportFeedback } from './nativeViewportFeedback';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('restarts the timeout for identical errors and an older timeout cannot clear the newer error', () => {
  const { result } = renderHook(() => useNativeViewportFeedback('session-a:target-a'));
  act(() => result.current.showClipboardError('upload failed'));
  act(() => vi.advanceTimersByTime(4000));
  act(() => result.current.showClipboardError('upload failed'));
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current.message).toBe('upload failed');
  act(() => vi.advanceTimersByTime(4000));
  expect(result.current.message).toBeNull();
});

it('returns an operation handle that rejects stale same-owner clipboard completions', () => {
  const { result } = renderHook(() => useNativeViewportFeedback('session-a:target-a'));
  let first!: ReturnType<typeof result.current.beginClipboardOperation>;
  let second!: typeof first;
  act(() => { first = result.current.beginClipboardOperation(); });
  expect(first.isCurrent()).toBe(true);
  act(() => { second = result.current.beginClipboardOperation(); });
  expect(first.isCurrent()).toBe(false);
  expect(second.isCurrent()).toBe(true);
  act(() => {
    first.fail('stale Cmd+C failure');
    first.succeed();
  });
  expect(result.current.message).toBeNull();
  act(() => second.fail('current Cmd+C failure'));
  expect(result.current.message).toBe('current Cmd+C failure');
  act(() => second.succeed());
  expect(second.isCurrent()).toBe(false);
  expect(result.current.message).toBeNull();
});

it('rejects stale success and failure callbacks, preserves persistent errors, and cancels timers on owner change/unmount', () => {
  const { result, rerender, unmount } = renderHook(({ owner }) => useNativeViewportFeedback(owner), {
    initialProps: { owner: 'session-a:target-a' },
  });
  let oldOperation!: ReturnType<typeof result.current.beginClipboardOperation>;
  act(() => {
    oldOperation = result.current.beginClipboardOperation();
    result.current.showClipboardError('old failure', oldOperation);
  });
  let currentOperation!: typeof oldOperation;
  act(() => { currentOperation = result.current.beginClipboardOperation(); });
  act(() => result.current.clearClipboardError(oldOperation));
  act(() => result.current.showClipboardError('new failure', currentOperation));
  act(() => result.current.showClipboardError('late old failure', oldOperation));
  expect(result.current.message).toBe('new failure');

  act(() => result.current.showPersistentError('native input rejected'));
  act(() => result.current.clearClipboardError(currentOperation));
  act(() => vi.advanceTimersByTime(6000));
  expect(result.current.message).toBe('native input rejected');

  let ownerOperation!: typeof currentOperation;
  act(() => { ownerOperation = result.current.beginClipboardOperation(); });
  rerender({ owner: 'session-b:target-b' });
  expect(ownerOperation.isCurrent()).toBe(false);
  act(() => ownerOperation.fail('late owner failure'));
  expect(result.current.message).toBeNull();
  act(() => result.current.showClipboardError('pending'));
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('an owner roundtrip never revalidates old pending operations and clipboard errors do not erase persistent faults',()=>{
 const {result,rerender}=renderHook(({owner})=>useNativeViewportFeedback(owner),{initialProps:{owner:'a'}});
 let old!:ReturnType<typeof result.current.beginClipboardOperation>;act(()=>{old=result.current.beginClipboardOperation();});
 rerender({owner:'b'});rerender({owner:'a'});expect(old.isCurrent()).toBe(false);
 act(()=>result.current.showPersistentError('checkpoint failed'));act(()=>result.current.showClipboardError('temporary'));
 act(()=>vi.advanceTimersByTime(6000));expect(result.current.message).toBe('checkpoint failed');
});
