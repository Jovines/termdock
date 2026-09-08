import { listServiceConnections, normalizeServiceAddress, type ServiceConnection } from '../services/serviceDirectory';
import { defaultDeviceName } from './deviceName';
import { useEffect, useState, type ReactNode } from 'react';
import FederationAccess, { type FederationGrant, type FederationInviteInput } from '../../components/FederationAccess';
import { connectDevice, connectionRoutes, createEntryInvitation, authenticateKnownConnection, preferDirectConnection, connectServiceAddress, connectOpenService, currentSecureClient, getActiveClient, getIdentity, invalidateSecureTransport, savedConnection, SECURE_STATE_EVENT, type ConnectionIntent } from './browserIntegration';
import { createInviteLink, parseInviteLink } from './inviteLink';
import { SessionAccessView } from './SessionAccessView';
import { LoginScreen } from '../components/auth/LoginScreen';
import { OPEN_SERVICE_ACCESS_EVENT } from './accessEvents';
import { DeviceAuthorizationRequired, readDeviceAuthorization } from './deviceAuthorization';

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
        const connection = connections.find(item => new URL(item.serviceOrigin ?? item.url).host === new URL(origin).host);
        if (!connection) { setOpen(true); return; }
        sessionStorage.setItem(OPEN_SESSION_KEY, JSON.stringify({ serviceId: connection.targetPeerId, sessionId }));
        void connectDevice(connection).then(() => { setRemoteSession(sessionId); setReady(true); }).catch(() => { setError(true); setOpen(true); });
      } catch { setOpen(true); }
    };
    window.addEventListener('termdock:open-remote-session', handler);
    return () => window.removeEventListener('termdock:open-remote-session', handler);
  }, []);
  const readPermissions = async () => {
    const client = await getActiveClient();
    const permissions = await readDeviceAuthorization(client);
    void client.request({ type: 'device-name', name: defaultDeviceName(), onlyIfMissing: true }).catch(() => {});
    setFullService(permissions.fullService);
    setCanManage(permissions.canManage);
    setReady(true); setChecking(false); setError(false);
    void preferDirectConnection();
  };
  useEffect(() => {
    let stopped = false, pending = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const verify = async () => {
      if (stopped || pending) return;
      pending = true; clearTimeout(retry);
      try {
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
        if (!stopped) await readPermissions();
      } catch (failure) {
        if (stopped) return;
        if (failure instanceof DeviceAuthorizationRequired) {
          setReady(false); setChecking(false); setOpen(false); setError(false);
        } else {
          // Keep an already mounted terminal intact across sleep, Wi-Fi changes,
          // or a server restart. A socket is not the device's authorization.
          setError(true); setChecking(true); localPairing = undefined;
          retry = setTimeout(() => void verify(), 3000);
        }
      } finally { pending = false; }
    };
    let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : undefined;
    const visible = () => { if (document.visibilityState === 'visible') void verify(); };
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt !== undefined && Date.now() - hiddenAt >= 15_000) invalidateSecureTransport();
      hiddenAt = undefined; visible();
    };
    const online = () => { invalidateSecureTransport(); visible(); };
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
        setGrants([...(result.grants as FederationGrant[]), ...routeGrants].map(grant => ({ ...grant, label: labels[grant.subjectId] })));
      } else {
        const result = await client.request({ type: 'permissions' });
        setGrants((result.grants ?? []) as FederationGrant[]);
      }
    } catch { setAccessError('暂时无法读取设备权限，请重试。'); }
    finally { setLoadingAccess(false); }
  };
  useEffect(() => {
    if (!ready) return;
    const show = () => { setOpen(true); void refresh(); };
    window.addEventListener(OPEN_SERVICE_ACCESS_EVENT, show);
    return () => window.removeEventListener(OPEN_SERVICE_ACCESS_EVENT, show);
  }, [ready, canManage]);
  const connect = async (intent: ConnectionIntent) => {
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
    if (service.targetPeerId) try { await connect({ ...service, targetPeerId: service.targetPeerId, serviceName: service.label }); return; }
    catch (error) { if (!(error instanceof DeviceAuthorizationRequired)) throw error; }
    return connectServiceAddress(service.serviceOrigin || service.url);
  };
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
    {ready ? fullService && !remoteSession ? children : <SessionAccessView client={currentSecureClient()!} initialSessionId={remoteSession} /> : checking ? <div className="termdock-boot" role="status"><div className="termdock-boot-spinner" aria-hidden="true" /><span>{error ? '正在重新连接，登录信息已保留…' : 'Loading Termdock'}</span>{error && <button type="button" className="mt-4 rounded-lg border border-border px-4 py-2 text-sm text-foreground" onClick={() => setOpen(true)}>管理服务</button>}</div> : <LoginScreen onLoginSuccess={() => { void readPermissions().catch(() => setError(true)); }} />}
    {open && <FederationAccess onConnect={connect} onClose={() => setOpen(false)} onAddService={addService} onOpenService={openService} onConnectWithPassword={async (connection, password) => { await authenticateKnownConnection(connection, password); await readPermissions(); setOpen(false); }} paired={ready || !!savedConnection()} initialInvite={incomingInvitation} currentServiceName={serviceName} currentServiceId={currentSecureClient()?.targetPeerId || savedConnection()?.targetPeerId} currentServiceOrigin={savedConnection()?.serviceOrigin} currentIdentity={deviceIdentity} grants={grants} sessions={sessions} loading={loadingAccess} loadError={accessError} onRetry={() => void refresh()}
      onRename={async (subjectId, name) => { await (await getActiveClient()).request({ type: 'device-name', subjectId, name }); await refresh(); }}
      hasBackup={!!savedConnection() && connectionRoutes(savedConnection()!).length > 0} onCreateInvite={canManage ? invite : undefined}
      onRevoke={canManage ? async grantId => { await (await getActiveClient()).request(grantId.startsWith('route:') ? { type: 'route-revoke', grantId: grantId.slice(6) } : { type: 'revoke', grantId }); await refresh(); } : undefined} />}
  </>;
}
