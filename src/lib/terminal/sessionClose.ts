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

export interface SessionCloseBinding {
  id: string;
  target: unknown;
  client: unknown;
  backend: string | null;
  mode: string;
  tmux: string | null;
}
/** A chooser belongs to the binding at open, not a later reuse of its frontend ID. */
export function sameSessionCloseBinding(expected: SessionCloseBinding | null, current: SessionCloseBinding | null): boolean {
  return !!expected && !!current && expected.id === current.id && expected.target === current.target
    && expected.client === current.client && expected.backend === current.backend
    && expected.mode === current.mode && expected.tmux === current.tmux;
}
