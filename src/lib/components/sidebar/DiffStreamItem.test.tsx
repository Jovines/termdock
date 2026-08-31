// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffStreamItem } from './DiffStreamItem';

vi.mock('./DiffViewer', () => ({
  DiffViewer: ({ onContentReady }: { onContentReady?: () => void }) => (
    <button type="button" data-mocked-diff-viewer onClick={onContentReady}>loaded diff</button>
  ),
}));

const baseProps = {
  file: { path: 'src/large.ts', absolutePath: '/repo/src/large.ts', status: 'modified' },
  repoRoot: '/repo',
  selectionPath: '/repo/src/large.ts',
  displayName: 'large.ts',
  selected: false,
  activePane: true,
  lightweight: false,
  wrap: true,
  showScrollHint: false,
  auditRecords: [],
  renderBadge: () => null,
};

describe('DiffStreamItem virtualization', () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  let bodyRectHeight = 200;

  beforeEach(() => {
    bodyRectHeight = 200;
    HTMLElement.prototype.getBoundingClientRect = vi.fn(function (this: HTMLElement) {
      const height = this.hasAttribute('data-diff-stream-header')
        ? 40
        : this.hasAttribute('data-diff-stream-body')
          ? bodyRectHeight
          : Number.parseFloat(this.style.height) || 240;
      return ({
      x: 0,
      y: 0,
      top: 0,
      right: 320,
      bottom: height,
      left: 0,
      width: 320,
      height,
      toJSON: () => ({}),
      });
    });
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this);
      }
      unobserve() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    globalThis.ResizeObserver = originalResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    vi.restoreAllMocks();
  });

  it('keeps the estimated slot fixed, then commits one stable height after rendering', () => {
    vi.useFakeTimers();
    const onHeightChange = vi.fn();
    const { container, rerender } = render(<DiffStreamItem {...baseProps} visible onHeightChange={onHeightChange} />);
    expect(container.querySelector('[data-mocked-diff-viewer]')).toBeTruthy();
    expect(onHeightChange).not.toHaveBeenCalled();
    expect((container.querySelector('[data-diff-stream-item]') as HTMLElement).style.height).toBe('104px');

    fireEvent.click(container.querySelector('[data-mocked-diff-viewer]') as HTMLElement);
    act(() => vi.advanceTimersByTime(DIFF_SETTLE_TIME));
    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(baseProps.selectionPath, 104, 241);
    expect(container.querySelector('[data-diff-measuring-overlay]')).toBeTruthy();

    rerender(<DiffStreamItem {...baseProps} visible estimatedHeight={241} onHeightChange={onHeightChange} />);
    expect((container.querySelector('[data-diff-stream-item]') as HTMLElement).style.height).toBe('');
    expect(container.querySelector('[data-diff-measuring-overlay]')).toBeNull();

    rerender(<DiffStreamItem {...baseProps} visible={false} estimatedHeight={241} onHeightChange={onHeightChange} />);

    expect(container.querySelector('[data-mocked-diff-viewer]')).toBeNull();
    expect((container.querySelector('[data-diff-stream-body]') as HTMLElement).style.height).toBe('200px');
  });

  it('uses a compact stable placeholder before a diff is first loaded', () => {
    const { container } = render(<DiffStreamItem {...baseProps} visible={false} />);
    expect(container.querySelector('[data-mocked-diff-viewer]')).toBeNull();
    expect((container.querySelector('[data-diff-stream-body]') as HTMLElement).style.height).toBe('64px');
  });

  it('reveals reusable content immediately without repeating the measurement cover', () => {
    vi.useFakeTimers();
    const onContentReady = vi.fn();
    const onHeightChange = vi.fn();
    const { container } = render(
      <DiffStreamItem
        {...baseProps}
        visible
        reusableContent
        estimatedHeight={241}
        onContentReady={onContentReady}
        onHeightChange={onHeightChange}
      />,
    );

    fireEvent.click(container.querySelector('[data-mocked-diff-viewer]') as HTMLElement);

    expect(onContentReady).toHaveBeenCalledWith(baseProps.selectionPath);
    expect(onHeightChange).not.toHaveBeenCalled();
    expect(container.querySelector('[data-diff-measuring-overlay]')).toBeNull();
    expect((container.querySelector('[data-diff-stream-item]') as HTMLElement).style.height).toBe('');
  });

  it('starts a new fixed-height measurement when supplied diff content changes', () => {
    vi.useFakeTimers();
    const onHeightChange = vi.fn();
    const { container, rerender } = render(
      <DiffStreamItem {...baseProps} visible diffOverride="stub" onHeightChange={onHeightChange} />,
    );

    fireEvent.click(container.querySelector('[data-mocked-diff-viewer]') as HTMLElement);
    act(() => vi.advanceTimersByTime(DIFF_SETTLE_TIME));
    rerender(
      <DiffStreamItem {...baseProps} visible estimatedHeight={241} diffOverride="stub" onHeightChange={onHeightChange} />,
    );

    bodyRectHeight = 600;
    rerender(
      <DiffStreamItem {...baseProps} visible estimatedHeight={241} diffOverride="full" onHeightChange={onHeightChange} />,
    );
    expect((container.querySelector('[data-diff-stream-item]') as HTMLElement).style.height).toBe('241px');
    expect(onHeightChange).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector('[data-mocked-diff-viewer]') as HTMLElement);
    act(() => vi.advanceTimersByTime(DIFF_SETTLE_TIME));
    expect(onHeightChange).toHaveBeenCalledTimes(2);
    expect(onHeightChange).toHaveBeenLastCalledWith(baseProps.selectionPath, 241, 641);
  });

  it('releases the neighbour loading queue shortly after the rendered body is ready', () => {
    vi.useFakeTimers();
    const onContentReady = vi.fn();
    const { container } = render(<DiffStreamItem {...baseProps} visible onContentReady={onContentReady} />);

    fireEvent.click(container.querySelector('[data-mocked-diff-viewer]') as HTMLElement);
    act(() => vi.advanceTimersByTime(DIFF_SETTLE_TIME - 1));
    expect(onContentReady).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onContentReady).toHaveBeenCalledWith(baseProps.selectionPath);
  });
});

const DIFF_SETTLE_TIME = 96;
