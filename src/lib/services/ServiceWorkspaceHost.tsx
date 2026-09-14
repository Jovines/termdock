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
  useLayoutEffect(() => {
    const element = frame.current;
    return () => {
      // Run while the document still exists: iframe removal need not deliver
      // pagehide, and trailing local writes must survive workspace eviction.
      try {
        const view = element?.contentWindow;
        const event = view?.document.createEvent('Event');
        if (event) { event.initEvent('termdock:before-update', false, false); view?.dispatchEvent(event); }
      } catch { /* A document can already be navigating or gone. */ }
      host.attach(item.key, null);
    };
  }, [host, item.key]);
  return <iframe ref={frame} title={item.service?.label || '服务工作区'}
    data-workspace-key={item.key}
    src={`/workspace.html?${WORKSPACE_QUERY}=${encodeURIComponent(item.key)}`}
    className="fixed inset-0 w-full border-0 bg-[var(--chrome-bg)]"
    // Each workspace applies its own safe areas and keyboard layout. Anchor it
    // to the physical viewport, outside the entry root's safe-area padding.
    style={{ height: 'var(--app-base-vh, 100%)', visibility: visible ? 'visible' : 'hidden', pointerEvents: active ? 'auto' : 'none' }}
    // SecureAccessGate attaches after installing its activation listener.
    // iframe load can precede that effect and swallow the pending sidebar intent.
    aria-hidden={!active} tabIndex={active ? 0 : -1} allow="clipboard-read; clipboard-write; fullscreen" />;
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
  const [switchPosition, setSwitchPosition] = useState<{ left: number; top: number; width: number; transform: string }>();
  const destination = snapshot.items.find(item => item.key === snapshot.activeKey);
  // Keep the previous document painted until the destination's UI, rather
  // than just its socket or iframe load event, is ready. Hidden frames retain
  // their dimensions so terminal restoration can finish before presentation.
  const visibleKey = destination?.rendered || revealedKey === snapshot.activeKey
    ? snapshot.activeKey : presentedKey;
  const switching = visibleKey !== snapshot.activeKey;
  const restoring = switching && presentedKey === null;
  useLayoutEffect(() => {
    if (!switching || restoring) { setSwitchPosition(undefined); return; }
    const position = () => {
      const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-workspace-key]'))
        .find(element => element.dataset.workspaceKey === presentedKey);
      const owner = presentedKey === 'root' ? root : frame?.contentDocument;
      const nav = owner?.querySelector<HTMLElement>('nav[aria-label="切换服务"]');
      const strip = nav?.closest<HTMLElement>('[data-sidebar-gesture-ignore]');
      const bounds = strip?.getBoundingClientRect();
      if (!bounds || bounds.width === 0 || bounds.right <= 0) { setSwitchPosition(undefined); return; }
      const offset = frame?.getBoundingClientRect();
      const above = bounds.top + (offset?.top ?? 0) >= 160;
      setSwitchPosition({
        left: bounds.left + (offset?.left ?? 0) + 12,
        top: (above ? bounds.top - 8 : bounds.bottom + 8) + (offset?.top ?? 0),
        width: Math.max(0, bounds.width - 24),
        transform: above ? 'translateY(-100%)' : 'none',
      });
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [switching, restoring, presentedKey, root]);
  useLayoutEffect(() => {
    host?.present(visibleKey);
    if (!switching) setPresentedKey(visibleKey);
    root?.toggleAttribute('inert', visibleKey !== 'root' || switching);
  }, [host, root, visibleKey, switching]);
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
    {switching && !restoring && <div className="fixed inset-0 z-modal-panel flex items-end justify-center px-3 pb-[calc(env(safe-area-inset-bottom)+96px)]" role="dialog" aria-modal="true" aria-label="切换服务"
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
      <div style={switchPosition ? { position: 'absolute', ...switchPosition } : undefined}
        className="flex w-full max-w-sm flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-surface-elevated px-3 py-1.5 text-foreground shadow-lg">
        <div role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-2">
          <LoaderCircle size={16} className="shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{destination?.service?.label || '服务工作区'}</div>
            <div className="mt-1 text-xs text-muted-foreground">{connectionStatus}</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1">
          {slow && <button type="button" className="min-h-11 rounded-lg px-3 text-xs text-muted-foreground hover:bg-surface-2" onClick={() => setRevealedKey(snapshot.activeKey)}>查看连接页面</button>}
          {previous?.service && <button type="button" autoFocus aria-label="取消切换" className="min-h-11 shrink-0 rounded-lg px-3 text-xs text-muted-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => host.activate(previous.service!)}>取消</button>}
        </div>
      </div>
    </div>}
  </div>;
}
