import { MessageCircle, Share2, TerminalSquare } from 'lucide-react';
import { openSessionShare } from '../../federation/accessEvents';
import { useSessionViewMode } from './sessionViewMode';
export function SessionViewActions({ sessionId, onDone }: { sessionId: string; onDone: () => void }) {
  const [mode, setMode] = useSessionViewMode(sessionId);
  const action = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-xs hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring';
  return <div className="space-y-2 border-b border-border/15 px-3 py-3"><div role="group" aria-label="会话显示方式" className="flex gap-1 rounded-xl bg-surface-2 p-1">{([['terminal', '终端', TerminalSquare], ['chat', '普通对话', MessageCircle]] as const).map(([value, label, Icon]) => <button type="button" key={value} aria-pressed={mode === value} className={`${action} flex-1 ${mode === value ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground'}`} onClick={() => { setMode(value); onDone(); }}><Icon size={15} />{label}</button>)}</div><button type="button" className={`${action} w-full justify-start text-foreground`} onClick={() => { onDone(); openSessionShare({ inviteSessionId: sessionId, viewMode: mode }); }}><Share2 size={15} />分享这个会话</button></div>;
}
