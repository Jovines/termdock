import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { getWorkspaceHost, WORKSPACE_QUERY, type WorkspaceSnapshot, type WorkspaceHost, type ServiceWorkspace } from './workspaceHost';
import { syncThemeColorMeta } from '../utils/themeColorMeta';

const empty: WorkspaceSnapshot = { activeKey: 'root', items: [] };
const subscribeEmpty = () => () => {};
const snapshotEmpty = () => empty;

function WorkspaceFrame({ host, item, active }: { host: WorkspaceHost; item: ServiceWorkspace; active: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => { frame.current?.toggleAttribute('inert', !active); }, [active]);
  useEffect(() => () => host.attach(item.key, null), [host, item.key]);
  return <iframe ref={frame} title={item.service?.label || '服务工作区'}
    src={`/workspace.html?${WORKSPACE_QUERY}=${encodeURIComponent(item.key)}`}
    className="absolute inset-0 h-full w-full border-0 bg-[var(--chrome-bg)]"
    style={{ visibility: active ? 'visible' : 'hidden', pointerEvents: active ? 'auto' : 'none' }}
    aria-hidden={!active} tabIndex={active ? 0 : -1} allow="clipboard-read; clipboard-write; fullscreen"
    onLoad={event => host.attach(item.key, event.currentTarget.contentWindow)} />;
}

export function ServiceWorkspaceHost({ children }: { children: ReactNode }) {
  const host = window.parent === window ? getWorkspaceHost() : undefined;
  const snapshot = useSyncExternalStore(host?.subscribe || subscribeEmpty, host?.snapshot || snapshotEmpty);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.toggleAttribute('inert', snapshot.activeKey !== 'root'); }, [snapshot.activeKey]);
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
    <div ref={root} className="h-full w-full" aria-hidden={snapshot.activeKey !== 'root'}
      style={{ visibility: snapshot.activeKey === 'root' ? 'visible' : 'hidden' }}>{children}</div>
    {snapshot.items.filter(item => item.key !== 'root').map(item => <WorkspaceFrame key={item.key} host={host} item={item} active={snapshot.activeKey === item.key} />)}
  </div>;
}
