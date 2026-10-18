import { describe, expect, it } from 'vitest';
import { requiresSessionCloseConfirmation, sameSessionCloseBinding } from './sessionClose';

describe('requiresSessionCloseConfirmation', () => {
  const shellNames = new Set(['bash', 'zsh', 'fish']);

  it('closes an idle tmux shell without confirmation', () => {
    expect(requiresSessionCloseConfirmation({
      mode: 'tmux',
      activeProgram: 'zsh',
      promptState: 'idle',
      shellNames,
    })).toBe(false);
  });

  it('confirms while a program is running', () => {
    expect(requiresSessionCloseConfirmation({
      mode: 'tmux',
      activeProgram: 'codex',
      promptState: 'running',
      shellNames,
    })).toBe(true);
  });

  it('uses the foreground process when prompt integration is unavailable', () => {
    expect(requiresSessionCloseConfirmation({
      mode: 'tmux',
      activeProgram: 'BASH',
      promptState: null,
      shellNames,
    })).toBe(false);
    expect(requiresSessionCloseConfirmation({
      mode: 'tmux',
      activeProgram: 'vim',
      promptState: null,
      shellNames,
    })).toBe(true);
  });

  it('confirms unknown tmux state and keeps plain shell close immediate', () => {
    expect(requiresSessionCloseConfirmation({
      mode: 'tmux',
      activeProgram: null,
      promptState: null,
      shellNames,
    })).toBe(true);
    expect(requiresSessionCloseConfirmation({
      mode: 'shell',
      activeProgram: 'vim',
      promptState: 'running',
      shellNames,
    })).toBe(false);
  });
});

describe('close chooser binding identity', () => {
  it('keeps the original target across active-tab changes and rejects rebuild, service, mode or tmux changes', () => {
    const target={},client={},opened={id:'one',target,client,backend:'backend-one',mode:'tmux',tmux:'owned-one'};
    expect(sameSessionCloseBinding(opened,{...opened})).toBe(true);
    for(const change of [{id:'two'},{backend:'rebuilt'},{backend:null},{target:{}},{client:{}},{mode:'shell'},{tmux:'replacement'}])expect(sameSessionCloseBinding(opened,{...opened,...change})).toBe(false);
    expect(sameSessionCloseBinding(opened,null)).toBe(false);
    expect(sameSessionCloseBinding(null,opened)).toBe(false);
  });
});
