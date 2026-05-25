import React from 'react';

interface TerminalErrorProps {
  message?: string;
  onRetry?: () => void;
}

export const TerminalError: React.FC<TerminalErrorProps> = ({ message, onRetry }) => {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <div className="flex flex-col items-center gap-3 text-center max-w-md">
        <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
          <svg
            className="w-6 h-6 text-red-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            role="img"
            aria-label="Error"
          >
            <title>Error</title>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <div className="space-y-1">
          <h3 className="font-medium text-foreground">Failed to load terminal</h3>
          <p className="text-sm text-muted-foreground">{message || 'An unknown error occurred'}</p>
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-full hover:bg-primary/90 active:scale-[0.97] transition-all shadow-sm"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
};
