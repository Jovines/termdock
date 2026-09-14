// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffSplitScrollArea } from './DiffSplitScrollArea';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  let measureWidth = 900;
  let resized = () => {};
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  vi.spyOn(document, 'createRange').mockImplementation(() => ({
    selectNodeContents() {},
    getBoundingClientRect: () => ({ width: measureWidth }),
  }) as unknown as Range);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect() {}
  });
  const content = <table><tbody><tr>{[0, 1].map((side) => (
    <td key={side} className="diff-code" style={{ padding: 0 }}>Long line {side}</td>
  ))}</tr></tbody></table>;
  const component = (enabled: boolean) => (
    <DiffSplitScrollArea enabled={enabled} className="scroll-area" label="Scroll diff horizontally">{content}</DiffSplitScrollArea>
  );
  const result = render(component(true));
  return {
    ...result,
    root: result.container.firstElementChild as HTMLElement,
    cells: Array.from(result.container.querySelectorAll<HTMLElement>('.diff-code')),
    bars: Array.from(result.container.querySelectorAll<HTMLElement>('[data-diff-horizontal-scroll]')),
    resize: (width: number) => act(() => { measureWidth = width; resized(); }),
    disable: () => result.rerender(component(false)),
  };
}

describe('split diff horizontal scrolling', () => {
  it('syncs both scrollbars and short/long rows, then clamps after resize', () => {
    const view = setup();
    expect(view.bars).toHaveLength(2);
    view.bars[1].scrollLeft = 240;
    fireEvent.scroll(view.bars[1]);
    expect([...view.cells, ...view.bars].map((cell) => cell.scrollLeft)).toEqual([240, 240, 240, 240]);
    view.resize(400);
    expect([...view.cells, ...view.bars].map((cell) => cell.scrollLeft)).toEqual([100, 100, 100, 100]);
    view.disable();
    expect(view.cells.map((cell) => cell.scrollLeft)).toEqual([0, 0]);
    expect(view.container.querySelector('[data-diff-horizontal-scroll]')).toBeNull();
  });

  it('handles horizontal and shift-wheel while preserving vertical scroll and zoom', () => {
    const view = setup();
    fireEvent.wheel(view.root, { deltaX: 80 });
    fireEvent.wheel(view.root, { deltaY: 20, shiftKey: true });
    expect(view.cells[0].scrollLeft).toBe(100);
    fireEvent.wheel(view.root, { deltaY: 500 });
    fireEvent.wheel(view.root, { deltaX: 200, ctrlKey: true });
    expect(view.cells[0].scrollLeft).toBe(100);
    fireEvent.wheel(view.root, { deltaX: 9999 });
    expect(view.cells[0].scrollLeft).toBe(600);
  });
});
