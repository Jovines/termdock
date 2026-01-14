import React from 'react';
import { RiAddLine, RiCloseLine, RiTerminalBoxLine } from '@remixicon/react';

export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  name: string;
}

interface SessionTabsProps {
  sessions: TerminalSessionInfo[];
  activeSessionId: string | null;
  onNewSession: () => void;
  onSwitchSession: (id: string) => void;
  onCloseSession: (id: string) => void;
}

export const SessionTabs: React.FC<SessionTabsProps> = ({
  sessions,
  activeSessionId,
  onNewSession,
  onSwitchSession,
  onCloseSession,
}) => {
  const handleClose = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    onCloseSession(sessionId);
  };

  const handleActivate = (sessionId: string) => {
    onSwitchSession(sessionId);
  };

  if (sessions.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1 border-b border-border bg-background">
        <button
          type="button"
          onClick={onNewSession}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-primary bg-primary/10 rounded hover:bg-primary/20 transition-colors"
        >
          <RiAddLine size={14} />
          New Session
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-background overflow-x-auto scrollbar-thin">
      {sessions.map((session) => (
        <SessionTab
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          onActivate={() => handleActivate(session.id)}
          onClose={(e) => handleClose(e, session.id)}
        />
      ))}
      <button
        type="button"
        onClick={onNewSession}
        className="flex items-center justify-center w-6 h-6 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors flex-shrink-0"
        title="New Session"
      >
        <RiAddLine size={14} />
      </button>
    </div>
  );
};

interface SessionTabProps {
  session: TerminalSessionInfo;
  isActive: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
}

const SessionTab: React.FC<SessionTabProps> = ({ session, isActive, onActivate, onClose }) => {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onActivate();
        }
      }}
      className={`
        group flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-t transition-colors cursor-pointer select-none
        ${isActive
          ? 'bg-primary/10 text-primary border-t-2 border-t-primary'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50 border-t-2 border-t-transparent'}
      `}
    >
      <RiTerminalBoxLine size={14} />
      <span className="truncate max-w-[120px]">{session.name}</span>
      <button
        type="button"
        onClick={onClose}
        className={`
          flex items-center justify-center w-4 h-4 rounded hover:bg-red-500/20 hover:text-red-500 transition-colors
          ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
        `}
      >
        <RiCloseLine size={12} />
      </button>
    </div>
  );
};
