type TerminalMode = 'shell' | 'tmux';

/** The shared display contract. `name` remains the stored identity, never a UI label by itself. */
export interface SessionDisplaySource {
  name: string; customName?: boolean; mode?: TerminalMode; sessionId?: string | null; id?: string;
  activeProgram?: string | null; cwd?: string | null; shellTitle?: string | null;
  promptState?: 'idle' | 'running' | null; agent?: { displayName?: string; slug?: string } | null;
}
export interface SessionPresentation { displayName: string; displaySubtitle: string | null }
/** Inventory/peer payloads carry an already resolved title; legacy payloads used `name`. */
export interface SessionPresentationSnapshot {
  sessionId?: string | null; name: string; displayName?: string; displaySubtitle?: string | null;
  agent?: SessionDisplaySource['agent'];
}

export function getSessionSnapshotPresentation(session: SessionPresentationSnapshot): SessionPresentation {
  if (session.displayName?.trim()) return { displayName: session.displayName, displaySubtitle: session.displaySubtitle ?? null };
  // Do not re-project a legacy display name against cwd/program metadata. Those
  // fields are context, not a replacement for a title resolved by its owner.
  return getSessionPresentation({ name: session.name, sessionId: session.sessionId, agent: session.agent });
}

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
  session: SessionDisplaySource,
  activeProgram: string | null,
  cwd: string | null,
  shellNames: ReadonlySet<string> = DEFAULT_SESSION_DISPLAY_SHELL_NAMES,
  shellTitle: string | null = null,
  promptState: 'idle' | 'running' | null = null,
): { primary: string; secondary: string | null } {
  if (session.customName && session.name.trim()) return { primary: session.name, secondary: getCwdLeafName(cwd) };

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
  const stored = session.name.trim();
  const internal = /^(?:tmux:|remote:|wt-)/i.test(stored) || stored === session.sessionId || stored === session.id;
  return { primary: stored && !internal ? stored : session.agent?.displayName || '终端会话', secondary: null };
}

export function getSessionDisplayName(
  session: SessionDisplaySource,
  activeProgram: string | null,
  cwd: string | null,
  shellNames: ReadonlySet<string> = DEFAULT_SESSION_DISPLAY_SHELL_NAMES,
  shellTitle: string | null = null,
  promptState: 'idle' | 'running' | null = null,
): string {
  return getSessionDisplayLines(session, activeProgram, cwd, shellNames, shellTitle, promptState).primary;
}

/** Sidebar, tabs, inventories, selectors and server messages use this same projection. */
export function getSessionPresentation(session: SessionDisplaySource, shellNames: ReadonlySet<string> = DEFAULT_SESSION_DISPLAY_SHELL_NAMES): SessionPresentation {
  const { primary, secondary } = getSessionDisplayLines(session, session.activeProgram ?? null, session.cwd ?? null,
    shellNames, session.shellTitle ?? null, session.promptState ?? null);
  return { displayName: primary, displaySubtitle: secondary };
}
/** Compatibility export for callers that still consume `name` in orchestration payloads. */
export function collaborationSessionDisplayName(session: SessionDisplaySource): string {
  return getSessionPresentation(session).displayName;
}

