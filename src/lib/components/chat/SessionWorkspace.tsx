import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { preloadChatHistory } from './chatHistoryRequest';
import { ChatLoading } from './ChatLoading';
import { useSessionViewMode } from './sessionViewMode';
import { sharedSessionContextMenu, useSessionCapabilities } from '../../federation/ShareAccessContext';
import { TerminalPeekContext, useSessionTerminalPeek } from './SessionTerminalPeek';
const loadChat = () => import('./SessionChatView').then(m => ({ default: m.SessionChatView }));
const Chat = lazy(loadChat);
/** The existing session menu owns view actions; the terminal keeps its full canvas. */
export function SessionWorkspace({ sessionId, name, active, terminalReady = false, onKeyboardChange, onChatReadyChange, children }: { sessionId: string; name: string; active: boolean; terminalReady?: boolean; onKeyboardChange?: (open: boolean) => void; onChatReadyChange?: (sessionId: string, ready: boolean | null) => void; children: (terminalVisible: boolean, terminalInteractive: boolean) => ReactNode }) {
  const capabilities = useSessionCapabilities();
  const [mode, setMode] = useSessionViewMode(sessionId, active);
  const peek = useSessionTerminalPeek({ enabled: active && mode === 'chat', name, expand: () => setMode('terminal') });
  const [mountedChat, setMountedChat] = useState(mode === 'chat');
  const [chatReady, setChatReady] = useState(false);
  useEffect(() => {
    if (active && mode === 'chat') return preloadChatHistory(sessionId);
  }, [active, mode, sessionId]);
  useEffect(() => {
    // null means this session is displaying its terminal, whose existing
    // stream/content/size readiness checks remain authoritative.
    onChatReadyChange?.(sessionId, mode === 'chat' ? chatReady : null);
    return () => onChatReadyChange?.(sessionId, null);
  }, [sessionId, mode, chatReady, onChatReadyChange]);
  useEffect(() => {
    if (!active || mountedChat) return;
    // Warm code only for the foreground session, after urgent terminal work.
    const warm = () => { void loadChat().catch(() => {}); };
    if (typeof requestIdleCallback === 'function') {
      const idle = requestIdleCallback(warm, { timeout: 3000 });
      return () => cancelIdleCallback(idle);
    }
    const timer = setTimeout(warm, 800);
    return () => clearTimeout(timer);
  }, [active, mountedChat]);
  if (mode === 'chat' && !mountedChat) setMountedChat(true);
  return <TerminalPeekContext.Provider value={peek.context}><div className="flex h-full min-h-0 flex-col" data-session-workspace={sessionId} data-session-active={active} data-session-input-ready={capabilities.has('todo.guidance') && (mode === 'chat' ? chatReady : terminalReady)}
    onContextMenuCapture={capabilities.has('session.owner-menu') ? undefined : sharedSessionContextMenu}
    onContextMenu={event => {
      if (!active || window.matchMedia('(pointer: coarse)').matches) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('a, button, input[type="file"]') || window.getSelection()?.toString()) return;
      if (target instanceof HTMLTextAreaElement && target.selectionStart !== target.selectionEnd) return;
      event.preventDefault(); event.stopPropagation();
      window.dispatchEvent(new CustomEvent('termdock:session-context-menu', { detail: { sessionId, x: event.clientX, y: event.clientY } }));
    }}>
    <div ref={peek.attachNormal} className={`min-h-0 flex-1 ${mode === 'terminal' ? '' : 'hidden'}`} />
    {createPortal(children(mode === 'terminal' || peek.open, mode === 'terminal' || peek.interactive), peek.host)}
    {mountedChat && <div className={`min-h-0 flex-1 ${mode === 'chat' ? '' : 'hidden'}`}><Suspense fallback={<div className="h-full bg-[var(--chrome-bg)] px-4 sm:px-8"><div className="mx-auto max-w-screen-2xl py-5 sm:py-8"><ChatLoading /></div></div>}><Chat sessionId={sessionId} name={name} active={active && mode === 'chat'} terminalLink={false} onKeyboardChange={onKeyboardChange} onReadyChange={setChatReady} onTerminal={() => setMode('terminal')} /></Suspense></div>}
  </div>{peek.popover}</TerminalPeekContext.Provider>;
}
