import { describe, expect, it } from 'vitest';
import {
  buildInteractiveColorEnvironment,
  buildTmuxColorEnvironmentCommands,
  ensureTmuxColorCapabilities,
  TERMDOCK_TRUECOLOR_FEATURE_SLOT,
  TERMDOCK_TRUECOLOR_OVERRIDE_SLOT,
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

  it('declares xterm.js RGB support and the managed session TERM', async () => {
    const commands: string[][] = [];
    await ensureTmuxColorCapabilities(async (args) => {
      commands.push(args);
    }, 'wt-test', 'tmux-256color');

    expect(commands).toEqual([
      ['set-option', '-s', TERMDOCK_TRUECOLOR_FEATURE_SLOT, 'xterm-256color:RGB'],
      ['set-option', '-t', 'wt-test', 'default-terminal', 'tmux-256color'],
      ['set-environment', '-t', 'wt-test', 'TERM', 'tmux-256color'],
    ]);
  });

  it('falls back to the legacy Tc override when terminal-features is unsupported', async () => {
    const commands: string[][] = [];
    await ensureTmuxColorCapabilities(async (args) => {
      commands.push(args);
      if (args.includes(TERMDOCK_TRUECOLOR_FEATURE_SLOT)) {
        throw new Error('unknown option: terminal-features');
      }
    });

    expect(commands).toEqual([
      ['set-option', '-s', TERMDOCK_TRUECOLOR_FEATURE_SLOT, 'xterm-256color:RGB'],
      ['set-option', '-s', TERMDOCK_TRUECOLOR_OVERRIDE_SLOT, 'xterm-256color:Tc'],
    ]);
  });
});
