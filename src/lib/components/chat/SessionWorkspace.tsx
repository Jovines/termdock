import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useSessionViewMode } from './sessionViewMode';
const Chat = lazy(() => import('./SessionChatView').then(m => ({ default: m.SessionChatView })));
/** The existing session menu owns view actions; the terminal keeps its full canvas. */
export function SessionWorkspace({ sessionId, name, active, onKeyboardChange, onChatReadyChange, children }: { sessionId: string; name: string; active: boolean; onKeyboardChange?: (open: boolean) => void; onChatReadyChange?: (sessionId: string, ready: boolean | null) => void; children: (terminalVisible: boolean) => ReactNode }) {
  const [mode, setMode] = useSessionViewMode(sessionId, active);
  const [mountedChat, setMountedChat] = useState(mode === 'chat');
  const [chatReady, setChatReady] = useState(false);
  useEffect(() => {
    // null means this session is displaying its terminal, whose existing
    // stream/content/size readiness checks remain authoritative.
    onChatReadyChange?.(sessionId, mode === 'chat' ? chatReady : null);
    return () => onChatReadyChange?.(sessionId, null);
  }, [sessionId, mode, chatReady, onChatReadyChange]);
  if (mode === 'chat' && !mountedChat) setMountedChat(true);
  return <div className="flex h-full min-h-0 flex-col">
    <div className={`min-h-0 flex-1 ${mode === 'terminal' ? '' : 'hidden'}`}>{children(mode === 'terminal')}</div>
    {mountedChat && <div className={`min-h-0 flex-1 ${mode === 'chat' ? '' : 'hidden'}`}><Suspense fallback={<p className="p-6 text-sm text-muted-foreground">正在打开对话…</p>}><Chat sessionId={sessionId} name={name} active={active && mode === 'chat'} terminalLink={false} onKeyboardChange={onKeyboardChange} onReadyChange={setChatReady} onTerminal={() => setMode('terminal')} /></Suspense></div>}
  </div>;
}
