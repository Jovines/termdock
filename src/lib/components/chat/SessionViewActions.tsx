import { ListTodo, MessageCircle, Share2, TerminalSquare } from 'lucide-react';
import { openSessionShare } from '../../federation/accessEvents';
import { useSessionViewMode } from './sessionViewMode';
import { useSessionCapabilities } from '../../federation/ShareAccessContext';
export function SessionViewActions({ sessionId, compact = false, onDone, onInsertTodoPrompt }: { sessionId: string; compact?: boolean; onDone: () => void; onInsertTodoPrompt?: () => void }) {
  const capabilities = useSessionCapabilities();
  const [mode, setMode] = useSessionViewMode(sessionId, capabilities.has('session.owner-menu'));
  if (!capabilities.has('session.owner-menu')) return null;
  const action = `inline-flex items-center gap-2 text-xs hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring ${compact ? 'min-h-7 rounded px-2' : 'min-h-11 rounded-xl px-3'}`;
  return (
    <div className={`border-b border-border/15 ${compact ? 'space-y-1 px-2 py-1' : 'space-y-2 px-3 py-3'}`}>
      <div role="group" aria-label="会话显示方式" className={`flex gap-1 bg-surface-2 ${compact ? 'rounded-md p-0.5' : 'rounded-xl p-1'}`}>
        {([['terminal', '终端', TerminalSquare], ['chat', '普通对话', MessageCircle]] as const).map(([value, label, Icon]) => (
          <button type="button" key={value} aria-pressed={mode === value} className={`${action} flex-1 justify-center ${mode === value ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground'}`} onClick={() => { setMode(value); onDone(); }}>
            <Icon size={compact ? 14 : 15} />{label}
          </button>
        ))}
      </div>
      {capabilities.has('todo.guidance') && onInsertTodoPrompt && <button type="button" className={`${action} w-full justify-start text-foreground`} onClick={onInsertTodoPrompt}>
        <ListTodo size={compact ? 14 : 15} />插入待办提示
      </button>}
      {capabilities.has('session.share') && <button type="button" className={`${action} w-full justify-start text-foreground`} onClick={() => { onDone(); openSessionShare({ inviteSessionId: sessionId, viewMode: mode }); }}>
        <Share2 size={compact ? 14 : 15} />分享这个会话
      </button>}
    </div>
  );
}
