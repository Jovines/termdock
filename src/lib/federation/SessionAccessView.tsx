import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getTerminalTheme, type TermdockColorTheme } from '../terminal/theme';
import type { SecureClient } from './secureClient';
import { openServiceAccess } from './accessEvents';

interface RemoteSession { sessionId: string; sourceSessionId?: string; name: string; live: boolean; canWrite: boolean; canResize: boolean }
export function SessionAccessView({ client, initialSessionId }: { client: SecureClient; initialSessionId?: string }) {
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [selected, setSelected] = useState<RemoteSession>();
  const autoSelected = useRef<string>();
  useEffect(() => {
    if (!initialSessionId || autoSelected.current === initialSessionId) return;
    const session = sessions.find(item => item.sessionId === initialSessionId || item.sourceSessionId === initialSessionId);
    if (session) { autoSelected.current = initialSessionId; setSelected(session); }
  }, [sessions, initialSessionId]);
  const [status, setStatus] = useState('正在读取已授权 Session');
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
          if (!previous) { setStatus(items.length ? '选择一个已授权 Session' : '暂无已授权的在线 Session'); return previous; }
          const latest = items.find(item => item.sessionId === previous.sessionId);
          if (!latest) { setStatus('Session 已移除或授权失效'); return undefined; }
          return latest.canWrite === previous.canWrite && latest.canResize === previous.canResize ? previous : latest;
        }); } }
      catch { if (active) setStatus('目标不可达或授权已失效'); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 15000);
    return () => { active = false; clearInterval(timer); };
  }, [client]);
  useEffect(() => {
    if (!selected || !element.current) return;
    let disposed = false;
    let lastSeq = 0; let epoch: string | undefined;
    const terminal = new Terminal({ theme: getTerminalTheme(theme), cursorBlink: selected.canWrite, disableStdin: !selected.canWrite, convertEol: false });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element.current); if (selected.canResize) fit.fit();
    setStatus('正在建立加密终端连接');
    const socket = client.openSocket(`/api/terminal/${encodeURIComponent(selected.sessionId)}/ws?flow=2`);
    const resize = () => {
      if (disposed || !selected.canResize) return;
      fit.fit();
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };
    socket.onopen = () => setStatus(selected.canWrite ? '读写' : '只读');
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
        else if (frame.type === 'pty-size' && !selected.canResize && Number.isSafeInteger(frame.cols) && Number.isSafeInteger(frame.rows) && frame.cols > 0 && frame.rows > 0) terminal.resize(frame.cols, frame.rows);
        else if (frame.type === 'error') setStatus('目标拒绝终端操作，请检查有效授权');
      } catch { setStatus('终端数据无效'); socket.close(); }
    };
    socket.onclose = () => setStatus('连接已断开；画面已过期，重新选择 Session 可重连');
    socket.onerror = () => setStatus('目标不可达或授权不足');
    const input = terminal.onData(data => { if (selected.canWrite && socket.readyState === 1) socket.send(JSON.stringify({ type: 'input', data })); });
    const heartbeat = setInterval(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ping' })); }, 20_000);
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    return () => { disposed = true; clearInterval(heartbeat); observer.disconnect(); input.dispose(); socket.onclose = null; socket.onerror = null; socket.close(); terminal.dispose(); };
  }, [client, selected, theme]);
  return <div className="flex h-dvh flex-col bg-background text-foreground">
    <div className="flex items-center gap-3 border-b border-border p-3 text-sm"><span className="min-w-0 flex-1">已授权 Session · {status}</span><button type="button" onClick={openServiceAccess} className="min-h-11 shrink-0 rounded-lg px-3 text-xs text-muted-foreground hover:bg-surface-2">服务与设备</button></div>
    <div className="flex flex-wrap gap-2 p-2">{sessions.map(session => <button key={`${client.targetPeerId}:${session.sessionId}`} className="rounded border border-border px-3 py-2 text-sm hover:bg-surface-2" onClick={() => setSelected({ ...session })}>{session.name} · {session.canWrite ? '读写' : '只读'}</button>)}</div>
    <div ref={element} className="min-h-0 flex-1 overflow-auto p-2" />
  </div>;
}
