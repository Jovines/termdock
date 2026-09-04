export type CollaborationSpawnMode = 'shell' | 'tmux';

function asSpawnMode(value: unknown): CollaborationSpawnMode | null {
  return value === 'shell' || value === 'tmux' ? value : null;
}

export function resolveCollaborationSpawnMode(input: {
  requestedMode?: unknown;
  sourceMode?: unknown;
  fallbackMode?: unknown;
}): CollaborationSpawnMode {
  return asSpawnMode(input.requestedMode)
    ?? asSpawnMode(input.sourceMode)
    ?? asSpawnMode(input.fallbackMode)
    ?? 'shell';
}
