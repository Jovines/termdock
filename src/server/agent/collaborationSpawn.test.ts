import { describe, expect, it } from 'vitest';
import { buildCollaborationSpawnCommand, resolveCollaborationSpawnMode } from './collaborationSpawn.js';

describe('resolveCollaborationSpawnMode', () => {
  it('uses the explicitly requested user default mode first', () => {
    expect(resolveCollaborationSpawnMode({
      requestedMode: 'tmux',
      sourceMode: 'shell',
      fallbackMode: 'shell',
    })).toBe('tmux');
  });

  it('inherits the source session mode for CLI collaboration spawns', () => {
    expect(resolveCollaborationSpawnMode({ sourceMode: 'tmux', fallbackMode: 'shell' })).toBe('tmux');
  });

  it('falls back through a group member mode and then shell', () => {
    expect(resolveCollaborationSpawnMode({ requestedMode: 'invalid', fallbackMode: 'tmux' })).toBe('tmux');
    expect(resolveCollaborationSpawnMode({ requestedMode: null })).toBe('shell');
  });
});

describe('buildCollaborationSpawnCommand', () => {
  it('pre-authorizes only the td collab surface for claude members (the one CLI whose flags it documents)', () => {
    expect(buildCollaborationSpawnCommand({ slug: 'claude', command: 'claude' }))
      .toBe('claude --allowedTools "Bash(td collab *)"');
    expect(buildCollaborationSpawnCommand({ slug: 'claude', command: 'claude --resume 123 --foo bar' }))
      .toBe('claude --resume 123 --foo bar --allowedTools "Bash(td collab *)"');
  });

  it('launches every other agent plain — no injected flags for permission interfaces we do not know', () => {
    expect(buildCollaborationSpawnCommand({ slug: 'codex', command: 'codex exec' })).toBe('codex exec');
    expect(buildCollaborationSpawnCommand({ slug: 'custom-agent', command: 'my-agent --task x' })).toBe('my-agent --task x');
  });
});
