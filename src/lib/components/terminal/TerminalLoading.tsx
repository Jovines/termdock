import React from 'react';

interface TerminalLoadingProps {
  message?: string;
}

export const TerminalLoading: React.FC<TerminalLoadingProps> = ({ message = 'Loading terminal...' }) => {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="rounded-full bg-surface-2 px-4 py-2 flex items-center gap-3 shadow-sm">
        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">{message}</span>
      </div>
    </div>
  );
};

export const TerminalInitializing: React.FC = () => {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="rounded-full bg-surface-2 px-4 py-2 flex items-center gap-3 shadow-sm">
        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">Initializing terminal engine...</span>
      </div>
    </div>
  );
};
