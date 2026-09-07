import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

import { buildTmuxAttachArgs, supportsTmuxClientFeatures } from './tmuxClientCapabilities.js';

describe('tmux client capability compatibility', () => {
  beforeEach(() => { execFile.mockReset(); });

  it('keeps truecolor and synchronized output for clients accepting -T', async () => {
    execFile.mockImplementation((_binary, _args, _options, callback) => callback(null, 'tmux 3.2'));
    const supported = await supportsTmuxClientFeatures('/opt/bin/tmux');
    expect(supported).toBe(true);
    expect(execFile).toHaveBeenCalledWith('/opt/bin/tmux', ['-T', 'RGB,sync', '-V'], { timeout: 5000 }, expect.any(Function));
    expect(buildTmuxAttachArgs('work session', supported)).toEqual([
      '-T', 'RGB,sync', 'attach-session', '-t', 'work session',
    ]);
  });

  it.each(['invalid option -- T', 'ENOENT', 'Command timed out'])(
    'falls back to a basic attach when probing fails: %s', async (message) => {
      execFile.mockImplementation((_binary, _args, _options, callback) => callback(new Error(message)));
      const supported = await supportsTmuxClientFeatures('tmux');
      expect(supported).toBe(false);
      expect(buildTmuxAttachArgs('legacy', supported)).toEqual(['attach-session', '-t', 'legacy']);
    },
  );

  it('rechecks capabilities after a binary upgrade', async () => {
    execFile.mockImplementationOnce((_binary, _args, _options, callback) => callback(new Error('invalid option -- T')))
      .mockImplementationOnce((_binary, _args, _options, callback) => callback(null, 'tmux 3.5a'));
    expect(await supportsTmuxClientFeatures('tmux')).toBe(false);
    expect(await supportsTmuxClientFeatures('tmux')).toBe(true);
  });
});
