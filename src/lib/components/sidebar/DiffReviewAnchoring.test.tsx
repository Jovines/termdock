// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffReview, nextDiffStreamScrollRequest, type DiffReviewFile } from './DiffReview';

vi.mock('./DiffReviewWorkspace', () => ({
  DiffReviewWorkspace: ({ detail }: { detail: React.ReactNode }) => <div>{detail}</div>,
}));

vi.mock('./DiffStreamItem', () => ({
  DiffStreamItem: ({ selectionPath, visible }: { selectionPath: string; visible: boolean }) => (
    <div data-diff-stream-item={selectionPath} data-rendered={visible ? 'true' : 'false'} />
  ),
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
  const resizeCallbacks: ResizeObserverCallback[] = [];
  const animationFrames = new Map<number, FrameRequestCallback>();
  let animationFrameId = 0;
  let itemTop = 500;

  beforeEach(() => {
    resizeCallbacks.length = 0;
    animationFrames.clear();
    animationFrameId = 0;
    itemTop = 500;
    if (!globalThis.CSS) {
      Object.defineProperty(globalThis, 'CSS', { configurable: true, value: {} });
    }
    Object.defineProperty(globalThis.CSS, 'escape', { configurable: true, value: (value: string) => value });
    globalThis.IntersectionObserver = class {
      constructor() {}
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '';
      thresholds = [];
    };
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
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
    vi.restoreAllMocks();
  });

  function flushAnimationFrames() {
    const pending = Array.from(animationFrames.entries());
    animationFrames.clear();
    pending.forEach(([, callback]) => callback(performance.now()));
  }

  it('re-aligns the clicked file when earlier lazy content changes height, then yields to user input', () => {
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
    target.getBoundingClientRect = vi.fn(() => ({ top: itemTop } as DOMRect));
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top);
    });
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;

    act(flushAnimationFrames);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 550, behavior: 'instant' });

    itemTop = 260;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    act(flushAnimationFrames);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 760, behavior: 'instant' });

    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    itemTop = 320;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    act(flushAnimationFrames);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('creates a fresh positioning request for every file tap, including repeated mobile taps', () => {
    const first = nextDiffStreamScrollRequest({ key: null, nonce: 0 }, files[1].key);
    const repeated = nextDiffStreamScrollRequest(first, files[1].key);

    expect(first).toEqual({ key: files[1].key, nonce: 1 });
    expect(repeated).toEqual({ key: files[1].key, nonce: 2 });
  });
});
