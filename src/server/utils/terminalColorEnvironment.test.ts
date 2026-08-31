import { describe, expect, it } from 'vitest';
import {
  buildInteractiveColorEnvironment,
  buildTmuxColorEnvironmentCommands,
} from './terminalColorEnvironment.js';

describe('interactive terminal color environment', () => {
  it('removes inherited color suppression without mutating the source', () => {
    const source = { PATH: '/bin', NO_COLOR: '1', FORCE_COLOR: '0' };
    const result = buildInteractiveColorEnvironment(source);

    expect(result).toMatchObject({ PATH: '/bin', COLORTERM: 'truecolor' });
    expect(result).not.toHaveProperty('NO_COLOR');
    expect(result).not.toHaveProperty('FORCE_COLOR');
    expect(source).toEqual({ PATH: '/bin', NO_COLOR: '1', FORCE_COLOR: '0' });
  });

  it('uses explicit Termdock force-color mode when requested', () => {
    expect(buildInteractiveColorEnvironment({ NO_COLOR: '1', TERMDOCK_FORCE_COLOR: '1' }))
      .toMatchObject({ COLORTERM: 'truecolor', FORCE_COLOR: '1' });
  });

  it('always clears NO_COLOR from global and per-session tmux environments', () => {
    const commands = buildTmuxColorEnvironmentCommands('wt-test');
    expect(commands).toContainEqual(['set-environment', '-g', '-u', 'NO_COLOR']);
    expect(commands).toContainEqual(['set-environment', '-t', 'wt-test', '-u', 'NO_COLOR']);
  });
});
