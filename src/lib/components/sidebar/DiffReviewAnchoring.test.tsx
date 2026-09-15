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

const preload = vi.hoisted(() => vi.fn());
vi.mock('./DiffViewer', () => ({
  preloadPreparedFileDiff: preload,
  invalidateFileDiffCached: vi.fn(),
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
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

  beforeEach(() => {
    streamItems.clear();
    preload.mockClear();
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
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
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
    else delete (HTMLElement.prototype as { scrollTo?: typeof HTMLElement.prototype.scrollTo }).scrollTo;
    vi.restoreAllMocks();
  });

  function flushAnimationFrames() {
    const pending = Array.from(animationFrames.entries());
    animationFrames.clear();
    pending.forEach(([, callback]) => callback(performance.now()));
  }

  it('keeps a focused file pinned in place while measured sizes settle', () => {
    // Free-canvas semantics: focusing a file scrolls it top-aligned in
    // absolute canvas coordinates (2 x 104px estimated heights above it);
    // when a card ABOVE the viewport is remeasured, the anchor compensation
    // carries scrollTop along by exactly the delta (208 + (274 - 104) = 378),
    // so the focused card never moves visually. A resize of the focused card
    // itself must not scroll at all.
    const targetKey = files[2].key;
    const scrollTo = vi.fn(function (this: HTMLElement, { top }: ScrollToOptions) {
      this.scrollTop = Number(top);
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollTo,
    });
    render(
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
        activePane
      />,
    );
    act(flushAnimationFrames);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 208, behavior: 'instant' });

    act(() => streamItems.get(files[0].key)?.onHeightChange?.(files[0].key, 64, 274));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 378, behavior: 'instant' });

    act(() => streamItems.get(targetKey)?.onHeightChange?.(targetKey, 64, 480));
    expect(scrollTo).toHaveBeenCalledTimes(2);
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

  it('never clamps native scrolling while visible cards are still loading', () => {
    // Distinct keys: measured heights are cached module-level per key, and
    // earlier tests in this file have already recorded real heights for the
    // shared fixture.
    const gateRepo = '/repo-gate';
    const gateFiles: DiffReviewFile[] = ['a.ts', 'b.ts', 'c.ts'].map((name) => ({
      key: `${gateRepo}/${name}`,
      path: name,
      absolutePath: `${gateRepo}/${name}`,
      status: 'modified',
      repoRoot: gateRepo,
      displayName: name,
      auditRecords: [],
    }));
    const gateGroups = [{
      key: gateRepo,
      root: gateRepo,
      label: 'repo',
      files: gateFiles.map((file) => ({
        key: file.key,
        path: file.path,
        absolutePath: file.absolutePath,
        displayName: file.displayName,
        status: file.status,
      })),
    }];
    const { container } = render(
      <DiffReview
        files={gateFiles}
        groups={gateGroups}
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
        activePane
      />,
    );
    const scroller = container.querySelector('.termdock-diff-stream-scroller') as HTMLElement;
    const scrollTo = (top: number) => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event('scroll'));
    };
    act(() => scrollTo(300));
    expect(scroller.scrollTop).toBe(300);
    act(flushAnimationFrames);
    expect(streamItems.get(gateFiles[2].key)?.visible).toBe(true);

    act(() => scrollTo(900));
    expect(scroller.scrollTop).toBe(900);

    act(() => scrollTo(0));
    expect(scroller.scrollTop).toBe(0);
    act(flushAnimationFrames);
    expect(streamItems.get(gateFiles[0].key)?.visible).toBe(true);
  });

  it('recaptures the visible anchor before late measurements during a fast scroll', () => {
    const fastRepo = '/repo-fast-scroll';
    const fastFiles: DiffReviewFile[] = ['a.ts', 'b.ts', 'c.ts'].map((name) => ({
      key: `${fastRepo}/${name}`,
      path: name,
      absolutePath: `${fastRepo}/${name}`,
      status: 'modified',
      repoRoot: fastRepo,
      displayName: name,
      auditRecords: [],
    }));
    const fastGroups = [{
      key: fastRepo,
      root: fastRepo,
      label: 'repo',
      files: fastFiles.map((file) => ({
        key: file.key,
        path: file.path,
        absolutePath: file.absolutePath,
        displayName: file.displayName,
        status: file.status,
      })),
    }];
    const scrollTo = vi.fn(function (this: HTMLElement, { top }: ScrollToOptions) {
      this.scrollTop = Number(top);
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollTo,
    });
    const { container } = render(
      <DiffReview
        files={fastFiles}
        groups={fastGroups}
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
        activePane
      />,
    );
    const scroller = container.querySelector('.termdock-diff-stream-scroller') as HTMLElement;

    act(() => {
      scroller.scrollTop = 208;
      scroller.dispatchEvent(new Event('scroll'));
      flushAnimationFrames();
    });
    act(() => streamItems.get(fastFiles[0].key)?.onHeightChange?.(fastFiles[0].key, 104, 274));

    // File C remains pinned: the 170px growth above it is added once, instead
    // of leaving the stale File A anchor to make the viewport visibly jump.
    expect(scroller.scrollTop).toBe(378);
  });

  it('top-aligns the last short file before loading neighbours, including repeated clicks', () => {
    const localFiles = files.map((file) => ({ ...file, key: `/tail/${file.path}` }));
    const localGroups = [{ ...groups[0], files: localFiles }];
    const target = localFiles[2].key;
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function (this: HTMLElement, { top }: ScrollToOptions) {
        const canvas = this.querySelector('[data-diff-stream-canvas]') as HTMLElement;
        // Model actual browser clamping, which jsdom does not implement.
        this.scrollTop = Math.max(0, Math.min(Number(top), Number.parseFloat(canvas.style.height) - this.clientHeight));
      },
    });
    const props = {
      files: localFiles, groups: localGroups, selectedKey: target,
      scrollToKey: target, scrollToKeyNonce: 1,
      onSelectFile: () => undefined, mode: 'list' as const,
      onModeChange: () => undefined, collapsedDirectoryKeys: new Set<string>(),
      onToggleDirectory: () => undefined, renderLeading: () => null,
      renderStreamBadge: () => null, mobile: true, backLabel: 'Back', wrap: true, activePane: true,
    };
    const { container, rerender } = render(<DiffReview {...props} />);
    const scroller = container.querySelector('.termdock-diff-stream-scroller') as HTMLElement;
    const targetTop = () => Number.parseFloat((container.querySelector(`[data-diff-canvas-slot="${target}"]`) as HTMLElement).style.top);
    expect(scroller.scrollTop).toBe(targetTop());
    expect(localFiles.map((file) => streamItems.get(file.key)?.visible)).toEqual([false, false, true]);
    expect(preload).not.toHaveBeenCalled();
    act(flushAnimationFrames);
    expect(localFiles.map((file) => streamItems.get(file.key)?.visible)).toEqual([false, false, true]);

    act(() => streamItems.get(target)?.onHeightChange?.(target, 104, 180));
    expect(scroller.scrollTop).toBe(targetTop());
    act(() => streamItems.get(target)?.onContentReady?.(target));
    act(flushAnimationFrames);
    expect(streamItems.get(localFiles[1].key)?.visible).toBe(true);
    act(() => streamItems.get(localFiles[1].key)?.onHeightChange?.(localFiles[1].key, 104, 900));
    expect(scroller.scrollTop).toBe(targetTop());

    scroller.scrollTop = 0;
    rerender(<DiffReview {...props} scrollToKeyNonce={2} />);
    expect(scroller.scrollTop).toBe(targetTop());
  });

  it('mounts a distant clicked file even while the mobile scroller is hidden', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(0);
    const manyFiles = Array.from({ length: 80 }, (_, index) => ({
      ...files[0], key: `/distant/${index}.ts`, path: `${index}.ts`,
    }));
    const target = manyFiles[79].key;
    const props = {
      files: manyFiles, groups: [], selectedKey: target, scrollToKey: target, scrollToKeyNonce: 1,
      onSelectFile: () => undefined, mode: 'list' as const,
      onModeChange: () => undefined, collapsedDirectoryKeys: new Set<string>(),
      onToggleDirectory: () => undefined, renderLeading: () => null,
      renderStreamBadge: () => null, mobile: true, backLabel: 'Back', wrap: true, activePane: true,
    };
    const { container, rerender } = render(<DiffReview {...props} />);
    expect(streamItems.get(target)?.visible).toBe(true);
    expect(streamItems.get(manyFiles[0].key)?.visible).toBe(false);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    // Switching layout triggers viewport measurement, as ResizeObserver does.
    rerender(<DiffReview {...props} mobile={false} />);
    const scroller = container.querySelector('.termdock-diff-stream-scroller') as HTMLElement;
    expect(scroller.scrollTop).toBe(79 * 104);
  });

  it('creates a fresh positioning request for every file tap, including repeated mobile taps', () => {
    const first = nextDiffStreamScrollRequest({ key: null, nonce: 0 }, files[1].key);
    const repeated = nextDiffStreamScrollRequest(first, files[1].key);

    expect(first).toEqual({ key: files[1].key, nonce: 1 });
    expect(repeated).toEqual({ key: files[1].key, nonce: 2 });
  });
});
