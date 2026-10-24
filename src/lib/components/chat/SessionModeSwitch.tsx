import { createPortal } from 'react-dom';
import { MessageCircle, TerminalSquare } from 'lucide-react';
import { useSessionViewMode } from './sessionViewMode';
/** Lives in the existing navigation row, available in either view and with IME open. */
export function SessionModeSwitch({ sessionId, compact = false, onActivate }: { sessionId: string; compact?: boolean; onActivate?: () => void }) {
  const [mode, setMode, syncError, clearError] = useSessionViewMode(sessionId);
  const label = mode === 'chat' ? '切换到终端' : '切换到对话';
  const Icon = mode === 'chat' ? TerminalSquare : MessageCircle;
  return <><button type="button" aria-label={label} title={label}
    className={`inline-flex shrink-0 items-center justify-center transition hover:bg-surface-elevated ${compact ? 'h-full w-7 rounded-sm' : 'h-7 w-7 rounded-md ring-1 ring-border/10 sm:h-8 sm:w-8'} ${mode === 'chat' ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-muted-foreground'}`}
    onPointerDown={event => event.preventDefault()} onClick={() => {
      onActivate?.();
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.matches('textarea,input,[contenteditable="true"]')) focused.blur();
      setMode(mode === 'chat' ? 'terminal' : 'chat');
    }}><Icon size={compact ? 14 : 15} /></button>{syncError && createPortal(<div role="alert" className="fixed inset-x-3 bottom-4 z-toast mx-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-xs text-foreground shadow-lg"><span className="flex-1">{syncError}</span><button type="button" className="min-h-9 shrink-0 px-2 text-primary" onClick={clearError}>关闭</button></div>, document.body)}</>;
}
