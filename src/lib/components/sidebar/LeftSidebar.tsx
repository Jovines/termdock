import {
  X as RiCloseLine,
  Plus as RiAddLine,
  Settings as RiSettings4Line,
  Terminal as RiTerminalLine,
  LayoutGrid as RiLayoutGridLine,
  Folder as RiFolderLine,
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
  onNewSession: () => void;
  onOpenDrawer: () => void;
  push?: boolean;
}

const SHELL_NAMES = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu']);

function AgentStatusBadge({ status, needsReview }: { status: AgentStatus | null; needsReview?: boolean }) {
  if (!status && !needsReview) return null;
  if (status === 'running') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-green-400/10 px-1.5 py-0.5 text-[10px] font-medium text-green-400"
        title="AI running"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
        AI
      </span>
    );
  }
  const title = needsReview ? 'AI finished — needs review' : 'AI waiting';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-yellow-400/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400"
      title={title}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
      Review
    </span>
  );
}

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

function matchesSession(query: string, session: LeftSidebarProps['sessions'][number], state?: LeftSidebarProps['sessionStates'] extends Map<string, infer T> ? T : never): boolean {
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

export function LeftSidebar(
  { isOpen, drawerWidthPx, onClose, onOpen, sessions, activeSessionId, sessionStates, onNewSession, onOpenDrawer, push }: LeftSidebarProps,
) {
  const [query, setQuery] = useState('');
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  const visibleSessions = useMemo(() => (
    sessions.filter((session) => matchesSession(query.trim(), session, sessionStates.get(session.id)))
  ), [query, sessions, sessionStates]);

  const runningCount = sessions.filter((session) => sessionStates.get(session.id)?.agentStatus === 'running').length;
  const reviewCount = sessions.filter((session) => sessionStates.get(session.id)?.agentNeedsReview).length;
  const activeIndex = activeSessionId ? sessions.findIndex((session) => session.id === activeSessionId) : -1;

  useEffect(() => {
    if (!isOpen) return;
    activeItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeSessionId, isOpen, visibleSessions.length]);

  useEffect(() => {
    if (!isOpen) setQuery('');
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
      {/* Header */}
      <div className="shrink-0 border-b border-border/15 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="ui-kicker">Sessions</div>
            <h2 className="section-title mt-0.5">
              {sessions.length} open
              {activeIndex >= 0 && (
                <span className="ml-2 align-middle text-xs font-medium text-muted-foreground">
                  {activeIndex + 1}/{sessions.length}
                </span>
              )}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {!push && (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive active:scale-95"
                aria-label="Close"
              >
                <RiCloseLine size={18} />
              </button>
            )}
          </div>
        </div>

        {!push && (
          <div className="mt-2 text-[11px] leading-none text-muted-foreground/70">
            Tap a session to switch · swipe left or tap outside to close
          </div>
        )}

        <div className="mt-3 flex items-center gap-2 rounded-full bg-surface-2 px-3 py-2 text-muted-foreground focus-within:bg-surface-elevated">
          <RiSearchLine size={14} className="shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground"
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
              <RiCloseLine size={13} />
            </button>
          )}
        </div>

        {(runningCount > 0 || reviewCount > 0) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {runningCount > 0 && (
              <span className="rounded-full bg-green-400/10 px-2 py-0.5 text-[10px] font-medium text-green-400">
                {runningCount} running
              </span>
            )}
            {reviewCount > 0 && (
              <span className="rounded-full bg-yellow-400/10 px-2 py-0.5 text-[10px] font-medium text-yellow-400">
                {reviewCount} needs review
              </span>
            )}
          </div>
        )}
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {sessions.length === 0 ? (
          <div className="rounded-2xl bg-surface-2/60 px-4 py-8 text-center">
            <RiTerminalLine size={28} className="mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No open sessions yet.</p>
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="rounded-2xl bg-surface-2/60 px-4 py-8 text-center">
            <RiSearchLine size={26} className="mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No matching sessions.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {visibleSessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const ts = sessionStates.get(session.id);
              const cwdLeaf = getCwdLeafName(ts?.cwd ?? null);
              const displayName = getDisplayName(session, ts?.activeProgram ?? null, ts?.cwd ?? null);
              const subline = [
                session.mode,
                session.mode === 'tmux' && session.name !== displayName ? session.name : null,
                ts?.activeProgram && !SHELL_NAMES.has(ts.activeProgram) ? cwdLeaf : null,
              ].filter(Boolean).join(' · ');

              return (
                <button
                  key={session.id}
                  ref={isActive ? activeItemRef : null}
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: session.id }));
                    closeIfOverlay();
                  }}
                  className={`group relative w-full overflow-hidden rounded-2xl px-3 py-3 text-left transition active:scale-[0.99] ${
                    isActive
                      ? 'bg-surface-elevated text-foreground ring-1 ring-primary/25'
                      : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                  }`}
                  title={ts?.cwd ?? session.name}
                >
                  {isActive && <span className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-primary" />}
                  <span className="flex min-w-0 items-center gap-3">
                    <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                      isActive ? 'bg-primary/20 text-primary' : 'bg-surface text-muted-foreground group-hover:bg-surface-elevated'
                    }`}>
                      {ts?.isConnecting ? (
                        <RiLoaderCircle size={16} className="animate-spin" />
                      ) : session.mode === 'tmux' ? (
                        <RiLayoutGridLine size={16} />
                      ) : (
                        <RiTerminalLine size={16} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`truncate text-sm font-medium ${ts?.inCopyMode ? 'text-yellow-400' : ''}`}>
                          {displayName}
                        </span>
                        <AgentStatusBadge status={ts?.agentStatus ?? null} needsReview={ts?.agentNeedsReview} />
                      </span>
                      <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/80">
                        <span className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 uppercase tracking-[0.12em]">
                          {session.mode}
                        </span>
                        {cwdLeaf && (
                          <>
                            <RiFolderLine size={11} className="shrink-0" />
                            <span className="truncate">{cwdLeaf}</span>
                          </>
                        )}
                        {subline && !cwdLeaf && <span className="truncate">{subline}</span>}
                      </span>
                    </span>
                  </span>
                  {ts?.inCopyMode && (
                    <span className="absolute right-3 top-3 rounded-full bg-yellow-400/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-yellow-400">
                      copy
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="shrink-0 border-t border-border/15 p-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => { onNewSession(); closeIfOverlay(); }}
          className="w-full flex items-center justify-center gap-2 rounded-full bg-primary/15 px-4 py-2.5 text-sm font-medium text-primary transition hover:bg-primary/25 active:scale-[0.98]"
        >
          <RiAddLine size={16} />
          <span className="truncate">New session</span>
        </button>
        <button
          type="button"
          onClick={() => { onOpenDrawer(); closeIfOverlay(); }}
          className="w-full flex items-center justify-center gap-2 rounded-full bg-surface-2 px-4 py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-[0.98]"
        >
          <RiSettings4Line size={16} />
          <span className="truncate">Settings</span>
        </button>
      </div>
    </Sidebar>
  );
}
