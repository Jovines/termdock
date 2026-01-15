import React from 'react';
import { RiAddLine, RiCloseLine, RiTerminalBoxLine } from '@remixicon/react';

export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  name: string;
}

interface BottomDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export const BottomDrawer: React.FC<BottomDrawerProps> = ({
  isOpen,
  onClose,
  title,
  children,
}) => {
  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 lg:hidden animate-fade-in cursor-default"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onClose();
          }
        }}
      />
      {/* Drawer */}
      <div className="fixed bottom-0 left-0 right-0 bg-surface border-t border-border rounded-t-2xl shadow-2xl z-50 lg:hidden animate-slide-up max-h-[70vh] flex flex-col">
        {/* Handle */}
        <button
          type="button"
          onClick={onClose}
          className="flex justify-center py-3 cursor-pointer"
          aria-label="Close drawer"
        >
          <div className="w-12 h-1.5 bg-muted-foreground/30 rounded-full" />
        </button>
        {/* Title */}
        <div className="px-4 pb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 -mr-2 rounded-lg hover:bg-surface-elevated transition-colors"
          >
            <RiCloseLine className="w-5 h-5" />
          </button>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 pb-6">
          {children}
        </div>
      </div>
    </>
  );
};

interface SessionListDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: TerminalSessionInfo[];
  activeSessionId: string | null;
  onNewSession: () => void;
  onSwitchSession: (id: string) => void;
  onCloseSession: (id: string) => void;
}

export const SessionListDrawer: React.FC<SessionListDrawerProps> = ({
  isOpen,
  onClose,
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
    onClose();
  };

  return (
    <BottomDrawer isOpen={isOpen} onClose={onClose} title="Sessions">
      <div className="space-y-2">
        {/* New Session Button */}
        <button
          type="button"
          onClick={onNewSession}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <RiAddLine size={18} />
          <span className="font-medium">New Session</span>
        </button>

        {/* Session List */}
        {sessions.length > 0 ? (
          <div className="space-y-2 mt-4">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => handleActivate(session.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    handleActivate(session.id);
                  }
                }}
                className={`
                  flex items-center gap-3 px-4 py-3 rounded-lg transition-colors cursor-pointer select-none
                  ${session.id === activeSessionId
                    ? 'bg-primary/10 border border-primary/30'
                    : 'bg-surface-elevated hover:bg-accent/50 border border-transparent'}
                `}
              >
                <RiTerminalBoxLine
                  size={18}
                  className={session.id === activeSessionId ? 'text-primary' : 'text-muted-foreground'}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{session.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{session.cwd}</div>
                </div>
                {session.id === activeSessionId && (
                  <div className="w-2 h-2 rounded-full bg-primary" />
                )}
                <button
                  type="button"
                  onClick={(e) => handleClose(e, session.id)}
                  className="p-1.5 rounded hover:bg-red-500/20 hover:text-red-500 transition-colors"
                  title="Close session"
                >
                  <RiCloseLine size={16} />
                </button>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            No sessions. Tap "New Session" to create one.
          </div>
        )}
      </div>
    </BottomDrawer>
  );
};

export const slideUpAnimation = `
  @keyframes slide-up {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }
  .animate-slide-up {
    animation: slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }
`;
