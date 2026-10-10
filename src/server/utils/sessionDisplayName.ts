type TerminalMode = 'shell' | 'tmux';

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
  shellTitle: string | null = null,
  promptState: 'idle' | 'running' | null = null,
): { primary: string; secondary: string | null } {
  if (session.customName) return { primary: session.name, secondary: getCwdLeafName(cwd) };

  // Shell integration (OSC 2) provides real-time title: command name when running,
  // cwd when idle. This is faster and more accurate than server-side process polling.
  if (shellTitle) {
    const cwdLeaf = getCwdLeafName(cwd);
    const titleLooksLikeCwd = shellTitle === cwd || shellTitle === cwdLeaf;
    // If the shell reports a running state, the title is the command name.
    if (promptState !== 'idle' && !shellNames.has(shellTitle) && !titleLooksLikeCwd) {
      return { primary: shellTitle, secondary: cwdLeaf };
    }
    // If idle, the title is typically the cwd — fall through to show cwd leaf.
  }

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
  shellTitle: string | null = null,
  promptState: 'idle' | 'running' | null = null,
): string {
  return getSessionDisplayLines(session, activeProgram, cwd, shellNames, shellTitle, promptState).primary;
}

/** Resolve the same title hints the session sidebar uses, without exposing route IDs. */
export function collaborationSessionDisplayName(session: { name: string; sessionId?: string; customName?: boolean; activeProgram?: string | null; shellTitle?: string | null; cwd?: string | null; agent?: { displayName: string } | null }): string {
  const cwdLeaf = getCwdLeafName(session.cwd ?? null);
  const title = session.shellTitle === session.cwd || session.shellTitle === cwdLeaf ? null : session.shellTitle ?? null;
  const name = getSessionDisplayName(session, session.activeProgram ?? null, null, DEFAULT_SESSION_DISPLAY_SHELL_NAMES, title);
  return !name.trim() || /^(?:tmux:|remote:|wt-)/i.test(name) || name === session.sessionId
    ? session.agent?.displayName || cwdLeaf || '终端会话'
    : name;
}

