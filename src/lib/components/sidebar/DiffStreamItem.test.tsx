// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffStreamItem } from './DiffStreamItem';

vi.mock('./DiffViewer', () => ({
  DiffViewer: () => <div data-mocked-diff-viewer>loaded diff</div>,
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

  beforeEach(() => {
    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      right: 320,
      bottom: 240,
      left: 0,
      width: 320,
      height: 240,
      toJSON: () => ({}),
    }));
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
    globalThis.ResizeObserver = originalResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    vi.restoreAllMocks();
  });

  it('mounts near-viewport diff content and preserves its measured height after recycling', () => {
    const onHeightChange = vi.fn();
    const { container, rerender } = render(<DiffStreamItem {...baseProps} visible onHeightChange={onHeightChange} />);
    expect(container.querySelector('[data-mocked-diff-viewer]')).toBeTruthy();
    expect(onHeightChange).toHaveBeenCalledWith(baseProps.selectionPath, 64, 240);

    rerender(<DiffStreamItem {...baseProps} visible={false} onHeightChange={onHeightChange} />);

    expect(container.querySelector('[data-mocked-diff-viewer]')).toBeNull();
    expect((container.querySelector('[data-diff-stream-body]') as HTMLElement).style.height).toBe('240px');
  });

  it('uses a compact stable placeholder before a diff is first loaded', () => {
    const { container } = render(<DiffStreamItem {...baseProps} visible={false} />);
    expect(container.querySelector('[data-mocked-diff-viewer]')).toBeNull();
    expect((container.querySelector('[data-diff-stream-body]') as HTMLElement).style.height).toBe('64px');
  });
});
