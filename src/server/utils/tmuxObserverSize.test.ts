// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { readTmuxObserverSize, retainTmuxObserverSize } from './tmuxObserverSize.js';

it('retains the selected grid without changing observer flags or resending equal sizes', () => {
  const resize = vi.fn();
  const session = { cols: 80, rows: 24, ptyProcess: { resize } };
  retainTmuxObserverSize(session, 134, 43);
  expect(resize).toHaveBeenCalledExactlyOnceWith(134, 43);
  expect(session).toMatchObject({ cols: 134, rows: 43 });
  retainTmuxObserverSize(session, 134, 43);
  expect(resize).toHaveBeenCalledOnce();
});

it.each([['off', 43], ['on', 44], ['2', 45]])('preserves window and status rows when status is %s', async (status, rows) => {
  const run = vi.fn(async () => `134 43 ${status}\n`);
  expect(await readTmuxObserverSize(run, '=work')).toEqual({ cols: 134, rows });
  expect(run.mock.calls[0]).toEqual([['display-message', '-p', '-t', '=work:', '#{window_width} #{window_height} #{status}']]);
});

it.each(['', ' on', '0 43 off', '134 NaN off', '134 43 6'])(
  'refuses guessed geometry if the existing window cannot be measured: %s', async raw => {
    await expect(readTmuxObserverSize(async () => raw, '%12')).rejects.toThrow('TMUX_WINDOW_GEOMETRY_UNAVAILABLE');
  },
);
