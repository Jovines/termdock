import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getWorkspaceHost, WORKSPACE_QUERY, type WorkspaceSnapshot, type WorkspaceHost, type ServiceWorkspace } from './workspaceHost';
import { LoaderCircle } from 'lucide-react';
import { syncThemeColorMeta } from '../utils/themeColorMeta';
import { WorkspacePortalContext } from './WorkspacePortal';

const empty: WorkspaceSnapshot = { activeKey: 'root', items: [] };
const subscribeEmpty = () => () => {};
const snapshotEmpty = () => empty;

function WorkspaceFrame({ host, item, visible, active }: { host: WorkspaceHost; item: ServiceWorkspace; visible: boolean; active: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => { frame.current?.toggleAttribute('inert', !active); }, [active]);
  useEffect(() => () => host.attach(item.key, null), [host, item.key]);
  return <iframe ref={frame} title={item.service?.label || '服务工作区'}
    src={`/workspace.html?${WORKSPACE_QUERY}=${encodeURIComponent(item.key)}`}
    className="fixed inset-0 w-full border-0 bg-[var(--chrome-bg)]"
    // Each workspace applies its own safe areas and keyboard layout. Anchor it
    // to the physical viewport, outside the entry root's safe-area padding.
    style={{ height: 'var(--app-base-vh, 100%)', visibility: visible ? 'visible' : 'hidden', pointerEvents: active ? 'auto' : 'none' }}
    aria-hidden={!active} tabIndex={active ? 0 : -1} allow="clipboard-read; clipboard-write; fullscreen"
    onLoad={event => host.attach(item.key, event.currentTarget.contentWindow)} />;
}

export function ServiceWorkspaceHost({ children }: { children: ReactNode }) {
  const host = window.parent === window ? getWorkspaceHost() : undefined;
  const snapshot = useSyncExternalStore(host?.subscribe || subscribeEmpty, host?.snapshot || snapshotEmpty);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // Restoring a saved workspace on launch has no previous screen. Never
  // expose the entry terminal underneath it or present it as a user switch.
  const [presentedKey, setPresentedKey] = useState<string | null>(() =>
    snapshot.activeKey === 'root' ? 'root' : null);
  const [revealedKey, setRevealedKey] = useState<string>();
  const [slow, setSlow] = useState(false);
  const destination = snapshot.items.find(item => item.key === snapshot.activeKey);
  // Keep the previous document painted until the destination's UI, rather
  // than just its socket or iframe load event, is ready. Hidden frames retain
  // their dimensions so terminal restoration can finish before presentation.
  const visibleKey = destination?.rendered || revealedKey === snapshot.activeKey
    ? snapshot.activeKey : presentedKey;
  const switching = visibleKey !== snapshot.activeKey;
  const restoring = switching && presentedKey === null;
  useLayoutEffect(() => {
    if (!switching) setPresentedKey(visibleKey);
    root?.toggleAttribute('inert', visibleKey !== 'root' || switching);
  }, [root, visibleKey, switching]);
  useEffect(() => {
    setSlow(false);
    if (!switching) return;
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [snapshot.activeKey, switching]);
  useEffect(() => { setRevealedKey(undefined); }, [snapshot.activeKey]);
  const previous = snapshot.items.find(item => item.key === presentedKey);
  const connectionStatus = destination?.phase === 'offline' ? '网络已断开，等待恢复…'
    : destination?.phase === 'reconnecting' ? '连接暂未恢复，正在重试…'
    : slow ? '连接时间较长，仍在等待服务…' : restoring ? '正在恢复服务…' : '正在切换服务…';
  // Shared preferences may change in any workspace, including the one on top.
  useEffect(() => {
    if (!host) return;
    const syncTheme = () => {
      try {
        const theme = JSON.parse(localStorage.getItem('termdock-color-theme') || 'null');
        if (theme === 'dark' || theme === 'light') { document.documentElement.dataset.theme = theme; syncThemeColorMeta(theme); }
      } catch { /* Optional preference. */ }
    };
    window.addEventListener('storage', syncTheme);
    return () => window.removeEventListener('storage', syncTheme);
  }, [host]);
  useEffect(() => {
    if (!host || !('serviceWorker' in navigator)) return;
    const message = (event: MessageEvent) => {
      if (event.source !== navigator.serviceWorker.controller) return;
      const data = event.data;
      if (data?.type === 'termdock:focus-session' && typeof data.targetPeerId === 'string' && typeof data.sessionId === 'string'
        && host.focusSession(data.targetPeerId, data.sessionId)) {
        event.ports[0]?.postMessage({ type: 'termdock:focus-session-ack' }); event.stopImmediatePropagation();
      }
    };
    const restoreNotification = async () => {
      if (!('caches' in window)) return;
      try {
        const cache = await caches.open('termdock-notification-target-v1');
        const response = await cache.match('/__termdock-notification-target');
        if (!response) return;
        const data = await response.json();
        if (typeof data.targetPeerId === 'string' && typeof data.sessionId === 'string' && Date.now() - data.clickedAt < 30_000
          && host.focusSession(data.targetPeerId, data.sessionId)) await cache.delete('/__termdock-notification-target');
      } catch { /* The workspace also consumes the notification after mounting. */ }
    };
    const visible = () => { if (!document.hidden) void restoreNotification(); };
    navigator.serviceWorker.addEventListener('message', message);
    document.addEventListener('visibilitychange', visible);
    void restoreNotification();
    return () => { navigator.serviceWorker.removeEventListener('message', message); document.removeEventListener('visibilitychange', visible); };
  }, [host]);
  if (!host) return children;
  return <div className="relative h-full w-full overflow-hidden bg-[var(--chrome-bg)]">
    <div ref={setRoot} className="isolate h-full w-full" aria-hidden={visibleKey !== 'root' || switching}
      style={{ visibility: visibleKey === 'root' ? 'visible' : 'hidden' }}>
      <WorkspacePortalContext.Provider value={root}>{children}</WorkspacePortalContext.Provider>
    </div>
    {snapshot.items.filter(item => item.key !== 'root').map(item => <WorkspaceFrame key={item.key} host={host} item={item} visible={visibleKey === item.key} active={!switching && visibleKey === item.key} />)}
    {restoring && <div className="termdock-boot z-modal-panel" role="status" aria-live="polite">
      {slow || destination?.phase === 'offline' || destination?.phase === 'reconnecting' ? (
        <div className="flex max-w-xs flex-col items-center gap-3 text-center">
          <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <div className="max-w-full truncate text-sm">{destination?.service?.label || 'Termdock'}</div>
          <div className="text-xs text-muted-foreground">{connectionStatus}</div>
          <button type="button" className="min-h-11 rounded-lg bg-surface-2 px-4 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setRevealedKey(snapshot.activeKey)}>查看连接页面</button>
        </div>
      ) : <><div className="termdock-boot-spinner" aria-hidden="true" /><span>Loading Termdock</span></>}
    </div>}
    {switching && !restoring && <div className="fixed inset-0 z-modal-panel flex items-center justify-center bg-background/40 px-6" role="dialog" aria-modal="true" aria-label="切换服务"
      onKeyDown={event => {
        if (event.key === 'Escape' && previous?.service) {
          event.preventDefault();
          host.activate(previous.service);
        }
        if (event.key === 'Tab') {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
          const first = buttons[0], last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="w-full max-w-xs rounded-2xl border border-border/15 bg-surface-elevated p-5 text-foreground shadow-xl">
        <div role="status" aria-live="polite" className="flex items-center gap-3">
          <LoaderCircle size={20} className="shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{destination?.service?.label || '服务工作区'}</div>
            <div className="mt-1 text-xs text-muted-foreground">{connectionStatus}</div>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          {slow && <button type="button" className="min-h-11 rounded-lg px-3 text-xs text-muted-foreground hover:bg-surface-2" onClick={() => setRevealedKey(snapshot.activeKey)}>查看连接页面</button>}
          {previous?.service && <button type="button" autoFocus className="min-h-11 rounded-lg bg-surface-2 px-4 text-sm hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => host.activate(previous.service!)}>取消切换</button>}
        </div>
      </div>
    </div>}
  </div>;
}
