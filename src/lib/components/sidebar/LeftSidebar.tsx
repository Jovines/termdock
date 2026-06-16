import {
  X as RiCloseLine,
  Plus as RiAddLine,
  Settings as RiSettings4Line,
  Terminal as RiTerminalLine,
  LayoutGrid as RiLayoutGridLine,
  Search as RiSearchLine,
  LoaderCircle as RiLoaderCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { Sidebar } from './Sidebar';
import type { AgentStatus } from '../../terminal/types';
import { getCwdLeafName, getSessionDisplayName } from '../../terminal/display';
import { AgentSessionDot, AgentCountBadge } from '../AgentIndicators';
import { useI18n } from '../../i18n';

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
  onReorderSessions: (sessionIds: string[]) => void;
  onOpenSettings: () => void;
  tmuxAvailable?: boolean;
  defaultSessionMode?: 'shell' | 'tmux';
  push?: boolean;
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
  return <AgentSessionDot status={status} needsReview={needsReview} inCopyMode={inCopyMode} />;
}

export function LeftSidebar(
  {
    isOpen, drawerWidthPx, onClose, onOpen,
    sessions, activeSessionId, sessionStates,
    onNewSession, onCloseSession, onReorderSessions, onOpenSettings,
    tmuxAvailable = true,
    defaultSessionMode = 'shell',
    push,
  }: LeftSidebarProps,
) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [confirmNewMode, setConfirmNewMode] = useState<'shell' | 'tmux' | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const trimmedQuery = query.trim();
  const isFiltering = trimmedQuery.length > 0;

  const visibleSessions = useMemo(() => (
    sessions.filter((session) => matchesSession(trimmedQuery, session, sessionStates.get(session.id)))
  ), [trimmedQuery, sessions, sessionStates]);

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
      setConfirmNewMode(null);
    }
  }, [isOpen]);

  useEffect(() => {
    setConfirmNewMode(null);
  }, [defaultSessionMode, tmuxAvailable]);

  const closeIfOverlay = () => {
    if (!push) onClose();
  };
  const shellConfirming = confirmNewMode === 'shell';
  const tmuxConfirming = confirmNewMode === 'tmux';
  const highlightedNewMode = confirmNewMode ?? defaultSessionMode;
  const shellHighlighted = highlightedNewMode === 'shell';
  const tmuxHighlighted = highlightedNewMode === 'tmux' && tmuxAvailable;
  const handleNewSessionClick = (mode: 'shell' | 'tmux') => {
    if (mode === 'tmux' && !tmuxAvailable) return;

    const isDefaultMode = mode === defaultSessionMode;
    if (!isDefaultMode && confirmNewMode !== mode) {
      setConfirmNewMode(mode);
      return;
    }

    setConfirmNewMode(null);
    onNewSession({ mode });
    closeIfOverlay();
  };

  const handleSessionDragEnd = useCallback((result: DropResult) => {
    if (isFiltering) return;
    if (!result.destination || result.source.index === result.destination.index) return;
    const reordered = [...sessions];
    const [moved] = reordered.splice(result.source.index, 1);
    reordered.splice(result.destination.index, 0, moved);
    onReorderSessions(reordered.map((session) => session.id));
  }, [isFiltering, onReorderSessions, sessions]);

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
              <span className="text-[13px] font-semibold text-foreground">{t('sidebar.sessions')}</span>
              <span className="text-[11px] text-muted-foreground">{sessions.length}</span>
              {(runningCount > 0 || reviewCount > 0) && (
                <span className="ml-1 flex items-center gap-1.5">
                  <AgentCountBadge count={runningCount} tone="running" title={t('agent.aiRunning')} />
                  <AgentCountBadge count={reviewCount} tone="review" title={t('agent.needsReview')} />
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
            aria-label={t('sidebar.toggleSearch')}
            title={t('common.search')}
          >
            <RiSearchLine size={14} />
          </button>
          <button
            type="button"
            onClick={() => { onOpenSettings(); closeIfOverlay(); }}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
            aria-label={t('sidebar.settings')}
            title={t('sidebar.settings')}
          >
            <RiSettings4Line size={14} />
          </button>
          {!push && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive active:scale-95"
              aria-label={t('common.close')}
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
              placeholder={t('sidebar.filterSessions')}
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
                aria-label={t('sidebar.clearSearch')}
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
            <p className="text-[12px] text-muted-foreground">{t('sidebar.noSessions')}</p>
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="rounded-xl bg-surface-2/60 px-4 py-6 text-center">
            <p className="text-[12px] text-muted-foreground">{t('sidebar.noMatchingSessions')}</p>
          </div>
        ) : (
          <DragDropContext onDragEnd={handleSessionDragEnd}>
            <Droppable droppableId="sidebar-sessions" direction="vertical">
              {(provided) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className="space-y-0.5"
          >
            {visibleSessions.map((session, index) => {
              const isActive = session.id === activeSessionId;
              const ts = sessionStates.get(session.id);
              const cwdLeaf = getCwdLeafName(ts?.cwd ?? null);
              const displayName = getSessionDisplayName(session, ts?.activeProgram ?? null, ts?.cwd ?? null);
              const cwdSecondary = cwdLeaf && cwdLeaf !== displayName ? cwdLeaf : null;
              const accentClass = ts?.agentStatus === 'running'
                ? 'bg-green-400'
                : (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview)
                  ? 'bg-yellow-400'
                  : ts?.inCopyMode
                    ? 'bg-yellow-400/70'
                    : 'bg-primary';

              return (
                <Draggable key={session.id} draggableId={`sidebar:${session.id}`} index={index} isDragDisabled={isFiltering} disableInteractiveElementBlocking>
                  {(dragProvided, snapshot) => (
                <div
                  ref={dragProvided.innerRef}
                  {...dragProvided.draggableProps}
                  className={`group relative flex items-center gap-1 rounded-lg pr-1 transition ${
                    snapshot.isDragging
                      ? 'bg-surface-elevated text-foreground shadow-lg opacity-90'
                      : isActive
                        ? 'bg-surface-elevated text-foreground'
                        : 'text-muted-foreground hover:bg-surface-2'
                  } ${isFiltering ? '' : 'cursor-grab active:cursor-grabbing'}`}
                >
                  <button
                    ref={isActive ? activeItemRef : null}
                    type="button"
                    {...dragProvided.dragHandleProps}
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
                    aria-label={t('sidebar.closeSession', { name: displayName })}
                    title={t('common.close')}
                  >
                    <RiCloseLine size={13} />
                  </button>
                </div>
                  )}
                </Draggable>
              );
            })}
            {provided.placeholder}
          </div>
              )}
            </Droppable>
          </DragDropContext>
        )}
      </div>

      {/* Footer — split new-session button */}
      <div className="shrink-0 border-t border-border/15 p-2">
        <div className="flex items-stretch gap-1.5">
          <button
            type="button"
            onClick={() => handleNewSessionClick('shell')}
            className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg text-[13px] font-semibold transition active:scale-[0.98] ${
              shellHighlighted
                ? 'flex-[2.7] bg-primary px-3 py-2.5 text-primary-foreground ring-1 ring-primary/40 shadow-md shadow-primary/25 hover:bg-primary/90'
                : 'flex-[0.78] bg-surface-2 px-2 py-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            title={shellConfirming ? t('sidebar.confirmNewShell') : t('sidebar.newShell')}
            aria-label={shellConfirming ? t('sidebar.confirmNewShell') : t('sidebar.newShell')}
          >
            <RiAddLine size={14} className={shellHighlighted ? 'shrink-0' : 'hidden'} />
            <RiTerminalLine size={12} />
            <span className={shellHighlighted ? 'whitespace-nowrap' : 'hidden'}>
              {shellConfirming ? t('sidebar.confirmNewShell') : t('sidebar.newShell')}
            </span>
          </button>
          <button
            type="button"
            disabled={!tmuxAvailable}
            onClick={() => handleNewSessionClick('tmux')}
            className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg text-[13px] font-semibold transition active:scale-[0.98] ${
              tmuxAvailable
                ? tmuxHighlighted
                  ? 'flex-[2.7] bg-primary px-3 py-2.5 text-primary-foreground ring-1 ring-primary/40 shadow-md shadow-primary/25 hover:bg-primary/90'
                  : 'flex-[0.78] bg-surface-2 px-2 py-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                : 'flex-1 bg-surface-2/50 text-muted-foreground/50 cursor-not-allowed'
            }`}
            title={tmuxAvailable ? (tmuxConfirming ? t('sidebar.confirmNewTmux') : t('sidebar.newTmux')) : t('sidebar.newTmuxDisabled')}
            aria-label={tmuxConfirming ? t('sidebar.confirmNewTmux') : t('sidebar.newTmux')}
          >
            <RiAddLine size={14} className={tmuxHighlighted ? 'shrink-0' : 'hidden'} />
            <RiLayoutGridLine size={12} />
            <span className={tmuxHighlighted ? 'whitespace-nowrap' : 'hidden'}>
              {tmuxConfirming ? t('sidebar.confirmNewTmux') : t('sidebar.newTmux')}
            </span>
          </button>
        </div>
      </div>
    </Sidebar>
  );
}
