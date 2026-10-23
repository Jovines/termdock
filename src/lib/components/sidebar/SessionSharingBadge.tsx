import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Share2, X } from 'lucide-react';
import { currentSecureClient } from '../../federation/browserIntegration';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
export interface SessionSharingStatus { sessionId: string; serviceId?: string; devices: number; connectedDevices: number; invitations: number }
export function useSessionSharingStatus(enabled: boolean) {
  const [items, setItems] = useState<Record<string, SessionSharingStatus>>({});
  const refresh = useCallback(async () => {
    const client = currentSecureClient(); if (!client || client.closed || document.visibilityState === 'hidden') return;
    try {
      const result = await client.request({ type: 'session-sharing-status' });
      if (currentSecureClient() !== client || !Array.isArray(result.items)) return;
      const next = Object.fromEntries((result.items as SessionSharingStatus[]).filter(item => typeof item.sessionId === 'string').map(item => [item.sessionId, { ...item, serviceId: client.targetPeerId }]));
      setItems(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    } catch { /* Unavailable metadata never grants access or presents an invented count. */ }
  }, []);
  useEffect(() => { if (!enabled) return; void refresh(); const timer = setInterval(() => void refresh(), 5000); window.addEventListener('termdock:sharing-changed', refresh); window.addEventListener('focus', refresh); return () => { clearInterval(timer); window.removeEventListener('termdock:sharing-changed', refresh); window.removeEventListener('focus', refresh); }; }, [enabled, refresh]);
  return { items, refresh };
}
export function SessionSharingBadge({ status, onChanged }: { status?: SessionSharingStatus; onChanged: () => void }) {
  const [anchor, setAnchor] = useState<{ left: number; top: number }>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!status || !status.devices && !status.invitations) setAnchor(undefined); }, [status?.sessionId, status?.devices, status?.invitations]);
  useKeyboardLayer(menu, !!anchor && !!status && (!!status.devices || !!status.invitations), () => setAnchor(undefined));
  if (!status || !status.devices && !status.invitations) return null;
  return <><button type="button" aria-label={`已共享，${status.connectedDevices} 台设备连接，管理共享`} title={`已共享 · ${status.connectedDevices} 台设备连接`} aria-expanded={!!anchor}
    className="sidebar-session-action inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] text-primary hover:bg-primary/15" onClick={event => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setError(''); setAnchor({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)), top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 210)) }); }}><Share2 size={11} /><span>共享 · {status.connectedDevices}</span></button>
    {anchor && createPortal(<><div className="fixed inset-0 z-menu-backdrop" onClick={() => setAnchor(undefined)} /><div ref={menu} role="dialog" aria-label="会话共享状态" className="fixed z-menu-panel w-[264px] rounded-xl border border-border bg-surface p-3 text-sm text-foreground shadow-xl" style={anchor}>
      <div className="flex items-center justify-between"><strong className="text-xs font-medium">已共享</strong><button type="button" aria-label="关闭共享状态" className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface-2" onClick={() => setAnchor(undefined)}><X size={14} /></button></div>
      <p className="mt-2 text-xs text-muted-foreground">当前 {status.connectedDevices} 台设备连接 · {status.devices} 台已授权</p>
      {status.invitations > 0 && <p className="mt-1 text-xs text-muted-foreground">{status.invitations} 个邀请待使用</p>}
      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">停止共享会断开此会话的访客连接，并取消对应邀请。</p>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      <button type="button" disabled={busy} className="mt-2 min-h-10 w-full rounded-lg bg-destructive/10 px-3 text-xs text-destructive hover:bg-destructive/15 disabled:opacity-40" onClick={async () => {
        const client = currentSecureClient(); if (!client || status.serviceId && status.serviceId !== client.targetPeerId) { setError('服务已切换，请重新打开共享状态'); return; } setBusy(true); setError('');
        try { await client.request({ type: 'session-sharing-stop', sessionId: status.sessionId }); if (currentSecureClient() === client) { onChanged(); setAnchor(undefined); } }
        catch { setError('暂时无法停止共享，请重试'); } finally { setBusy(false); }
      }}>{busy ? '正在停止共享…' : '停止共享此会话'}</button>
    </div></>, document.body)}
  </>;
}
