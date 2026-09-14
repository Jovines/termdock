import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BellDot, LoaderCircle, MoreHorizontal } from 'lucide-react';
import { openServiceAccess } from '../federation/accessEvents';
import { listServiceConnections, observeServiceConnections, type ServiceConnection } from '../services/serviceDirectory';
import { activateServiceWorkspace, getWorkspaceHost, reportWorkspace, type WorkspaceSnapshot, type WorkspaceAttentionSession } from '../services/workspaceHost';
import { savedConnection, SECURE_STATE_EVENT } from '../federation/browserIntegration';
import type { DesktopServiceActivity } from '../desktop/nativeBridge';

const empty: WorkspaceSnapshot = { activeKey: 'root', items: [] };
const emptySubscribe = () => () => {};
const emptySnapshot = () => empty;
export const OPEN_SAVED_SERVICE_EVENT = 'termdock:open-saved-service';

function compactServiceLabel(service: ServiceConnection, services: ServiceConnection[]): string {
  try {
    const address = new URL(service.serviceOrigin || service.url);
    if (service.label !== address.host && service.label !== address.origin) return service.label;
    // Keep nonstandard ports, and ports that distinguish services on the same host.
    const needsPort = services.some(other => {
      const candidate = new URL(other.serviceOrigin || other.url);
      return candidate.hostname === address.hostname && candidate.port !== address.port;
    });
    return !needsPort && address.port === '9834' ? address.hostname : address.host;
  } catch { return service.label; }
}

export function useServiceWorkspaceActivity(runningCount: number, reviewCount: number, attentionSessions?: readonly WorkspaceAttentionSession[]): void {
  useEffect(() => {
    window.termdockDesktop?.reportServiceActivity?.({ runningCount, reviewCount });
  }, [runningCount, reviewCount]);
  useEffect(() => {
    reportWorkspace({ runningCount, reviewCount, attentionSessions });
  }, [runningCount, reviewCount, attentionSessions]);
}

/** Native desktop already has independent service windows. */
export function ServiceSwitcher() {
  if (window.termdockDesktop) return null;
  return <BrowserServiceSwitcher />;
}

function BrowserServiceSwitcher() {
  const [services, setServices] = useState<ServiceConnection[]>([]);
  const [nativeActivity, setNativeActivity] = useState<DesktopServiceActivity[]>([]);
  const [currentId, setCurrentId] = useState(savedConnection()?.targetPeerId);
  const [error, setError] = useState('');
  const strip = useRef<HTMLElement>(null);
  const host = getWorkspaceHost();
  const workspaces = useSyncExternalStore(host?.subscribe || emptySubscribe, host?.snapshot || emptySnapshot);
  useEffect(() => {
    let disposed = false, revision = 0;
    const refresh = () => {
      const request = ++revision;
      setCurrentId(savedConnection()?.targetPeerId);
      void listServiceConnections().then(items => {
        if (disposed || request !== revision) return;
        try {
          const key = 'termdock-secure-service-order';
          const stored: unknown = JSON.parse(localStorage.getItem(key) || '[]');
          const order = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
          const identity = (item: ServiceConnection) => item.targetPeerId || item.id;
          const nextOrder = [...order.filter(id => items.some(item => identity(item) === id)), ...items.map(identity).filter(id => !order.includes(id))];
          items.sort((a, b) => nextOrder.indexOf(identity(a)) - nextOrder.indexOf(identity(b)));
          const serialized = JSON.stringify(nextOrder);
          if (serialized !== localStorage.getItem(key)) localStorage.setItem(key, serialized);
        } catch { /* Use directory order if preference storage is unavailable. */ }
        setServices(items);
      }).catch(() => {});
    };
    refresh();
    const stop = observeServiceConnections(refresh);
    const stopNative = window.termdockDesktop?.onServiceActivity?.(setNativeActivity);
    window.addEventListener(SECURE_STATE_EVENT, refresh);
    return () => { disposed = true; stop(); stopNative?.(); window.removeEventListener(SECURE_STATE_EVENT, refresh); };
  }, []);
  useEffect(() => {
    const nav = strip.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    // Move only this strip; scrolling ancestors would shift the session list.
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < nav.scrollLeft) nav.scrollLeft = left;
    else if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth;
  }, [currentId, services]);
  const choose = async (service: ServiceConnection) => {
    setError('');
    if (service.targetPeerId && service.targetPeerId === currentId) return;
    try {
      const native = window.termdockDesktop;
      if (native?.openServiceConnection) {
        const result = await native.openServiceConnection(service);
        if (!result.ok) throw new Error(result.error || '暂时无法打开服务');
      } else if (!activateServiceWorkspace(service)) {
        window.dispatchEvent(new CustomEvent(OPEN_SAVED_SERVICE_EVENT, { detail: service }));
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '暂时无法切换服务'); }
  };
  const status = (service: ServiceConnection) => {
    const workspace = workspaces.items.find(item => item.service?.targetPeerId === service.targetPeerId);
    const native = nativeActivity.find(item => (item.targetPeerId && item.targetPeerId === service.targetPeerId) || item.origin === (service.serviceOrigin || service.url));
    return {
      phase: workspace?.phase,
      running: workspace?.runningCount ?? native?.runningCount ?? 0,
      review: workspace?.reviewCount ?? native?.reviewCount ?? 0,
    };
  };
  const badges = (service: ServiceConnection) => {
    const activity = status(service);
    if (activity.review) return <span className="inline-flex shrink-0 items-center gap-0.5 text-[color:var(--warning)]" title="等待处理"><BellDot size={11} />{activity.review}</span>;
    if (activity.phase === 'connecting' || activity.phase === 'reconnecting') return <LoaderCircle size={12} className="shrink-0 animate-spin" aria-label="正在连接" />;
    if (activity.phase === 'offline' || activity.phase === 'login') return <span className="shrink-0 text-[color:var(--warning)]" title={activity.phase === 'login' ? '需要登录' : '连接已断开'}>!</span>;
    if (activity.running) return <span className="shrink-0 text-[color:var(--success)]" title="运行中">{activity.running}</span>;
    return null;
  };
  if (services.length <= 1) return null;
  return <div className="min-w-0 shrink-0 bg-[var(--chrome-bg)] px-3 pb-1 pt-2 md:order-first md:bg-transparent md:pb-0 md:pt-1" data-sidebar-gesture-ignore>
    <div className="flex w-full items-center gap-1 md:gap-0 md:rounded-xl md:bg-surface md:p-1">
    <nav ref={strip} aria-label="切换服务"
      className="relative flex min-w-0 flex-1 gap-0.5 overflow-x-auto overscroll-x-contain md:gap-1 md:rounded-lg [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {services.map(service => <button key={service.id} type="button" onClick={() => void choose(service)}
        aria-current={service.targetPeerId === currentId ? 'page' : undefined} title={service.label}
        className={`inline-flex min-h-11 min-w-0 flex-[1_0_auto] items-center justify-center rounded-lg text-[11px] leading-4 transition-colors motion-reduce:transition-none md:min-h-8 ${services.length > 3 ? 'md:flex-[0_0_30%]' : 'md:flex-[1_1_0%]'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${service.targetPeerId === currentId ? 'font-medium text-foreground md:bg-surface-elevated' : 'text-muted-foreground hover:bg-surface hover:text-foreground md:hover:bg-surface-2'}`}>
        <span className={`inline-flex min-w-0 items-center justify-center gap-1 rounded-lg px-2 py-1.5 ${service.targetPeerId === currentId ? 'bg-surface-elevated md:bg-transparent' : ''}`}>
          <span className="max-w-[11rem] truncate md:hidden">{compactServiceLabel(service, services)}</span>
          <span className="hidden truncate md:inline">{service.label}</span>{badges(service)}
        </span>
      </button>)}
    </nav>
    <button type="button" onClick={openServiceAccess} aria-label="管理服务" title="管理服务"
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary md:hidden">
      <MoreHorizontal size={18} />
    </button>
    </div>
    {error && <p role="alert" className="mt-1 text-[11px] text-[color:var(--warning)]">{error}</p>}
  </div>;
}
