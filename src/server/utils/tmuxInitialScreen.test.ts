// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TmuxInitialScreen } from './tmuxInitialScreen.js';

afterEach(() => vi.useRealTimers());

describe('tmux initial screen delivery', () => {
  it('joins initialization and a split redraw, handing only later bytes to live delivery', async () => {
    vi.useFakeTimers();
    const screen = new TmuxInitialScreen();
    expect(screen.push('\x1b[?1049h\x1b[2J')).toBe('');
    expect(screen.push('\x1b[?2026hfirst screen\x1b[?20')).toBe('');
    expect(screen.push('26llive delta')).toBe('live delta');
    await expect(screen.ready).resolves.toEqual({
      status: 'complete',
      data: '\x1b[?1049h\x1b[2J\x1b[?2026hfirst screen\x1b[?2026l',
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.push('another delta')).toBe('another delta');
  });

  it('preserves a later partial frame for the live parser instead of replaying it twice', async () => {
    const screen = new TmuxInitialScreen();
    expect(screen.push('\x1b[?2026hfirst\x1b[?2026l\x1b[?2026hsecond'))
      .toBe('\x1b[?2026hsecond');
    expect((await screen.ready).data).toBe('\x1b[?2026hfirst\x1b[?2026l');
  });

  it('releases compatibility output if no boundary arrives', async () => {
    vi.useFakeTimers();
    const screen = new TmuxInitialScreen(100);
    screen.push('plain output');
    vi.advanceTimersByTime(100);
    await expect(screen.ready).resolves.toEqual({ status: 'timeout', data: 'plain output' });
    expect(screen.push('later')).toBe('later');
  });

  it('releases an interrupted handshake and cancels its fallback timer', async () => {
    vi.useFakeTimers();
    const screen = new TmuxInitialScreen();
    screen.push('obsolete output');
    screen.cancel();
    await expect(screen.ready).resolves.toEqual({ status: 'cancelled', data: '' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds buffered UTF-8 bytes when a producer never finishes its redraw', async () => {
    const screen = new TmuxInitialScreen(1500, 8);
    screen.push('终端');
    screen.push('流');
    await expect(screen.ready).resolves.toEqual({ status: 'overflow', data: '' });
  });
});
