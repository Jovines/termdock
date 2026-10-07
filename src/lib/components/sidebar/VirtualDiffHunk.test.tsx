// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualDiffHunk } from './VirtualDiffHunk';

const callbacks = new Map<Element, IntersectionObserverCallback>();

beforeEach(() => {
  callbacks.clear();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) { callbacks.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const top = Number(this.dataset.top ?? 0);
    const height = this.classList.contains('termdock-diff-stream-scroller') ? 600 : 200;
    return { top, bottom: top + height, height, width: 500, left: 0, right: 500, x: 0, y: top, toJSON() {} };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function intersect(element: Element, isIntersecting: boolean) {
  act(() => callbacks.get(element)!([{ target: element, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
}

describe('diff hunk window', () => {
  it('keeps distant code out of the DOM and retains measured height after scrolling away', () => {
    const activeRef = { current: true };
    const view = render(<div className="termdock-diff-stream-scroller">
      <VirtualDiffHunk enabled activeRef={activeRef} estimatedHeight={150} data-top="2000">
        <button>hunk action</button><pre>highlighted code</pre>
      </VirtualDiffHunk>
    </div>);
    const hunk = view.container.querySelector('[data-diff-hunk-mounted]')!;
    expect(view.queryByText('highlighted code')).toBeNull();
    intersect(hunk, true);
    expect(view.getByText('highlighted code')).toBeTruthy();
    intersect(hunk, false);
    expect(view.queryByText('highlighted code')).toBeNull();
    expect((hunk as HTMLElement).style.height).toBe('200px');
  });

  it('retains visible controls across rapid tab round trips', () => {
    const activeRef = { current: true };
    const view = render(<div className="termdock-diff-stream-scroller">
      <VirtualDiffHunk enabled activeRef={activeRef} estimatedHeight={150}><input defaultValue="draft" /></VirtualDiffHunk>
    </div>);
    const hunk = view.container.querySelector('[data-diff-hunk-mounted]')!;
    const input = view.container.querySelector('input')!;
    input.value = 'edited';
    for (let i = 0; i < 20; i++) {
      activeRef.current = false;
      intersect(hunk, false);
      activeRef.current = true;
      intersect(hunk, true);
    }
    expect(view.container.querySelector('input')).toBe(input);
    expect(input.value).toBe('edited');
  });

  it('keeps a selected hunk mounted outside the window', () => {
    const view = render(<div className="termdock-diff-stream-scroller">
      <VirtualDiffHunk enabled activeRef={{ current: true }} pinned estimatedHeight={150} data-top="2000"><pre>selection</pre></VirtualDiffHunk>
    </div>);
    expect(view.getByText('selection')).toBeTruthy();
  });
});
