import type { TerminalMode } from './types';

interface CloseConfirmationDecision {
  mode: TerminalMode;
  activeProgram: string | null;
  promptState: 'idle' | 'running' | null;
  shellNames: ReadonlySet<string>;
}

/**
 * Empty tmux shells are cheap to close directly. Running programs and unknown
 * states stay behind destructive confirmation so a stale poll cannot kill work.
 */
export function requiresSessionCloseConfirmation({
  mode,
  activeProgram,
  promptState,
  shellNames,
}: CloseConfirmationDecision): boolean {
  if (mode !== 'tmux') return false;
  if (promptState === 'running') return true;
  if (promptState === 'idle') return false;
  return activeProgram === null || !shellNames.has(activeProgram.toLowerCase());
}
