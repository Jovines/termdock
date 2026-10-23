// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { TerminalGeometry } from './geometry';

vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));

function fixture(authority: 'viewport' | 'server' = 'viewport') {
  let box = { width: 1000, height: 600 };
  let proposed = { cols: 120, rows: 40 };
  const beforeLiveResize = vi.fn();
  const terminal = {
    cols: 80, rows: 24, options: { smoothScrollDuration: 80 },
    buffer: { active: { type: 'normal', baseY: 0, viewportY: 0 } },
    resize: vi.fn((cols: number, rows: number) => { terminal.cols = cols; terminal.rows = rows; }),
    scrollToBottom: vi.fn(), refresh: vi.fn(),
  };
  const geometry = new TerminalGeometry(terminal as unknown as Terminal,
    { proposeDimensions: () => proposed }, { getBoundingClientRect: () => box } as HTMLElement,
    { authority, beforeLiveResize });
  return { terminal, geometry, beforeLiveResize, box: (next: typeof box) => { box = next; }, size: (next: typeof proposed) => { proposed = next; } };
}

it('never exposes defaults or zero-sized layout as measured geometry', () => {
  const f = fixture();
  expect(f.geometry.dimensions).toBeNull();
  f.box({ width: 0, height: 0 });
  expect(f.geometry.fit('initialize', false)).toBeNull();
  expect(f.geometry.dimensions).toBeNull();
  expect(f.terminal.resize).not.toHaveBeenCalled();
});

it('measures offscreen initialization and reveal synchronously without a live redraw fence', () => {
  const f = fixture();
  f.geometry.fit('initialize', false);
  expect(f.geometry.dimensions).toEqual({ cols: 120, rows: 40 });
  f.size({ cols: 121, rows: 41 });
  f.geometry.fit('reveal', true);
  expect(f.geometry.dimensions).toEqual({ cols: 121, rows: 41 });
  expect(f.beforeLiveResize).not.toHaveBeenCalled();
  expect(f.terminal.options.smoothScrollDuration).toBe(80);
});

it('does not let a new caller accidentally keep a one-column constructor estimate', () => {
  const f = fixture();
  f.size({ cols: 81, rows: 24 });
  f.geometry.fit('update', true, 'refresh:focus');
  expect(f.geometry.dimensions).toEqual({ cols: 81, rows: 24 });
  expect(f.beforeLiveResize).not.toHaveBeenCalled();
});

it('ignores hidden layout changes and preserves live resize hysteresis and scroll position', () => {
  const f = fixture();
  f.geometry.fit('initialize', true);
  f.terminal.buffer.active.viewportY = 4;
  f.terminal.buffer.active.baseY = 10;
  f.size({ cols: 121, rows: 40 });
  expect(f.geometry.fit('update', false)).toBeNull();
  f.geometry.fit('update', true, 'refresh:focus');
  expect(f.geometry.dimensions?.cols).toBe(120);
  f.geometry.fit('update', true, 'refresh:resize');
  expect(f.geometry.dimensions?.cols).toBe(121);
  expect(f.beforeLiveResize).toHaveBeenCalledOnce();
  // Only initialization followed the bottom; a reader's scroll must survive.
  expect(f.terminal.scrollToBottom).toHaveBeenCalledOnce();
});

it('keeps a read-only viewer on the remote grid even if a caller asks to fit it locally', () => {
  const f = fixture('server');
  expect(f.geometry.fit('initialize', true)).toBeNull();
  expect(f.geometry.applyRemoteSize({ cols: 160, rows: 50 })).toBe(true);
  expect(f.terminal.cols).toBe(160);
  expect(f.geometry.fit('reveal', true)).toBeNull();
  expect(f.geometry.dimensions).toBeNull();
  expect(f.geometry.applyRemoteSize({ cols: 0, rows: 50 })).toBe(false);
  expect(fixture().geometry.applyRemoteSize({ cols: 80, rows: 24 })).toBe(false);
});
