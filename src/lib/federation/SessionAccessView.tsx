import { useSessionViewMode } from '../components/chat/sessionViewMode';
import { useViewportHeight } from '../hooks/useViewportHeight';
import { lazy, Suspense } from 'react';
import { MessageCircle, PanelRight, RefreshCw, TerminalSquare } from 'lucide-react';
import { mergeShareResources, type ShareResources } from '../../server/shared/shareResources';
import { savedConnection } from './browserIntegration';
const ResourceSidebar = lazy(() => import('./SessionResourceSidebar').then(m => ({ default: m.SessionResourceSidebar })));
const Chat = lazy(() => import('../components/chat/SessionChatView').then(m => ({ default: m.SessionChatView })));
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getTerminalTheme, type TermdockColorTheme } from '../terminal/theme';
import type { SecureClient } from './secureClient';
import { beginSidebarResize } from '../components/sidebar/sidebarResize';
import { useSidebarStore } from '../stores/useSidebarStore';
import { ShareAccessContext } from './ShareAccessContext';

interface RemoteSession { sessionId: string; sourceSessionId?: string; name: string; live: boolean; canWrite: boolean; canResize: boolean }
export function SessionAccessView({ client, initialSessionId, initialViewMode }: { client: SecureClient; initialSessionId?: string; initialViewMode?: 'terminal' | 'chat' }) {
  useViewportHeight();
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [selected, setSelected] = useState<RemoteSession>();
  const [resources, setResources] = useState<ShareResources>({});
  const panel = useRef<HTMLDivElement>(null), stopResize = useRef<(() => void) | null>(null);
  const sidebarWidth = useSidebarStore(state => state.rightSidebarWidth);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [wide, setWide] = useState(() => window.innerWidth >= 1024);
  const [invitedMode] = useState(() => { try { return sessionStorage.getItem(`termdock:shared-view:${client.targetPeerId}`); } catch { return null; } });
  const defaultMode = initialViewMode || (invitedMode === 'chat' ? 'chat' : invitedMode === 'terminal' ? 'terminal' : savedConnection()?.viewMode) || 'terminal';
  const [mode, changeMode, modeError] = useSessionViewMode(selected?.sourceSessionId || selected?.sessionId || '', true, defaultMode, !!(initialViewMode || invitedMode || savedConnection()?.viewMode));
  useEffect(() => { const resize = () => setWide(window.innerWidth >= 1024); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const [terminalStarted, setTerminalStarted] = useState(defaultMode === 'terminal');
  useEffect(() => { if (mode === 'terminal') setTerminalStarted(true); }, [mode]);
  const modeRef = useRef(mode); modeRef.current = mode;
  const resizeTerminal = useRef<() => void>(() => {});
  useEffect(() => { const frame = requestAnimationFrame(() => resizeTerminal.current()); return () => cancelAnimationFrame(frame); }, [mode]);
  useEffect(() => () => stopResize.current?.(), []);
  const inputTerminal = useRef<(text: string) => void>(() => {});
  const hasResources = !!(resources.android?.length || resources.computers?.length || resources.directories?.length);
  const insert = (text: string) => { if (!selected?.canWrite) return; if (mode === 'chat') window.dispatchEvent(new CustomEvent('termdock:chat-insert', { detail: { sessionId: selected.sourceSessionId || selected.sessionId, text } })); else inputTerminal.current(text); if (!wide) setSidebarOpen(false); };
  const autoSelected = useRef<string>();
  useEffect(() => {
    if (!initialSessionId || autoSelected.current === initialSessionId) return;
    const session = sessions.find(item => item.sessionId === initialSessionId || item.sourceSessionId === initialSessionId);
    if (session) { autoSelected.current = initialSessionId; setSelected(session); }
  }, [sessions, initialSessionId]);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [status, setStatus] = useState('正在读取会话…');
  const [theme, setTheme] = useState<TermdockColorTheme>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try { const result = await client.request({ type: 'session-list' }); if (active) { const items = result.items as RemoteSession[]; setSessions(items); setSelected(previous => {
          if (!previous) { if (items.length === 1) return items[0]; setStatus(items.length ? '请选择会话' : '暂无可用会话'); return previous; }
          const latest = items.find(item => item.sessionId === previous.sessionId);
          if (!latest) { setStatus('会话已不可用，请联系分享者'); return undefined; }
          return latest.name === previous.name && latest.canWrite === previous.canWrite && latest.canResize === previous.canResize ? previous : latest;
        }); } }
      catch { if (active) { setStatus('连接暂时中断，请重试'); setResources({}); } }
      try { const permissions = await client.request({ type: 'permissions' }); if (active && Array.isArray(permissions.grants)) { const next = mergeShareResources((permissions.grants as { resources?: ShareResources }[]).map(g => g.resources)); setResources(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); } } catch { if (active) setResources({}); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 15000);
    return () => { active = false; clearInterval(timer); };
  }, [client]);
  useEffect(() => {
    if (!selected || !element.current || !terminalStarted) return;
    let disposed = false;
    let lastSeq = 0; let epoch: string | undefined;
    const terminal = new Terminal({ theme: getTerminalTheme(theme), cursorBlink: selected.canWrite, disableStdin: !selected.canWrite, convertEol: false });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element.current); if (selected.canResize && modeRef.current === 'terminal') fit.fit();
    setStatus('正在连接…');
    const query = new URLSearchParams({ flow: '2', ...(selected.canResize ? { transport: 'tmux-client', cols: String(terminal.cols), rows: String(terminal.rows) } : {}) });
    const socket = client.openSocket(`/api/terminal/${encodeURIComponent(selected.sessionId)}/ws?${query}`);
    const resize = () => {
      if (disposed || modeRef.current !== 'terminal' || !element.current?.clientWidth || !element.current?.clientHeight) return;
      if (!selected.canResize) {
        const screen = element.current.querySelector<HTMLElement>('.xterm-screen'), mount = element.current.querySelector<HTMLElement>('.xterm');
        if (screen && mount && screen.offsetWidth && screen.offsetHeight) { const scale = Math.min(1, (element.current.clientWidth - 16) / screen.offsetWidth, (element.current.clientHeight - 16) / screen.offsetHeight); mount.style.transformOrigin = 'top left'; mount.style.transform = `scale(${Math.max(0.1, scale)})`; }
        return;
      }
      fit.fit();
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };
    resizeTerminal.current = resize;
    socket.onopen = () => { setStatus(selected.canWrite ? '' : '只读'); resize(); };
    socket.onmessage = event => {
      try {
        const frame = JSON.parse(event.data);
        if (disposed) return;
        if (frame.type === 'connected') {
          epoch = typeof frame.streamEpoch === 'string' ? frame.streamEpoch : undefined;
          lastSeq = Number.isSafeInteger(frame.replayLastSeq) ? frame.replayLastSeq : 0;
          if (!selected.canResize && Number.isSafeInteger(frame.cols) && Number.isSafeInteger(frame.rows) && frame.cols > 0 && frame.rows > 0) terminal.resize(frame.cols, frame.rows);
          const replay = Array.isArray(frame.replayChunks) ? frame.replayChunks.filter((chunk: unknown) => typeof chunk === 'string').join('') : '';
          // Reset in xterm's write queue, preserving order with earlier writes and subsequent output.
          terminal.write((frame.replayOutOfWindow ? '\x1bc' : '') + replay, resize);
        } else if (frame.type === 'data' && typeof frame.data === 'string') terminal.write(frame.data, () => {
          if (disposed) return;
          if (Number.isSafeInteger(frame.seq)) lastSeq = Math.max(lastSeq, frame.seq);
          if (socket.readyState === 1 && Number.isSafeInteger(frame.flowSeq)) socket.send(JSON.stringify({ type: 'output-ack', flowSeq: frame.flowSeq, since: lastSeq, epoch }));
        });
        else if (frame.type === 'pty-size' && !selected.canResize && Number.isSafeInteger(frame.cols) && Number.isSafeInteger(frame.rows) && frame.cols > 0 && frame.rows > 0) { terminal.resize(frame.cols, frame.rows); requestAnimationFrame(resize); }
        else if (frame.type === 'error') setStatus('无法连接，请联系分享者');
      } catch { setStatus('终端数据无效'); socket.close(); }
    };
    socket.onclose = () => setStatus('连接已断开，请重连');
    socket.onerror = () => setStatus('连接失败，请重试');
    inputTerminal.current = text => { if (selected.canWrite && socket.readyState === 1) socket.send(JSON.stringify({ type: 'input', data: text })); };
    const input = terminal.onData(data => { if (selected.canWrite && socket.readyState === 1) socket.send(JSON.stringify({ type: 'input', data })); });
    const heartbeat = setInterval(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ping' })); }, 20_000);
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    void document.fonts?.ready.then(() => { if (!disposed) resize(); });
    return () => { disposed = true; resizeTerminal.current = () => {}; inputTerminal.current = () => {}; clearInterval(heartbeat); observer.disconnect(); input.dispose(); socket.onclose = null; socket.onerror = null; socket.close(); terminal.dispose(); };
  }, [client, selected?.sessionId, selected?.canWrite, selected?.canResize, theme, terminalStarted, reconnectEpoch]);
  return <ShareAccessContext.Provider value={resources}><div className="flex h-full min-h-0 flex-col bg-[var(--chrome-bg)] text-foreground">
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-border/40 px-3 pt-[env(safe-area-inset-top)] text-sm">
      <div className="min-w-0 flex-1"><p className="truncate font-medium">{selected?.name || '共享工作空间'}</p><p className="truncate text-[10px] text-muted-foreground" role="status">{selected && !selected.canWrite ? '只读' : mode === 'terminal' ? status : ''}</p></div>
      <button type="button" onClick={() => changeMode(mode === 'chat' ? 'terminal' : 'chat')} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs hover:bg-hover">{mode === 'chat' ? <TerminalSquare size={15} /> : <MessageCircle size={15} />}{mode === 'chat' ? '终端' : '对话'}</button>
      <button type="button" aria-label="重新连接会话" onClick={() => setReconnectEpoch(value => value + 1)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-hover"><RefreshCw size={15} /></button>
      {hasResources && <button type="button" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(v => !v)} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs hover:bg-hover"><PanelRight size={15} />侧栏</button>}

    </header>
    {modeError && <p role="alert" className="px-3 py-2 text-xs text-destructive">{modeError}</p>}
    {sessions.length > 1 && <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-border/30 p-2">{sessions.map(session => <button key={`${client.targetPeerId}:${session.sessionId}`} aria-pressed={selected?.sessionId === session.sessionId} className={`min-h-11 shrink-0 rounded-lg px-3 text-xs ${selected?.sessionId === session.sessionId ? 'bg-surface-2' : 'text-muted-foreground hover:bg-hover'}`} onClick={() => setSelected({ ...session })}>{session.name}{!session.canWrite ? ' · 只读' : ''}</button>)}</div>}
    <div className="flex min-h-0 flex-1"><main className="flex min-h-0 min-w-0 flex-1 flex-col">

      <div ref={element} className={`min-h-0 flex-1 overflow-auto p-2 ${mode !== 'terminal' ? 'hidden' : ''}`} />
      {selected && mode === 'chat' && <div className="min-h-0 flex-1"><Suspense fallback={<p className="p-6 text-sm text-muted-foreground">正在打开对话…</p>}><Chat key={selected.sourceSessionId || selected.sessionId} sessionId={selected.sourceSessionId || selected.sessionId} name={selected.name} terminalLink={false} canWrite={selected.canWrite} onTerminal={() => changeMode('terminal')} /></Suspense></div>}
      {!selected && <p className="p-6 text-sm text-muted-foreground">{status}</p>}
    </main>{hasResources && <div ref={panel} className={wide ? sidebarOpen ? 'relative shrink-0 border-l border-border' : 'hidden' : ''} style={wide && sidebarOpen ? { width: Math.max(280, Math.min(sidebarWidth, window.innerWidth - 360)) } : undefined}>{wide && sidebarOpen && <button type="button" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" className="absolute inset-y-0 -left-0.5 z-20 w-[5px] cursor-col-resize bg-transparent transition hover:bg-primary/30 focus-visible:bg-primary/30" onMouseDown={event => { if (!panel.current) return; event.preventDefault(); stopResize.current?.(); stopResize.current = beginSidebarResize(panel.current, event.clientX, panel.current.getBoundingClientRect().width, width => Math.max(280, Math.min(width, window.innerWidth - 360)), width => useSidebarStore.getState().setRightSidebarWidth(width), -1); }} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); useSidebarStore.getState().setRightSidebarWidth(Math.max(280, Math.min(sidebarWidth + (event.key === 'ArrowLeft' ? 24 : -24), window.innerWidth - 360))); } }} />}<Suspense fallback={<p className="p-4 text-xs text-muted-foreground">正在打开侧栏…</p>}><ResourceSidebar resources={resources} sessionId={selected?.sourceSessionId || selected?.sessionId} pinned={wide} open={sidebarOpen} onClose={() => setSidebarOpen(false)} onInsert={insert} /></Suspense></div>}</div>
  </div></ShareAccessContext.Provider>;
}
