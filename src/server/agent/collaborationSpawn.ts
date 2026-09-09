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

/**
 * Shell command line that boots a collaboration member agent. Spawned agents
 * have no human at the keyboard, yet their delivery shells instruct them to
 * run `td collab …` — without pre-authorization every such call stops at the
 * agent's permission dialog and the collaboration loop stalls. Agents whose
 * CLI flags are known get a scoped allowlist (collab surface only; the server
 * guards every collab action anyway). Unsupported agents launch plain — the
 * delivery confirm gate can dismiss their dialogs instead.
 */
export function buildCollaborationSpawnCommand(input: { slug: string; command: string }): string {
  const { slug, command } = input;
  if (slug === 'claude') {
    return `${command} --allowedTools "Bash(td collab *)"`;
  }
  return command;
}
