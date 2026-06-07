import type { TerminalMode } from './types';

export const DEFAULT_SESSION_DISPLAY_SHELL_NAMES = new Set([
  'bash',
  'zsh',
  'fish',
  'sh',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
]);

export function getCwdLeafName(cwd: string | null): string | null {
  if (!cwd) return null;
  if (cwd === '/') return '/';
  const segments = cwd.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || cwd;
}

export function getSessionDisplayLines(
  session: { name: string; customName?: boolean; mode?: TerminalMode },
  activeProgram: string | null,
  cwd: string | null,
  shellNames: ReadonlySet<string> = DEFAULT_SESSION_DISPLAY_SHELL_NAMES,
): { primary: string; secondary: string | null } {
  if (session.customName) return { primary: session.name, secondary: getCwdLeafName(cwd) };

  if (activeProgram && !shellNames.has(activeProgram)) {
    return { primary: activeProgram, secondary: getCwdLeafName(cwd) };
  }

  const dir = getCwdLeafName(cwd);
  if (dir) return { primary: dir, secondary: null };
  return { primary: session.name, secondary: null };
}

export function getSessionDisplayName(
  session: { name: string; customName?: boolean; mode?: TerminalMode },
  activeProgram: string | null,
  cwd: string | null,
  shellNames: ReadonlySet<string> = DEFAULT_SESSION_DISPLAY_SHELL_NAMES,
): string {
  return getSessionDisplayLines(session, activeProgram, cwd, shellNames).primary;
}
