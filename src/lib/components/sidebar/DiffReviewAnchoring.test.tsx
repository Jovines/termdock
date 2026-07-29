// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffReview, nextDiffStreamScrollRequest, type DiffReviewFile } from './DiffReview';

const streamItems = vi.hoisted(() => new Map<string, {
  visible: boolean;
  onContentReady?: (key: string) => void;
  onHeightChange?: (key: string, previousHeight: number, nextHeight: number) => void;
}>());

vi.mock('./DiffReviewWorkspace', () => ({
  DiffReviewWorkspace: ({ detail }: { detail: React.ReactNode }) => <div>{detail}</div>,
}));

vi.mock('./DiffStreamItem', () => ({
  DiffStreamItem: (props: {
    selectionPath: string;
    visible: boolean;
    onContentReady?: (key: string) => void;
    onHeightChange?: (key: string, previousHeight: number, nextHeight: number) => void;
  }) => {
    streamItems.set(props.selectionPath, props);
    return <div data-diff-stream-item={props.selectionPath} data-rendered={props.visible ? 'true' : 'false'} />;
  },
}));

const repoRoot = '/repo';
const files: DiffReviewFile[] = ['a.ts', 'b.ts', 'c.ts'].map((name) => ({
  key: `${repoRoot}/${name}`,
  path: name,
  absolutePath: `${repoRoot}/${name}`,
  status: 'modified',
  repoRoot,
  displayName: name,
  auditRecords: [],
}));
const groups = [{
  key: repoRoot,
  root: repoRoot,
  label: 'repo',
  files: files.map((file) => ({
    key: file.key,
    path: file.path,
    absolutePath: file.absolutePath,
    displayName: file.displayName,
    status: file.status,
  })),
}];

describe('DiffReview click anchoring', () => {
  const intersectionCallbacks: IntersectionObserverCallback[] = [];
  const animationFrames = new Map<number, FrameRequestCallback>();
  let animationFrameId = 0;
  const originalIntersectionObserver = globalThis.IntersectionObserver;

  beforeEach(() => {
    streamItems.clear();
    intersectionCallbacks.length = 0;
    animationFrames.clear();
    animationFrameId = 0;
    if (!globalThis.CSS) {
      Object.defineProperty(globalThis, 'CSS', { configurable: true, value: {} });
    }
    Object.defineProperty(globalThis.CSS, 'escape', { configurable: true, value: (value: string) => value });
    globalThis.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '';
      thresholds = [];
    };
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++animationFrameId;
      animationFrames.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      animationFrames.delete(id);
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.IntersectionObserver = originalIntersectionObserver;
    vi.restoreAllMocks();
  });

  function flushAnimationFrames() {
    const pending = Array.from(animationFrames.entries());
    animationFrames.clear();
    pending.forEach(([, callback]) => callback(performance.now()));
  }

  it('positions once, then preserves the viewport anchor through the shared size model', () => {
    const targetKey = files[2].key;
    const { container } = render(
      <DiffReview
        files={files}
        groups={groups}
        selectedKey={targetKey}
        scrollToKey={targetKey}
        scrollToKeyNonce={1}
        onSelectFile={() => undefined}
        mode="list"
        onModeChange={() => undefined}
        collapsedDirectoryKeys={new Set()}
        onToggleDirectory={() => undefined}
        renderLeading={() => null}
        renderStreamBadge={() => null}
        mobile={false}
        backLabel="Back"
        wrap
        showScrollHint={false}
        activePane
      />,
    );
    const scroller = container.querySelector('.termdock-diff-stream-scroller') as HTMLDivElement;
    const target = container.querySelector(`[data-diff-stream-item="${targetKey}"]`) as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 100 });
    scroller.getBoundingClientRect = vi.fn(() => ({ top: 50 } as DOMRect));
    target.getBoundingClientRect = vi.fn(() => ({ top: 500 } as DOMRect));
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top);
    });
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;

    act(flushAnimationFrames);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 550, behavior: 'instant' });

    act(() => streamItems.get(files[0].key)?.onHeightChange?.(files[0].key, 64, 274));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 760, behavior: 'instant' });

    act(() => streamItems.get(targetKey)?.onHeightChange?.(targetKey, 64, 480));
    expect(scrollTo).toHaveBeenCalledTimes(2);

    const first = container.querySelector(`[data-diff-stream-item="${files[0].key}"]`) as HTMLElement;
    const second = container.querySelector(`[data-diff-stream-item="${files[1].key}"]`) as HTMLElement;
    first.getBoundingClientRect = vi.fn(() => ({ bottom: 40 } as DOMRect));
    second.getBoundingClientRect = vi.fn(() => ({ bottom: 200 } as DOMRect));
    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

    act(() => streamItems.get(files[0].key)?.onHeightChange?.(files[0].key, 274, 374));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 400, behavior: 'instant' });
  });

  it('loads intersecting files one at a time instead of igniting the whole neighbourhood', () => {
    const { container } = render(
      <DiffReview
        files={files}
        groups={groups}
        selectedKey={null}
        onSelectFile={() => undefined}
        mode="list"
        onModeChange={() => undefined}
        collapsedDirectoryKeys={new Set()}
        onToggleDirectory={() => undefined}
        renderLeading={() => null}
        renderStreamBadge={() => null}
        mobile={false}
        backLabel="Back"
        wrap
        showScrollHint={false}
        activePane
      />,
    );
    const elements = files.map((file) => (
      container.querySelector(`[data-diff-stream-item="${file.key}"]`) as HTMLElement
    ));
    act(() => intersectionCallbacks[0]?.(
      elements.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry),
      {} as IntersectionObserver,
    ));

    expect(files.map((file) => streamItems.get(file.key)?.visible)).toEqual([true, false, false]);

    act(() => streamItems.get(files[0].key)?.onContentReady?.(files[0].key));
    act(flushAnimationFrames);
    expect(files.map((file) => streamItems.get(file.key)?.visible)).toEqual([true, true, false]);
  });

  it('creates a fresh positioning request for every file tap, including repeated mobile taps', () => {
    const first = nextDiffStreamScrollRequest({ key: null, nonce: 0 }, files[1].key);
    const repeated = nextDiffStreamScrollRequest(first, files[1].key);

    expect(first).toEqual({ key: files[1].key, nonce: 1 });
    expect(repeated).toEqual({ key: files[1].key, nonce: 2 });
  });
});
