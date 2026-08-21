import type { TerminalMode } from './types';

interface DirectDestroyDecision {
  mode: TerminalMode;
  activeProgram: string | null;
  promptState: 'idle' | 'running' | null;
  shellNames: ReadonlySet<string>;
}

/**
 * An explicit prompt state wins over the slower foreground-process poll.
 * Without shell integration, only a positively identified shell is safe to
 * destroy without asking; unknown state keeps the existing chooser.
 */
export function shouldDestroySessionDirectly({
  mode,
  activeProgram,
  promptState,
  shellNames,
}: DirectDestroyDecision): boolean {
  if (mode !== 'tmux') return true;
  if (promptState === 'running') return false;
  if (promptState === 'idle') return true;
  return activeProgram !== null && shellNames.has(activeProgram.toLowerCase());
}
