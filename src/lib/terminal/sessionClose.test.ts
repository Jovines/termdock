import { describe, expect, it } from 'vitest';
import { shouldDestroySessionDirectly } from './sessionClose';

const shellNames = new Set(['bash', 'zsh', 'fish']);

describe('shouldDestroySessionDirectly', () => {
  it('destroys a tmux session immediately when it is at a shell prompt', () => {
    expect(shouldDestroySessionDirectly({
      mode: 'tmux',
      activeProgram: 'zsh',
      promptState: 'idle',
      shellNames,
    })).toBe(true);
  });

  it('keeps the chooser while a program is running even if polling still reports a shell', () => {
    expect(shouldDestroySessionDirectly({
      mode: 'tmux',
      activeProgram: 'bash',
      promptState: 'running',
      shellNames,
    })).toBe(false);
  });

  it('uses the detected foreground program when prompt integration is unavailable', () => {
    expect(shouldDestroySessionDirectly({
      mode: 'tmux',
      activeProgram: 'BASH',
      promptState: null,
      shellNames,
    })).toBe(true);
    expect(shouldDestroySessionDirectly({
      mode: 'tmux',
      activeProgram: 'vim',
      promptState: null,
      shellNames,
    })).toBe(false);
  });

  it('keeps the chooser when tmux state is unknown', () => {
    expect(shouldDestroySessionDirectly({
      mode: 'tmux',
      activeProgram: null,
      promptState: null,
      shellNames,
    })).toBe(false);
  });

  it('continues closing non-tmux sessions directly', () => {
    expect(shouldDestroySessionDirectly({
      mode: 'shell',
      activeProgram: 'vim',
      promptState: 'running',
      shellNames,
    })).toBe(true);
  });
});
