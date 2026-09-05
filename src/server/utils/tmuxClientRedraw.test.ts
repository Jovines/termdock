// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { redrawTmuxClient } from './tmuxClientRedraw.js';

describe('ordered tmux redraw', () => {
  it('redraws the exact PTY client instead of capturing and replacing its cells', async () => {
    const run = vi.fn().mockResolvedValueOnce('12 /dev/pts/1\n123 /dev/pts/8\n').mockResolvedValue('');
    await redrawTmuxClient(run, 'existing-session', 123);
    expect(run.mock.calls).toEqual([
      [['list-clients', '-t', 'existing-session', '-F', '#{client_pid} #{client_tty}']],
      [['refresh-client', '-t', '/dev/pts/8']],
    ]);
  });

  it('does not touch another client when the requested PTY has detached', async () => {
    const run = vi.fn().mockResolvedValue('12 /dev/pts/1\n');
    await redrawTmuxClient(run, 'existing-session', 123);
    expect(run).toHaveBeenCalledTimes(1);
    await redrawTmuxClient(run, 'existing-session', undefined);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
