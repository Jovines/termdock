import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BellDot, LoaderCircle } from 'lucide-react';
import { listServiceConnections, observeServiceConnections, type ServiceConnection } from '../services/serviceDirectory';
import { activateServiceWorkspace, getWorkspaceHost, reportWorkspace, type WorkspaceSnapshot } from '../services/workspaceHost';
import { savedConnection, SECURE_STATE_EVENT } from '../federation/browserIntegration';
import type { DesktopServiceActivity } from '../desktop/nativeBridge';

const empty: WorkspaceSnapshot = { activeKey: 'root', items: [] };
const emptySubscribe = () => () => {};
const emptySnapshot = () => empty;
export const OPEN_SAVED_SERVICE_EVENT = 'termdock:open-saved-service';

export function useServiceWorkspaceActivity(runningCount: number, reviewCount: number): void {
  useEffect(() => {
    window.termdockDesktop?.reportServiceActivity?.({ runningCount, reviewCount });
    reportWorkspace({ runningCount, reviewCount });
  }, [runningCount, reviewCount]);
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
  return <div className="min-w-0 shrink-0 px-2 py-2" data-sidebar-gesture-ignore>
    <nav ref={strip} aria-label="切换服务"
      className="relative flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain rounded-lg [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {services.map(service => <button key={service.id} type="button" onClick={() => void choose(service)}
        aria-current={service.targetPeerId === currentId ? 'page' : undefined} title={service.label}
        style={{ flex: services.length > 3 ? '0 0 30%' : '1 1 0%' }}
        className={`inline-flex min-h-10 min-w-0 items-center justify-center gap-1 rounded-lg px-2 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${service.targetPeerId === currentId ? 'bg-surface-elevated font-semibold text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
        <span className="truncate">{service.label}</span>{badges(service)}
      </button>)}
    </nav>
    {error && <p role="alert" className="mt-1 text-[11px] text-[color:var(--warning)]">{error}</p>}
  </div>;
}
