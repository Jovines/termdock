import { CollaborationFederation, type FederationService } from '../../../desktop/collaborationFederation';
import { getActiveClient, openAuthorizedServiceClient, savedConnection } from '../federation/browserIntegration';
import type { SecureClient } from '../federation/secureClient';
import { readBrowserServices, type ServiceConnection } from '../services/serviceDirectory';
import type { CollaborationGroup, CollaborationGroupInput } from '../terminal/api';
import type { CollaborationPeers } from './directory';

interface BrowserCollaboration {
  peers(origin: string): Promise<CollaborationPeers>;
  save(origin: string, input: CollaborationGroupInput): Promise<{ group: CollaborationGroup }>;
}
declare global { interface Window { __termdockCollaboration?: BrowserCollaboration } }

function waitForClient(pending: Promise<SecureClient>, signal: AbortSignal): Promise<SecureClient> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One relay for all retained workspaces. Each destination has its own pinned
 * encrypted client; no cookies, credentials, or active target are switched. */
export function installBrowserCollaboration(): BrowserCollaboration | undefined {
  if (window.termdockDesktop || window.parent !== window) return;
  if (window.__termdockCollaboration) return window.__termdockCollaboration;
  const clients = new Map<string, Promise<SecureClient>>();
  let services: FederationService[] = [];
  let stopped = false;

  const clientFor = (service: ServiceConnection): Promise<SecureClient> => {
    const id = service.targetPeerId!;
    if (savedConnection()?.targetPeerId === id) return getActiveClient();
    const existing = clients.get(id);
    if (existing) return existing.then(client => {
      if (!client.closed) return client;
      if (clients.get(id) === existing) clients.delete(id);
      return clientFor(service);
    });
    const pending = openAuthorizedServiceClient({ ...service, targetPeerId: id }, AbortSignal.timeout(12_000))
      .then(client => {
        if (stopped || clients.get(id) !== pending) { client.close(); throw new Error('服务连接已移除'); }
        return client;
      }).catch(error => {
        if (clients.get(id) === pending) clients.delete(id);
        throw error;
      });
    clients.set(id, pending);
    return pending;
  };
  const refreshServices = () => {
    const current = savedConnection();
    const directory = readBrowserServices();
    if (current && !directory.some(service => service.targetPeerId === current.targetPeerId)) {
      directory.push({ ...current, id: current.targetPeerId, label: current.serviceName || current.serviceOrigin || current.url });
    }
    const ids = new Set(directory.map(service => service.targetPeerId));
    for (const [id, pending] of clients) if (!ids.has(id)) {
      clients.delete(id); void pending.then(client => client.close()).catch(() => {});
    }
    services = directory.filter(service => !!service.targetPeerId).map(service => ({
      origin: service.serviceOrigin || service.url,
      label: service.label,
      request: async (path, method = 'GET', body) => {
        // The shared protocol can access only collaboration operations.
        if (!/^\/collaboration-(?:federation|groups)(?:\/[^?#]*)?$/.test(path)) throw new Error('无效的协作请求');
        const signal = AbortSignal.timeout(18_000);
        const client = await waitForClient(clientFor(service), signal);
        const headers = new Headers({ 'Content-Type': 'application/json' });
        if (method !== 'GET' && method !== 'HEAD') {
          const tokenResponse = await client.fetch('/api/csrf-token', { signal });
          if (!tokenResponse.ok) throw new Error('无法读取目标服务的请求令牌');
          const token = await tokenResponse.json();
          if (typeof token.csrfToken !== 'string') throw new Error('目标服务的请求令牌无效');
          headers.set('X-XSRF-TOKEN', token.csrfToken);
        }
        const response = await client.fetch(`/api/terminal/operations${path}`, {
          method, headers, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const payload = response.status === 204 ? undefined : await response.json();
        if (!response.ok) throw new Error(payload?.error || '服务不可达或未授权协作访问');
        return payload;
      },
    }));
  };
  const federation = new CollaborationFederation(() => services);
  const bridge: BrowserCollaboration = {
    peers: origin => { refreshServices(); return federation.peers(origin); },
    save: async (origin, input) => {
      refreshServices();
      const result = await federation.save(origin, input) as { group: CollaborationGroup };
      void synchronize();
      return result;
    },
  };
  const synchronize = async () => {
    if (stopped || document.hidden || !navigator.onLine || !savedConnection()) return;
    refreshServices();
    if (services.length < 2) return;
    await federation.refresh().catch(() => {});
  };
  window.__termdockCollaboration = bridge;
  const timer = window.setInterval(() => void synchronize(), 2000);
  document.addEventListener('visibilitychange', synchronize);
  window.addEventListener('online', synchronize);
  window.addEventListener('pageshow', synchronize);
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    stopped = true; clearInterval(timer);
    for (const pending of clients.values()) void pending.then(client => client.close()).catch(() => {});
    clients.clear();
  });
  void synchronize();
  return bridge;
}

export function browserCollaboration(): BrowserCollaboration | undefined {
  if (window.termdockDesktop) return;
  try {
    if (window.parent === window) return installBrowserCollaboration();
    if (location.pathname === '/workspace.html' && window.parent.location.origin === location.origin) {
      return window.parent.__termdockCollaboration;
    }
  } catch { /* Opaque previews cannot participate in the application relay. */ }
}
