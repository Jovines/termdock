import { describe, expect, it } from 'vitest';
import { resolveCollaborationSpawnMode } from './collaborationSpawn.js';

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
