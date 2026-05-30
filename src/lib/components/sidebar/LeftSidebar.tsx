import React from 'react';
import {
  X as RiCloseLine,
  Plus as RiAddLine,
  Settings as RiSettings4Line,
  Terminal as RiTerminalLine,
  LayoutGrid as RiLayoutGridLine,
} from 'lucide-react';
import { Sidebar } from './Sidebar';
import type { AgentStatus } from '../../terminal/types';

interface LeftSidebarProps {
  isOpen: boolean;
  drawerWidthPx: number;
  onClose: () => void;
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
    agentStatus: AgentStatus | null;
    agentNeedsReview?: boolean;
  }>;
  onNewSession: () => void;
  onOpenDrawer: () => void;
}

function AgentStatusDot({ status, needsReview }: { status: AgentStatus | null; needsReview?: boolean }) {
  if (!status && !needsReview) return null;
  const color = status === 'running' ? 'bg-green-400' : 'bg-yellow-400';
  const title = status === 'running' ? 'AI running' : 'AI finished — needs review';
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`}
      title={title}
    />
  );
}

function getCwdLeafName(cwd: string | null): string | null {
  if (!cwd) return null;
  if (cwd === '/') return '/';
  const segments = cwd.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || cwd;
}

export const LeftSidebar = React.forwardRef<HTMLElement, LeftSidebarProps>(function LeftSidebar(
  { isOpen, drawerWidthPx, onClose, sessions, activeSessionId, sessionStates, onNewSession, onOpenDrawer },
  ref,
) {
  return (
    <Sidebar
      ref={ref}
      side="left"
      isOpen={isOpen}
      drawerWidthPx={drawerWidthPx}
      onClose={onClose}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/15 px-4 py-3">
        <div className="min-w-0">
          <div className="ui-kicker">Sessions</div>
          <h2 className="section-title mt-0.5">{sessions.length} open</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
          aria-label="Close"
        >
          <RiCloseLine size={18} />
        </button>
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {sessions.length === 0 ? (
          <div className="rounded-2xl bg-surface-2/60 px-4 py-8 text-center">
            <RiTerminalLine size={28} className="mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No open sessions yet.</p>
          </div>
        ) : (
          <div className="space-y-1">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const ts = sessionStates.get(session.id);
              const cwdLeaf = getCwdLeafName(ts?.cwd ?? null);

              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: session.id }));
                    onClose();
                  }}
                  className={`w-full flex items-center gap-2 rounded-xl px-3 py-2.5 text-left transition ${
                    isActive
                      ? 'bg-surface-elevated text-foreground'
                      : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                  }`}
                >
                  <span className="shrink-0">
                    {session.mode === 'tmux' ? (
                      <RiLayoutGridLine size={16} />
                    ) : (
                      <RiTerminalLine size={16} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {session.name}
                  </span>
                  <AgentStatusDot status={ts?.agentStatus ?? null} needsReview={ts?.agentNeedsReview} />
                  {cwdLeaf && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {cwdLeaf}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="shrink-0 border-t border-border/15 p-3 space-y-2">
        <button
          type="button"
          onClick={() => { onNewSession(); onClose(); }}
          className="w-full flex items-center justify-center gap-2 rounded-full bg-primary/15 px-4 py-2.5 text-sm font-medium text-primary transition hover:bg-primary/25"
        >
          <RiAddLine size={16} />
          New session
        </button>
        <button
          type="button"
          onClick={() => { onOpenDrawer(); onClose(); }}
          className="w-full flex items-center justify-center gap-2 rounded-full bg-surface-2 px-4 py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
        >
          <RiSettings4Line size={16} />
          Settings
        </button>
      </div>
    </Sidebar>
  );
});
