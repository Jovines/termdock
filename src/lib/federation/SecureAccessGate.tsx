import { LoaderCircle, Terminal } from 'lucide-react';
import { listServiceConnections, saveServiceConnection, normalizeServiceAddress, type ServiceConnection } from '../services/serviceDirectory';
import { readDeviceProfile } from './readDeviceProfile';
import { currentConnectionPath, currentEntryClient } from './browserIntegration';
import type { DeviceProfile } from '../../server/federation/deviceProfile';
import { defaultDeviceName } from './deviceName';
import { useEffect, useState, type ReactNode } from 'react';
import FederationAccess, { type FederationGrant, type FederationInviteInput } from '../../components/FederationAccess';
import { connectDevice, connectionRoutes, connectionAddresses, createEntryInvitation, authenticateKnownConnection, preferDirectConnection, connectServiceAddress, connectOpenService, currentSecureClient, getActiveClient, getIdentity, invalidateSecureTransport, savedConnection, SECURE_STATE_EVENT, type ConnectionIntent } from './browserIntegration';
import { createInviteLink, parseInviteLink } from './inviteLink';
import { SessionAccessView } from './SessionAccessView';
import { LoginScreen } from '../components/auth/LoginScreen';
import { OPEN_SERVICE_ACCESS_EVENT } from './accessEvents';
import { DeviceAuthorizationRequired, readDeviceAuthorization } from './deviceAuthorization';
import { IS_WORKSPACE_DOCUMENT } from './clientScope';
import { ServiceSwitcher, OPEN_SAVED_SERVICE_EVENT } from '../components/ServiceSwitcher';
import { activateServiceWorkspace, getWorkspaceHost, isWorkspaceActive, reportWorkspace, workspaceKey, WORKSPACE_VISIBILITY_EVENT, WORKSPACE_ACTIVATE_EVENT } from '../services/workspaceHost';
import { useSidebarStore } from '../stores/useSidebarStore';


// Keep the invitation in memory and remove its secret from browser history immediately.
const initialInvitation = (() => {
  if (!location.hash.startsWith('#termdock-invite=')) return undefined;
  try { return parseInviteLink(location.href); }
  catch { return undefined; }
  finally { history.replaceState(null, '', location.pathname + location.search); }
})();
const OPEN_SESSION_KEY = 'termdock-secure-open-session';
let localPairing: Promise<unknown> | undefined;
let nativeConnection: ReturnType<NonNullable<NonNullable<Window['termdockDesktop']>['getServiceConnection']>> | undefined;
function pendingSession(): string | undefined {
  try { const value = JSON.parse(sessionStorage.getItem(OPEN_SESSION_KEY) ?? 'null'); return value?.serviceId === savedConnection()?.targetPeerId ? value.sessionId : undefined; } catch { return undefined; }
}

export function SecureAccessGate({ children }: { children: ReactNode }) {
  const [incomingInvitation, setIncomingInvitation] = useState(initialInvitation);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(!!initialInvitation);
  const [checking, setChecking] = useState(!initialInvitation);
  const [error, setError] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState('正在连接服务…');
  const [grants, setGrants] = useState<FederationGrant[]>([]);
  const [sessions, setSessions] = useState<{ sessionId: string; name: string }[]>([]);
  const [fullService, setFullService] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [deviceIdentity, setDeviceIdentity] = useState('');
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [accessError, setAccessError] = useState('');
  const [serviceName, setServiceName] = useState(savedConnection()?.serviceName ?? location.hostname);
  const [remoteSession, setRemoteSession] = useState<string | undefined>(pendingSession);
  useEffect(() => { void getIdentity().then(identity => setDeviceIdentity(identity.peerId)).catch(() => setError(true)); }, []);
  useEffect(() => {
    const handler = (event: Event) => {
      const { origin, sessionId } = (event as CustomEvent<{ origin: string; sessionId: string }>).detail;
      try {
        const connections = JSON.parse(localStorage.getItem('termdock.federation.connections.v1') ?? '[]') as ConnectionIntent[];
        const connection = connections.find(item => connectionAddresses(item).some(address => new URL(address).origin === new URL(origin).origin));
        if (!connection) { setOpen(true); return; }
        if (getWorkspaceHost()?.focusSession(connection.targetPeerId, sessionId)) return;
        sessionStorage.setItem(OPEN_SESSION_KEY, JSON.stringify({ serviceId: connection.targetPeerId, sessionId }));
        void connectDevice(connection).then(() => { setRemoteSession(sessionId); setReady(true); }).catch(() => { setError(true); setOpen(true); });
      } catch { setOpen(true); }
    };
    window.addEventListener('termdock:open-remote-session', handler);
    return () => window.removeEventListener('termdock:open-remote-session', handler);
  }, []);
  const readPermissions = async (timeoutMs = 5000) => {
    const client = await getActiveClient();
    const permissions = await readDeviceAuthorization(client, { timeoutMs });
    const path = currentConnectionPath();
    const entryId = currentEntryClient()?.targetPeerId;
    void Promise.all([readDeviceProfile(), listServiceConnections()]).then(([profile, directory]) => {
      const entry = directory.find(service => service.targetPeerId === entryId);
      const route = path === 'relay' ? `经 ${entry?.label || entryId?.slice(-12) || '入口服务'} 中转` : '直连';
      return client.request({ type: 'device-name', name: defaultDeviceName(), onlyIfMissing: true, profile: { ...profile, route } });
    }).catch(() => {});
    setFullService(permissions.fullService);
    setCanManage(permissions.canManage);
    setReady(true); setChecking(false); setError(false);
    const selected = savedConnection();
    reportWorkspace({ phase: 'ready', ...(selected ? { service: { ...selected, id: selected.targetPeerId, label: selected.serviceName || location.host } } : {}) });
    if (isWorkspaceActive()) void preferDirectConnection();
  };
  useEffect(() => {
    let stopped = false, pending = false, failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const verify = async () => {
      if (stopped || pending) return;
      if (failures && (document.hidden || !isWorkspaceActive())) return;
      if (!navigator.onLine) {
        setChecking(true); setError(true); setConnectionMessage('网络已断开，恢复后会自动连接'); reportWorkspace({ phase: 'offline' }); return;
      }
      pending = true; clearTimeout(retry);
      const started = performance.now();
      const previous = currentSecureClient();
      try {
        if (IS_WORKSPACE_DOCUMENT && !savedConnection()) throw new Error('工作区的服务记录已移除，请重新添加服务。');
        nativeConnection ??= window.termdockDesktop?.getServiceConnection?.();
        const native = await nativeConnection;
        if (native?.invitation) { setIncomingInvitation(parseInviteLink(native.invitation)); setOpen(true); setChecking(false); return; }
        if (!savedConnection()) {
          if (incomingInvitation) { setChecking(false); return; }
          localPairing ??= (async () => {
            if (native?.targetPeerId) { await connectDevice({ ...native, targetPeerId: native.targetPeerId, serviceName: native.label }); return; }
            const invite = await window.termdockDesktop?.getLocalInvite?.();
            if (invite) await connectDevice(invite);
            else await connectOpenService();
          })();
          await localPairing;
          if (!savedConnection()) { if (!stopped) { setReady(false); setChecking(false); setError(false); } return; }
        }
        if (!stopped) await readPermissions(previous?.canSwitchTransport ? 2500 : 5000);
        failures = 0;
        performance.measure('termdock:connection-ready', { start: started, end: performance.now() });
      } catch (failure) {
        if (stopped) return;
        if (failure instanceof DeviceAuthorizationRequired) {
          setReady(false); setChecking(false); setOpen(false); setError(false); reportWorkspace({ phase: 'login' });
        } else {
          // Keep an already mounted terminal intact across sleep, Wi-Fi changes,
          // or a server restart. A socket is not the device's authorization.
          // A failed permission read can leave a half-open socket looking live.
          // Retire only that transport, never a newer replacement.
          if (previous && currentSecureClient() === previous) invalidateSecureTransport();
          setError(true); setChecking(true); localPairing = undefined;
          setConnectionMessage('连接暂未恢复，正在重试…');
          reportWorkspace({ phase: 'reconnecting' });
          failures++;
          retry = setTimeout(() => void verify(), Math.min(5000, 300 * 2 ** Math.min(failures - 1, 5)));
          console.debug('[connection] retry', { elapsedMs: Math.round(performance.now() - started), attempt: failures, reason: failure instanceof Error ? failure.message : 'unknown' });
        }
      } finally { pending = false; }
    };
    // Visibility and network events request a bounded health check. They do not
    // tear down a healthy channel or interrupt an upload simply for being old.
    const visible = () => { if (document.visibilityState === 'visible' && isWorkspaceActive()) void verify(); };
    const visibilityChanged = visible;
    const online = () => { failures = 0; visible(); };
    const activate = () => { useSidebarStore.getState().openLeft(); visible(); };
    window.addEventListener(WORKSPACE_VISIBILITY_EVENT, visible);
    window.addEventListener(WORKSPACE_ACTIVATE_EVENT, activate);
    if (IS_WORKSPACE_DOCUMENT) useSidebarStore.getState().openLeft();
    getWorkspaceHost()?.attach(workspaceKey(), window);
    void verify();
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('focus', visible);
    window.addEventListener('online', online);
    const network = (navigator as Navigator & { connection?: EventTarget }).connection;
    network?.addEventListener('change', online);
    window.addEventListener('auth:unauthorized', visible);
    window.addEventListener(SECURE_STATE_EVENT, visible);
    const timer = setInterval(visible, 30_000);
    return () => {
      stopped = true; clearTimeout(retry); clearInterval(timer);
      window.removeEventListener(WORKSPACE_VISIBILITY_EVENT, visible);
      window.removeEventListener(WORKSPACE_ACTIVATE_EVENT, activate);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('focus', visible);
      window.removeEventListener('online', online);
      network?.removeEventListener('change', online);
      window.removeEventListener('auth:unauthorized', visible);
      window.removeEventListener(SECURE_STATE_EVENT, visible);
    };
  }, []);
  const refresh = async () => {
    const client = currentSecureClient(); if (!client) return;
    setLoadingAccess(true); setAccessError('');
    try {
      const result = await client.request({ type: 'session-list' }); setSessions(result.items as {sessionId: string; name: string}[]);
    } catch { setAccessError('暂时无法读取终端列表，请重试。'); }
    try {
      if (canManage) {
        const result = await client.request({ type: 'grants-list' });
        const labels = (result.subjectLabels ?? {}) as Record<string, string>;
        const access = await client.request({ type: 'route-access' });
        const directory = await listServiceConnections();
        const routeGrants: FederationGrant[] = (Array.isArray(access.grants) ? access.grants as import('./browserIntegration').EntryRouteGrant[] : []).map(grant => ({ id: `route:${grant.id}`, subjectId: grant.subjectId, scope: { kind: 'service' }, actions: ['route.use'], routeTargetServiceId: grant.targetServiceId, routeTargetName: directory.find(service => service.targetPeerId === grant.targetServiceId)?.label || '指定服务', ...(grant.active ? {} : { revokedAt: grant.revokedAt ?? 0 }) }));
        setGrants([...(result.grants as FederationGrant[]), ...routeGrants].map(grant => ({ ...grant, label: labels[grant.subjectId], deviceProfile: (result.deviceProfiles as Record<string, DeviceProfile> | undefined)?.[grant.subjectId] })));
      } else {
        const result = await client.request({ type: 'permissions' });
        setGrants((result.grants ?? []) as FederationGrant[]);
      }
    } catch { setAccessError('暂时无法读取设备权限，请重试。'); }
    finally { setLoadingAccess(false); }
  };
  useEffect(() => {
    const show = () => { setOpen(true); if (ready) void refresh(); };
    window.addEventListener(OPEN_SERVICE_ACCESS_EVENT, show);
    return () => window.removeEventListener(OPEN_SERVICE_ACCESS_EVENT, show);
  }, [ready, canManage]);
  const connect = async (intent: ConnectionIntent) => {
    if (!intent.pairingCode && !intent.routeCode && savedConnection()?.targetPeerId !== intent.targetPeerId && getWorkspaceHost()) {
      const service = { ...intent, id: intent.targetPeerId, label: intent.serviceName || new URL(intent.serviceOrigin || intent.url).host };
      await saveServiceConnection(service);
      if (activateServiceWorkspace(service)) { setOpen(false); return; }
    }
    await connectDevice(intent);
    if (nativeConnection) nativeConnection = nativeConnection.then(value => value ? { ...value, invitation: undefined } : null);
    setIncomingInvitation(undefined);
    setRemoteSession(undefined); sessionStorage.removeItem(OPEN_SESSION_KEY);
    setServiceName(intent.serviceName ?? new URL(intent.url).hostname);
    await readPermissions(); setOpen(false); setError(false);
  };
  const openService = async (service: ServiceConnection) => {
    const desktop = window.termdockDesktop;
    if (desktop?.openServiceConnection) {
      const result = await desktop.openServiceConnection(service);
      if (!result.ok) throw new Error(result.error || '暂时无法打开这台服务。');
      setOpen(false); return;
    }
    if (activateServiceWorkspace(service)) { setOpen(false); return; }
    if (service.targetPeerId) try { await connect({ ...service, targetPeerId: service.targetPeerId, serviceName: service.label }); return; }
    catch (error) { if (!(error instanceof DeviceAuthorizationRequired)) throw error; }
    return connectServiceAddress(service.serviceOrigin || service.url);
  };
  useEffect(() => {
    const openSaved = (event: Event) => {
      void openService((event as CustomEvent<ServiceConnection>).detail).catch(failure => {
        setOpen(true); setAccessError(failure instanceof Error ? failure.message : '暂时无法打开服务');
      });
    };
    window.addEventListener(OPEN_SAVED_SERVICE_EVENT, openSaved);
    return () => window.removeEventListener(OPEN_SAVED_SERVICE_EVENT, openSaved);
  });
  const addService = async (input: string, password?: string) => {
    if (input.includes('#termdock-invite=')) {
      const connection = parseInviteLink(input);
      if (window.termdockDesktop?.openServiceConnection) {
        const result = await window.termdockDesktop.openServiceConnection({ id: connection.targetPeerId, url: connection.url, label: connection.serviceName || new URL(connection.serviceOrigin || connection.url).host, targetPeerId: connection.targetPeerId, serviceOrigin: connection.serviceOrigin, entryServiceId: connection.entryServiceId }, input);
        if (!result.ok) throw new Error(result.error || '暂时无法打开邀请。');
        setOpen(false); return;
      }
      if (password !== undefined && connection.routeOnly) { await authenticateKnownConnection(connection, password); await readPermissions(); setOpen(false); return; }
      try { await connect(connection); } catch (error) { if (connection.routeOnly && error instanceof DeviceAuthorizationRequired) return { passwordRequired: true }; throw error; }
      return;
    }
    const url = normalizeServiceAddress(input);
    if (window.termdockDesktop?.openServiceConnection) return openService({ id: url, url, label: new URL(url).host });
    return connectServiceAddress(url, password);
  };
  const invite = async (input: FederationInviteInput) => {
    const client = await getActiveClient();
    const { includeBackup = true, ...grantInput } = input;
    const selected = savedConnection();
    const backups = selected ? connectionRoutes(selected) : [];
    let backup: { url: string; targetPeerId: string; routeCode: string } | undefined;
    if (includeBackup && backups.length) {
      for (const route of backups) try {
        const invitation = await createEntryInvitation({ ...selected!, targetPeerId: client.targetPeerId }, route);
        backup = { ...route, routeCode: invitation.routeCode }; break;
      } catch { /* Only an entry administrator can delegate that entry. */ }
      if (!backup) throw new Error('无法分享备用连接：需要入口管理员授权。也可以关闭此选项，生成直接连接邀请。');
    }
    let targetUrl = selected?.serviceOrigin || location.origin;
    if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(targetUrl).hostname)) {
      const response = await client.fetch('/api/terminal/settings');
      const settings = await response.json();
      if (typeof settings.localAccess?.url === 'string') targetUrl = settings.localAccess.url;
    }
    const result = await client.request({ type: 'invite-create', ...grantInput });
    if (typeof result.code !== 'string' || typeof result.expiresAt !== 'number') throw new Error('暂时无法生成邀请。');
    return { url: createInviteLink({ v: 1, serviceId: client.targetPeerId, code: result.code, entryUrl: backup?.url || targetUrl, serviceUrl: targetUrl, name: serviceName, entryServiceId: backup?.targetPeerId, routeCode: backup?.routeCode }), expiresAt: result.expiresAt };
  };
  return <>
    {ready ? fullService && !remoteSession ? children : <SessionAccessView client={currentSecureClient()!} initialSessionId={remoteSession} /> : checking ? <div className="flex h-full min-h-0 flex-col items-center justify-center bg-[var(--chrome-bg)] px-6 text-foreground">
      <div className="flex w-full max-w-xs flex-col items-center text-center">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-muted-foreground" aria-hidden="true">
          <Terminal size={24} strokeWidth={1.5} />
        </div>
        <h1 className="max-w-full truncate text-base font-medium tracking-tight" title={serviceName}>{serviceName}</h1>
        <div role="status" className="mt-2 flex max-w-full items-center justify-center gap-2 text-xs leading-5 text-muted-foreground">
          {!error && <LoaderCircle size={13} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          <span>{connectionMessage}</span>
        </div>
        {error && <p className="mt-2 text-xs leading-5 text-muted-foreground">登录信息已保留</p>}
        <button type="button" className="mt-6 min-h-11 rounded-lg px-4 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setOpen(true)}>管理服务</button>
      </div>
    </div> : <><div className="fixed left-0 right-0 top-[var(--safe-top-inset)] z-chrome sm:right-auto sm:w-72"><ServiceSwitcher /></div><LoginScreen onLoginSuccess={() => { void readPermissions().catch(() => setError(true)); }} /></>}
    {open && <FederationAccess onConnect={connect} onClose={() => setOpen(false)} onAddService={addService} onOpenService={openService} onConnectWithPassword={async (connection, password) => { await authenticateKnownConnection(connection, password); await readPermissions(); setOpen(false); }} paired={ready || !!savedConnection()} initialInvite={incomingInvitation} currentServiceName={serviceName} currentServiceId={currentSecureClient()?.targetPeerId || savedConnection()?.targetPeerId} currentServiceOrigin={savedConnection()?.serviceOrigin} currentIdentity={deviceIdentity} grants={grants} sessions={sessions} loading={loadingAccess} loadError={accessError} onRetry={() => void refresh()}
      onRename={async (subjectId, name) => { await (await getActiveClient()).request({ type: 'device-name', subjectId, name }); await refresh(); }}
      hasBackup={!!savedConnection() && connectionRoutes(savedConnection()!).length > 0} onCreateInvite={canManage ? invite : undefined}
      onRevoke={canManage ? async grantId => { await (await getActiveClient()).request(grantId.startsWith('route:') ? { type: 'route-revoke', grantId: grantId.slice(6) } : { type: 'revoke', grantId }); await refresh(); } : undefined} />}
  </>;
}
