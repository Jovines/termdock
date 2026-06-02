import {
  X as RiCloseLine,
  Plus as RiAddLine,
  Settings as RiSettings4Line,
  Terminal as RiTerminalLine,
  LayoutGrid as RiLayoutGridLine,
  Search as RiSearchLine,
  LoaderCircle as RiLoaderCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from './Sidebar';
import type { AgentStatus } from '../../terminal/types';

interface LeftSidebarProps {
  isOpen: boolean;
  drawerWidthPx: number;
  onClose: () => void;
  onOpen?: () => void;
  sessions: Array<{
    id: string;
    name: string;
    mode: 'shell' | 'tmux';
    customName?: boolean;
  }>;
  activeSessionId: string | null;
  sessionStates: Map<string, {
    cwd: string | null;
    activeProgram: string | null;
    inCopyMode?: boolean;
    isConnecting?: boolean;
    agentStatus: AgentStatus | null;
    agentNeedsReview?: boolean;
  }>;
  onNewSession: (opts?: { mode?: 'shell' | 'tmux'; tmuxSessionName?: string }) => void;
  onCloseSession: (sessionId: string) => void;
  onOpenSettings: () => void;
  tmuxAvailable?: boolean;
  push?: boolean;
}

const SHELL_NAMES = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu']);

function getCwdLeafName(cwd: string | null): string | null {
  if (!cwd) return null;
  if (cwd === '/') return '/';
  const segments = cwd.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || cwd;
}

function getDisplayName(
  session: { name: string; customName?: boolean },
  activeProgram: string | null,
  cwd: string | null,
): string {
  if (session.customName) return session.name;
  if (activeProgram && !SHELL_NAMES.has(activeProgram)) return activeProgram;
  return getCwdLeafName(cwd) ?? session.name;
}

function matchesSession(
  query: string,
  session: LeftSidebarProps['sessions'][number],
  state?: LeftSidebarProps['sessionStates'] extends Map<string, infer T> ? T : never,
): boolean {
  if (!query) return true;
  const haystack = [
    session.name,
    session.mode,
    state?.cwd,
    state?.activeProgram,
    getCwdLeafName(state?.cwd ?? null),
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function StatusDot({
  status,
  needsReview,
  inCopyMode,
}: { status: AgentStatus | null; needsReview?: boolean; inCopyMode?: boolean }) {
  if (status === 'running') {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-green-400 ring-2 ring-surface animate-pulse"
        title="AI running"
      />
    );
  }
  if (status === 'waiting' || needsReview) {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-yellow-400 ring-2 ring-surface"
        title={needsReview ? 'AI finished — needs review' : 'AI waiting'}
      />
    );
  }
  if (inCopyMode) {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-yellow-400/80 ring-2 ring-surface"
        title="Copy mode"
      />
    );
  }
  return null;
}

export function LeftSidebar(
  {
    isOpen, drawerWidthPx, onClose, onOpen,
    sessions, activeSessionId, sessionStates,
    onNewSession, onCloseSession, onOpenSettings,
    tmuxAvailable = true,
    push,
  }: LeftSidebarProps,
) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  const visibleSessions = useMemo(() => (
    sessions.filter((session) => matchesSession(query.trim(), session, sessionStates.get(session.id)))
  ), [query, sessions, sessionStates]);

  const { runningCount, reviewCount } = useMemo(() => {
    let running = 0;
    let review = 0;
    for (const s of sessions) {
      const ts = sessionStates.get(s.id);
      if (ts?.agentStatus === 'running') running += 1;
      if (ts?.agentNeedsReview) review += 1;
    }
    return { runningCount: running, reviewCount: review };
  }, [sessions, sessionStates]);

  useEffect(() => {
    if (!isOpen) return;
    activeItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeSessionId, isOpen, visibleSessions.length]);

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setSearchOpen(false);
    }
  }, [isOpen]);

  const closeIfOverlay = () => {
    if (!push) onClose();
  };

  return (
    <Sidebar
      side="left"
      isOpen={isOpen}
      drawerWidthPx={drawerWidthPx}
      onClose={onClose}
      onOpen={onOpen}
      push={push}
    >
      {/* Header — single compact row */}
      <div className="shrink-0 border-b border-border/15 px-2 py-2">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1 px-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[13px] font-semibold text-foreground">Sessions</span>
              <span className="text-[11px] text-muted-foreground">{sessions.length}</span>
              {(runningCount > 0 || reviewCount > 0) && (
                <span className="ml-1 flex items-center gap-1.5">
                  {runningCount > 0 && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-green-400/10 px-1.5 py-0.5 text-[10px] font-medium text-green-400"
                      title={`${runningCount} running`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                      {runningCount}
                    </span>
                  )}
                  {reviewCount > 0 && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-yellow-400/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400"
                      title={`${reviewCount} need review`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
                      {reviewCount}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setSearchOpen((prev) => !prev);
              if (!searchOpen) setTimeout(() => {
                document.querySelector<HTMLInputElement>('input[data-left-search]')?.focus();
              }, 50);
            }}
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition active:scale-95 ${
              searchOpen
                ? 'bg-primary/15 text-primary'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            aria-label="Toggle search"
            title="Search"
          >
            <RiSearchLine size={14} />
          </button>
          <button
            type="button"
            onClick={() => { onOpenSettings(); closeIfOverlay(); }}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
            aria-label="Settings"
            title="Settings"
          >
            <RiSettings4Line size={14} />
          </button>
          {!push && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive active:scale-95"
              aria-label="Close"
            >
              <RiCloseLine size={14} />
            </button>
          )}
        </div>

        {searchOpen && (
          <div className="mt-2 flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-muted-foreground focus-within:bg-surface-elevated">
            <RiSearchLine size={12} className="shrink-0" />
            <input
              data-left-search
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter sessions"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              enterKeyHint="search"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
                aria-label="Clear search"
              >
                <RiCloseLine size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5">
        {sessions.length === 0 ? (
          <div className="rounded-xl bg-surface-2/60 px-4 py-8 text-center">
            <RiTerminalLine size={26} className="mx-auto mb-2 text-muted-foreground" />
            <p className="text-[12px] text-muted-foreground">No open sessions yet.</p>
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="rounded-xl bg-surface-2/60 px-4 py-6 text-center">
            <p className="text-[12px] text-muted-foreground">No matching sessions.</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {visibleSessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const ts = sessionStates.get(session.id);
              const cwdLeaf = getCwdLeafName(ts?.cwd ?? null);
              const displayName = getDisplayName(session, ts?.activeProgram ?? null, ts?.cwd ?? null);
              const cwdSecondary = cwdLeaf && cwdLeaf !== displayName ? cwdLeaf : null;
              const accentClass = ts?.agentStatus === 'running'
                ? 'bg-green-400'
                : (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview)
                  ? 'bg-yellow-400'
                  : ts?.inCopyMode
                    ? 'bg-yellow-400/70'
                    : 'bg-primary';

              return (
                <div
                  key={session.id}
                  className={`group relative flex items-center gap-1 rounded-lg pr-1 transition ${
                    isActive
                      ? 'bg-surface-elevated text-foreground'
                      : 'text-muted-foreground hover:bg-surface-2'
                  }`}
                >
                  <button
                    ref={isActive ? activeItemRef : null}
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: session.id }));
                      closeIfOverlay();
                    }}
                    className="relative min-w-0 flex flex-1 items-center gap-2 overflow-hidden py-1.5 pl-2 pr-1 text-left"
                    title={ts?.cwd ?? session.name}
                  >
                    {isActive && (
                      <span className={`absolute inset-y-2 left-0 w-0.5 rounded-full ${accentClass}`} />
                    )}
                    <span className={`relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                      isActive
                        ? session.mode === 'tmux'
                          ? 'bg-purple-400/15 text-purple-300'
                          : 'bg-primary/15 text-primary'
                        : session.mode === 'tmux'
                          ? 'bg-surface text-purple-300/80'
                          : 'bg-surface text-muted-foreground'
                    }`}>
                      {ts?.isConnecting ? (
                        <RiLoaderCircle size={12} className="animate-spin" />
                      ) : session.mode === 'tmux' ? (
                        <RiLayoutGridLine size={12} />
                      ) : (
                        <RiTerminalLine size={12} />
                      )}
                      <StatusDot
                        status={ts?.agentStatus ?? null}
                        needsReview={ts?.agentNeedsReview}
                        inCopyMode={ts?.inCopyMode}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[13px] leading-tight ${
                        isActive ? 'font-medium text-foreground' : ''
                      } ${ts?.inCopyMode ? 'text-yellow-400' : ''}`}>
                        {displayName}
                      </span>
                      {cwdSecondary && (
                        <span className="block truncate text-[10.5px] leading-tight text-muted-foreground/75">
                          {cwdSecondary}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseSession(session.id);
                    }}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition hover:bg-destructive/15 hover:text-destructive active:scale-95"
                    aria-label={`Close ${displayName}`}
                    title="Close"
                  >
                    <RiCloseLine size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer — split new-session button */}
      <div className="shrink-0 border-t border-border/15 p-2">
        <div className="flex items-stretch gap-1.5">
          <button
            type="button"
            onClick={() => { onNewSession({ mode: 'shell' }); closeIfOverlay(); }}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary/15 px-3 py-2 text-[13px] font-medium text-primary transition hover:bg-primary/25 active:scale-[0.98]"
          >
            <RiAddLine size={14} />
            <RiTerminalLine size={12} />
            <span>Shell</span>
          </button>
          <button
            type="button"
            disabled={!tmuxAvailable}
            onClick={() => { onNewSession({ mode: 'tmux' }); closeIfOverlay(); }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition active:scale-[0.98] ${
              tmuxAvailable
                ? 'bg-surface-2 text-foreground hover:bg-surface-elevated'
                : 'bg-surface-2/50 text-muted-foreground/50 cursor-not-allowed'
            }`}
            title={tmuxAvailable ? 'New tmux session' : 'tmux not available on server'}
          >
            <RiAddLine size={14} />
            <RiLayoutGridLine size={12} />
            <span>Tmux</span>
          </button>
        </div>
      </div>
    </Sidebar>
  );
}
