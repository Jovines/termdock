import { parseSavedService, readBrowserServices, type ServiceConnection } from './serviceDirectory';

export const WORKSPACE_QUERY = 'termdock-workspace';
export const WORKSPACE_VISIBILITY_EVENT = 'termdock:workspace-visibility';
export const WORKSPACE_ACTIVATE_EVENT = 'termdock:workspace-activate';
export type WorkspacePhase = 'connecting' | 'ready' | 'reconnecting' | 'offline' | 'login';
export interface ServiceWorkspace {
  key: string;
  service?: ServiceConnection;
  phase: WorkspacePhase;
  runningCount: number;
  reviewCount: number;
  touchedAt: number;
}
export interface WorkspaceSnapshot { activeKey: string; items: readonly ServiceWorkspace[] }
export interface WorkspaceHost {
  snapshot(): WorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
  activate(service: ServiceConnection, keepSidebar?: boolean): boolean;
  report(key: string, data: Partial<Pick<ServiceWorkspace, 'service' | 'phase' | 'runningCount' | 'reviewCount'>>): void;
  attach(key: string, view: Window | null): void;
  focusSession(serviceId: string, sessionId: string): boolean;
}
declare global { interface Window { __termdockWorkspaceHost?: WorkspaceHost } }

export function workspaceKey(): string {
  return window.parent !== window && location.pathname === '/workspace.html'
    ? new URLSearchParams(location.search).get(WORKSPACE_QUERY) || 'root' : 'root';
}
let parentHost: WorkspaceHost | undefined, parentProxy: WorkspaceHost | undefined;
export function getWorkspaceHost(): WorkspaceHost | undefined {
  try {
    if (window.parent === window) return window.__termdockWorkspaceHost;
    const host = window.parent.__termdockWorkspaceHost;
    if (host && host !== parentHost) {
      parentHost = host;
      parentProxy = { ...host, subscribe(listener) {
        const unsubscribe = host.subscribe(listener);
        const leaving = (event: PageTransitionEvent) => { if (!event.persisted) unsubscribe(); };
        window.addEventListener('pagehide', leaving);
        return () => { unsubscribe(); window.removeEventListener('pagehide', leaving); };
      } };
    }
    return host ? parentProxy : undefined;
  }
  catch { return undefined; }
}
export function isWorkspaceActive(): boolean {
  const host = getWorkspaceHost();
  return !host || host.snapshot().activeKey === workspaceKey();
}
export function activateServiceWorkspace(service: ServiceConnection, keepSidebar = true): boolean {
  return getWorkspaceHost()?.activate(service, keepSidebar) ?? false;
}
export function reportWorkspace(data: Parameters<WorkspaceHost['report']>[1]): void {
  getWorkspaceHost()?.report(workspaceKey(), data);
}
const PENDING_SESSION = 'termdock-secure-workspace-session:';
export function consumeWorkspaceSession(serviceId: string | undefined): string | undefined {
  if (!serviceId) return;
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_SESSION + serviceId) || 'null');
    localStorage.removeItem(PENDING_SESSION + serviceId);
    return value && typeof value.sessionId === 'string' && Date.now() - value.at < 60_000 ? value.sessionId : undefined;
  } catch { return undefined; }
}

/** The PWA's existing document is the first workspace. Other workspaces load
 * only our same-origin application shell, each with its own JS/storage scope.
 * No remote page, native credential or private key is passed to this host. */
export function installWorkspaceHost(initial?: ServiceConnection): WorkspaceHost | undefined {
  if (window.parent !== window || window.termdockDesktop) return undefined;
  if (window.__termdockWorkspaceHost) return window.__termdockWorkspaceHost;
  let state: WorkspaceSnapshot = { activeKey: 'root', items: [{ key: 'root', service: initial, phase: 'connecting', runningCount: 0, reviewCount: 0, touchedAt: Date.now() }] };
  try {
    const lastId = sessionStorage.getItem('termdock-secure-last-workspace');
    const last = initial && lastId !== initial.targetPeerId ? readBrowserServices().find(item => item.targetPeerId === lastId) : undefined;
    if (last?.targetPeerId) state = { activeKey: last.targetPeerId, items: [...state.items, { key: last.targetPeerId, service: last, phase: 'connecting', runningCount: 0, reviewCount: 0, touchedAt: Date.now() }] };
  } catch { /* Restore only the entry when optional storage is unavailable. */ }
  const listeners = new Set<() => void>();
  const views = new Map<string, Window>([['root', window]]);
  const pendingSidebar = new Set<string>();
  const emit = () => { for (const listener of [...listeners]) listener(); };
  const visibility = (key: string, view: Window) => {
    try {
      const event = view.document.createEvent('CustomEvent'); event.initCustomEvent(WORKSPACE_VISIBILITY_EVENT, false, false, { active: state.activeKey === key });
      view.dispatchEvent(event);
      if (state.activeKey === key) {
        const resize = view.document.createEvent('Event'); resize.initEvent('resize', false, false); view.dispatchEvent(resize);
        if (pendingSidebar.delete(key)) {
          const activate = view.document.createEvent('Event'); activate.initEvent(WORKSPACE_ACTIVATE_EVENT, false, false); view.dispatchEvent(activate);
        }
      } else {
        (view.document.activeElement as HTMLElement | null)?.blur?.();
      }
    } catch { /* A document may be between navigation and initialization. */ }
  };
  const host: WorkspaceHost = {
    snapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate(input, keepSidebar = true) {
      const service = parseSavedService(input);
      if (!service?.targetPeerId) return false;
      const existing = state.items.find(item => item.service?.targetPeerId === service.targetPeerId);
      const key = existing?.key || service.targetPeerId;
      const next: ServiceWorkspace = existing ? { ...existing, service, touchedAt: Date.now() }
        : { key, service, phase: 'connecting', runningCount: 0, reviewCount: 0, touchedAt: Date.now() };
      state = { activeKey: key, items: existing ? state.items.map(item => item === existing ? next : item) : [...state.items, next] };
      try { sessionStorage.setItem('termdock-secure-last-workspace', service.targetPeerId); } catch { /* Optional restore. */ }
      if (keepSidebar) pendingSidebar.add(key);
      emit();
      for (const [id, view] of views) visibility(id, view);
      return true;
    },
    report(key, data) {
      const previous = state.items.find(item => item.key === key);
      if (!previous) return;
      if (data.service && previous.service?.targetPeerId && data.service.targetPeerId !== previous.service.targetPeerId) return;
      const next = { ...previous, ...data };
      if (JSON.stringify(next) === JSON.stringify(previous)) return;
      state = { ...state, items: state.items.map(item => item === previous ? next : item) }; emit();
    },
    attach(key, view) { if (view) { views.set(key, view); visibility(key, view); } else views.delete(key); },
    focusSession(serviceId, sessionId) {
      const service = readBrowserServices().find(item => item.targetPeerId === serviceId);
      if (!service) return false;
      try { localStorage.setItem(PENDING_SESSION + serviceId, JSON.stringify({ sessionId, at: Date.now() })); } catch { return false; }
      host.activate(service, false);
      const view = views.get(state.activeKey);
      if (view) {
        const event = view.document.createEvent('CustomEvent'); event.initCustomEvent('termdock:workspace-session', false, false, null); view.dispatchEvent(event);
      }
      return true;
    },
  };
  window.__termdockWorkspaceHost = host;
  return host;
}
