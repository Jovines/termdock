import { expect, it, vi } from 'vitest';
import { readCollectionOutputTime } from './tmuxOutput.js';
it('counts output in hidden windows using immutable tmux targets, not display redraws', async () => {
  const run = vi.fn(async () => '@1\t1700000000\n@2\t1700000012\n');
  expect(await readCollectionOutputTime(run, '$3', ['@1', '@2'])).toBe(1700000013000);
  expect(run).toHaveBeenCalledWith(['list-windows', '-t', '$3', '-F', '#{window_id}\t#{window_activity}']);
});
it.each(['', '@1\t\n', '@1\t0\n', '@1\tNaN\n', '@2\t1700000000\n', '@1\t1700000000\n@1\t1700000000\n', '@1\t1700000000\n@2\t1700000000\n'])('refuses unobserved or changed window sets: %j', async text => {
  await expect(readCollectionOutputTime(async () => text, '$3', ['@1'])).rejects.toThrow('无法确认');
});
