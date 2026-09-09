import { listServiceConnections, normalizeServiceAddress, saveServiceConnection, rememberServiceConnection, type ServiceRoute } from '../services/serviceDirectory';
import { connect, SecureSocket, type SecureClient } from './secureClient';
import { createRelaySocketFactory } from './relaySocket';
import { installWorkerBridge } from './workerBridge';
import { DeviceAuthorizationRequired, readDeviceAuthorization } from './deviceAuthorization';
import { raceConnectionAttempts, preferredConnectionPath, rememberConnectionPath, type ConnectionAttempt } from './connectionAttempts';
import { activateServiceWorkspace, getWorkspaceHost } from '../services/workspaceHost';
import { BOOT_SERVICE_ID, ENTRY_KEY, selectedTarget, saveSelectedTarget, clearSelectedTarget, migrateLegacyServiceState } from './clientScope';
import { getIdentity } from './deviceIdentity';
export { getIdentity } from './deviceIdentity';

export const SECURE_STATE_EVENT = 'termdock:secure-state';
let active: SecureClient | undefined;
let connecting: Promise<SecureClient> | undefined;
let entryClient: SecureClient | undefined;
let activePath: 'direct' | 'relay' = 'direct';
let probingDirect = false;
let lastDirectProbe = 0;
const nativeFetch = globalThis.fetch.bind(globalThis);
export interface ConnectionIntent { url: string; targetPeerId: string; pairingCode?: string; serviceName?: string; serviceOrigin?: string; entryServiceId?: string; routeCode?: string; routeOnly?: boolean; routes?: ServiceRoute[] }

export function savedConnection(): ConnectionIntent | null {
  return selectedTarget();
}
export function currentSecureClient(): SecureClient | undefined { return active; }
export function currentEntryClient(): SecureClient | undefined { return entryClient; }
/** Replace a suspended transport without changing saved identity or authorization. */
export function invalidateSecureTransport(): void {
  active?.close(); entryClient?.close(); active = undefined; entryClient = undefined;
}
export async function getDirectAuthStatus(): Promise<{ enabled: boolean; authenticated: boolean }> {
  const response = await nativeFetch('/api/auth/status', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Failed to query auth status');
  return response.json();
}
export async function connectOpenService(): Promise<void> {
  // Existing pins are never replaced by unauthenticated discovery.
  if (savedConnection()) { await getActiveClient(); return; }
  if ((await getDirectAuthStatus()).enabled) return;
  const response = await nativeFetch('/api/auth/open/parameters', { cache: 'no-store' });
  if (!response.ok) throw new Error('Open service unavailable');
  const { serviceIdentity } = await response.json();
  if (typeof serviceIdentity !== 'string' || !serviceIdentity) throw new Error('Invalid service identity');
  await connectDevice({ url: location.origin, targetPeerId: serviceIdentity, serviceName: location.hostname });
}
async function authenticateServicePasswordDirect(url: string, password: string): Promise<ConnectionIntent> {
  const { startPasswordBootstrap, finishPasswordBootstrap } = await import('../../server/federation/passwordBootstrap');
  const endpoint = (path: string) => url === location.origin ? path : new URL(path, url).href;
  const request = async (path: string, body?: unknown) => {
    const response = await nativeFetch(endpoint(path), { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15_000), ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(response.status === 429 ? '尝试次数较多，请稍后再试。' : response.status === 401 ? '密码不正确，请重新输入。' : '暂时无法登录这台服务，请稍后重试。');
    return response.json();
  };
  const { saltHex } = await request('/api/auth/password/parameters');
  const identity = await getIdentity();
  const state = await startPasswordBootstrap(password, saltHex);
  try {
    const started = await request('/api/auth/password/start', { startLoginRequest: state.startLoginRequest, clientIdentity: identity.peerId });
    let verified;
    try { verified = await finishPasswordBootstrap(state, started, { clientIdentity: identity.peerId, origin: location.origin }); }
    catch { throw new Error('密码不正确，或服务身份无法验证。请检查后重试。'); }
    await request('/api/auth/password/finish', { attemptId: verified.attemptId, finishLoginRequest: verified.finishLoginRequest });
    return { url, targetPeerId: verified.serverIdentity, serviceName: new URL(url).host, serviceOrigin: url };
  } finally { state.passwordKey = ''; }
}
async function authenticateServicePassword(url: string, password: string): Promise<ConnectionIntent> {
  const selected = savedConnection();
  if (selected && (selected.serviceOrigin || selected.url) === url) {
    await authenticatePinnedPassword(selected, password);
    return selected;
  }
  try { return await authenticateServicePasswordDirect(url, password); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    const known = (await listServiceConnections()).find(item => item.targetPeerId && (item.serviceOrigin || item.url) === url);
    if (!known?.targetPeerId) throw new Error('暂时连不上这台服务，请检查地址和网络。');
    const intent = { ...known, targetPeerId: known.targetPeerId, serviceName: known.label };
    await authenticatePinnedPassword(intent, password);
    return intent;
  }
}
async function authenticatePinnedPassword(intent: ConnectionIntent, password: string): Promise<void> {
  const client = await openTargetForAuthentication(intent);
  const { startPasswordBootstrap, finishPasswordBootstrap } = await import('../../server/federation/passwordBootstrap');
  let state: Awaited<ReturnType<typeof startPasswordBootstrap>> | undefined;
  try {
    const params = await client.request({ type: 'password-parameters' }, { timeoutMs: 5000 });
    state = await startPasswordBootstrap(password, String(params.saltHex));
    const response = await client.request({ type: 'password-start', startLoginRequest: state.startLoginRequest, origin: location.origin });
    const verified = await finishPasswordBootstrap(state, response as unknown as Parameters<typeof finishPasswordBootstrap>[1], { clientIdentity: (await getIdentity()).peerId, origin: location.origin });
    if (verified.serverIdentity !== intent.targetPeerId) throw new Error('服务身份发生变化。');
    await client.request({ type: 'password-finish', attemptId: verified.attemptId, finishLoginRequest: verified.finishLoginRequest });
  } catch { throw new Error('暂时无法登录，请检查目标服务密码与入口授权后重试。'); }
  finally { if (state) state.passwordKey = ''; client.close(); }
}

async function passwordLogin(password: string): Promise<Response> {
  try {
    // On an expired remote target, sign back into that target, not the page host.
    const selected = savedConnection();
    const url = selected?.serviceOrigin || location.origin;
    const intent = await authenticateServicePassword(url, password);
    await connectDevice({ ...intent, routes: selected?.routes, serviceName: selected?.serviceName || intent.serviceName });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '暂时无法登录，请重试。', code: 'INVALID_PASSWORD' }, { status: 401 });
  }
}
/** An address is sufficient for one's own service; an invitation is optional. */
export async function connectServiceAddress(address: string, password?: string): Promise<{ passwordRequired?: boolean }> {
  const url = normalizeServiceAddress(address);
  const saved = (await listServiceConnections()).find(item => (item.serviceOrigin || item.url) === url && item.targetPeerId);
  if (password === undefined && saved?.targetPeerId) {
    try { await connectDevice({ ...saved, targetPeerId: saved.targetPeerId, serviceName: saved.label }); return {}; }
    catch (error) { if (!(error instanceof DeviceAuthorizationRequired)) throw error; }
  }
  if (password !== undefined) {
    const intent = await authenticateServicePassword(url, password);
    if (saved?.targetPeerId && saved.targetPeerId !== intent.targetPeerId) throw new Error('这台服务的身份已改变。请先移除旧记录，再重新添加。');
    await connectDevice({ ...intent, routes: saved?.routes, serviceName: saved?.label || intent.serviceName }); return {};
  }
  const response = await nativeFetch(new URL('/api/auth/open/parameters', url).href, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000) }).catch(() => { throw new Error('暂时连不上这台服务，请检查地址和网络后重试。'); });
  if (response.status === 403) return { passwordRequired: true };
  if (!response.ok) throw new Error('这台服务暂时不可用，请稍后重试。');
  const { serviceIdentity } = await response.json();
  if (typeof serviceIdentity !== 'string' || !serviceIdentity) throw new Error('这不是可连接的 Termdock 服务。');
  if (saved?.targetPeerId && saved.targetPeerId !== serviceIdentity) throw new Error('这台服务的身份已改变。请先移除旧记录，再重新添加。');
  await connectDevice({ url, targetPeerId: serviceIdentity, serviceName: saved?.label || new URL(url).host, serviceOrigin: url });
  return {};
}
export function connectionRoutes(intent: ConnectionIntent): ServiceRoute[] {
  const candidates = [...(intent.routes || [])];
  if (intent.entryServiceId && intent.entryServiceId !== intent.targetPeerId) candidates.unshift({ url: intent.url, targetPeerId: intent.entryServiceId });
  if (!candidates.length && intent.routes === undefined) try {
    const legacy = JSON.parse(localStorage.getItem(ENTRY_KEY) || 'null') as ConnectionIntent | null;
    if (legacy && legacy.targetPeerId !== intent.targetPeerId && new URL(legacy.url).host === new URL(intent.url).host) candidates.push(legacy);
  } catch { /* Optional legacy metadata does not authorize a route. */ }
  return candidates.flatMap((route, index) => {
    try { return route.targetPeerId && route.targetPeerId !== intent.targetPeerId && candidates.findIndex(item => item.targetPeerId === route.targetPeerId) === index ? [{ url: normalizeServiceAddress(route.url), targetPeerId: route.targetPeerId }] : []; }
    catch { return []; }
  }).slice(0, 4);
}
/** Every direct address must authenticate as the same pinned service. Keep
 * alternate addresses in the existing route format so desktop bridges preserve
 * them too, without requiring a native-shell update.
 */
export function connectionAddresses(intent: ConnectionIntent): string[] {
  const relays = connectionRoutes(intent);
  const candidates = [intent.serviceOrigin || intent.url, ...(intent.routes || []).slice(0, 4)
    .filter(route => route.targetPeerId === intent.targetPeerId).map(route => route.url)];
  const addresses = new Set<string>();
  for (const candidate of candidates) try {
    const address = normalizeServiceAddress(candidate);
    if (!relays.some(route => route.url === address)) addresses.add(address);
  } catch { /* Ignore invalid persisted addresses, never replace the identity. */ }
  return [...addresses];
}
function secureUrl(address: string): string {
  const url = new URL('/api/federation/secure', normalizeServiceAddress(address));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; return url.href;
}
async function connectEntry(route: ServiceRoute, signal?: AbortSignal): Promise<SecureClient> {
  return connect({ url: secureUrl(route.url), targetPeerId: route.targetPeerId, identity: await getIdentity(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
}
async function openTargetForAuthentication(intent: ConnectionIntent): Promise<SecureClient> {
  const identity = await getIdentity();
  const attempts: ConnectionAttempt<SecureClient>[] = connectionAddresses(intent).map(origin => ({
    key: `direct:${origin}`,
    run: signal => connect({ url: secureUrl(origin), targetPeerId: intent.targetPeerId, identity,
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }),
  }));
  for (const route of connectionRoutes(intent)) attempts.push({ key: `relay:${route.targetPeerId}:${route.url}`, run: async signal => {
    const reused = [active, entryClient].find(client => client && !client.closed && client.targetPeerId === route.targetPeerId);
    const entry = reused || await connectEntry(route, signal);
    try {
      if (signal.aborted) throw signal.reason;
      const ticket = await entry.request({ type: 'route-ticket', serviceId: intent.targetPeerId }, { timeoutMs: 5000 });
      if (signal.aborted) throw signal.reason;
      if (typeof ticket.routeToken !== 'string') throw new Error('入口未允许此设备连接该服务。');
      const url = new URL(secureUrl(route.url)); url.pathname = '/api/federation/relay'; url.searchParams.set('routeToken', ticket.routeToken);
      return await connect({ url: url.href, targetPeerId: intent.targetPeerId, identity, socketFactory: createRelaySocketFactory(intent.targetPeerId),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
    } finally { if (!reused) entry.close(); }
  } });
  const preferred = preferredConnectionPath(intent.targetPeerId);
  attempts.sort((a, b) => Number(b.key === preferred) - Number(a.key === preferred));
  const result = await raceConnectionAttempts(attempts, client => client.close());
  rememberConnectionPath(intent.targetPeerId, result.key);
  return result.value;
}
export async function connectDevice(intent: ConnectionIntent, options: { rememberOnly?: boolean } = {}): Promise<SecureClient> {
  const previous = active, previousEntry = entryClient;
  const identity = await getIdentity();
  const serviceOrigin = normalizeServiceAddress(intent.serviceOrigin || intent.url);
  const known = (await listServiceConnections()).find(item => item.targetPeerId === intent.targetPeerId);
  const savedIntent = { ...intent, routes: intent.routes ?? known?.routes };
  const routes = connectionRoutes(savedIntent);
  const addresses = connectionAddresses(savedIntent);
  let next: SecureClient | undefined, nextEntry: SecureClient | undefined;
  let pairingCode = intent.pairingCode;
  let path: 'direct' | 'relay' = 'direct';
  const openedEntries = new Set<SecureClient>();
  const entryCache = new Map<string, SecureClient>();
  const entryFor = async (route: ServiceRoute, signal?: AbortSignal) => {
    if (previous && !previous.closed && previous.targetPeerId === route.targetPeerId) return previous;
    if (previousEntry && !previousEntry.closed && previousEntry.targetPeerId === route.targetPeerId) return previousEntry;
    const cached = entryCache.get(route.targetPeerId); if (cached && !cached.closed) return cached;
    const entry = await connectEntry(route, signal); openedEntries.add(entry); entryCache.set(route.targetPeerId, entry); return entry;
  };
  try {
    if (intent.routeCode && intent.entryServiceId) {
      const route = routes.find(item => item.targetPeerId === intent.entryServiceId);
      if (!route) throw new Error('邀请缺少入口信息。');
      const entry = await entryFor(route);
      const result = await entry.request({ type: 'route-pair', code: intent.routeCode });
      if (result.serviceId !== intent.targetPeerId) throw new Error('邀请的目标服务不一致。');
      if (intent.routeOnly) await saveServiceConnection({ id: intent.targetPeerId, url: serviceOrigin, label: intent.serviceName || new URL(serviceOrigin).host, targetPeerId: intent.targetPeerId, serviceOrigin, routes });
    }
    type Transport = { client: SecureClient; entry?: SecureClient; path: 'direct' | 'relay' };
    const attempts: ConnectionAttempt<Transport>[] = [];
    const validate = async (client: SecureClient, signal: AbortSignal) => {
      const abort = () => client.close();
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) throw signal.reason;
        await readDeviceAuthorization(client);
        if (signal.aborted) throw signal.reason;
      } catch (error) { client.close(); throw error; }
      finally { signal.removeEventListener('abort', abort); }
    };
    for (const address of addresses) attempts.push({ key: `direct:${address}`, run: async signal => {
      const client = await connect({ url: secureUrl(address), targetPeerId: intent.targetPeerId, pairingCode, identity,
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      pairingCode = undefined;
      await validate(client, signal);
      return { client, path: 'direct' };
    } });
    for (const route of routes) attempts.push({ key: `relay:${route.targetPeerId}:${route.url}`, run: async signal => {
      let candidateEntry: SecureClient | undefined;
      let client: SecureClient | undefined;
      try {
        candidateEntry = await entryFor(route, signal);
        if (signal.aborted) throw signal.reason;
        const ticket = await candidateEntry.request({ type: 'route-ticket', serviceId: intent.targetPeerId }, { timeoutMs: 5000 });
        if (signal.aborted) throw signal.reason;
        if (typeof ticket.routeToken !== 'string' || !ticket.routeToken) throw new Error('入口未允许此设备连接该服务。');
        const url = new URL(secureUrl(route.url)); url.pathname = '/api/federation/relay'; url.searchParams.set('routeToken', ticket.routeToken);
        client = await connect({ url: url.href, targetPeerId: intent.targetPeerId, pairingCode, identity,
          socketFactory: createRelaySocketFactory(intent.targetPeerId), signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
        pairingCode = undefined;
        await validate(client, signal);
        return { client, entry: candidateEntry, path: 'relay' };
      } catch (error) {
        client?.close();
        if (candidateEntry && candidateEntry !== previousEntry && candidateEntry !== previous) candidateEntry.close();
        throw error;
      }
    } });
    const preferred = preferredConnectionPath(intent.targetPeerId);
    attempts.sort((a, b) => Number(b.key === preferred) - Number(a.key === preferred));
    const result = await raceConnectionAttempts(attempts, transport => {
      transport.client.close();
      if (transport.entry && transport.entry !== previous && transport.entry !== previousEntry) transport.entry.close();
    }, !!pairingCode);
    next = result.value.client; nextEntry = result.value.entry; path = result.value.path;
    rememberConnectionPath(intent.targetPeerId, result.key);
    // A manually verified address can restore this service while an earlier
    // reconnect is still pending. Do not replace it with that stale attempt.
    if (active !== previous && active && !active.closed && active.targetPeerId === intent.targetPeerId) {
      next.close();
      for (const entry of openedEntries) if (entry !== entryClient) entry.close();
      return active;
    }
    if (path === 'direct' && new URL(serviceOrigin).host === location.host) migrateLegacyServiceState(intent.targetPeerId);
    const existing = (await listServiceConnections()).find(item => item.targetPeerId === intent.targetPeerId || (!item.targetPeerId && (item.serviceOrigin || item.url) === serviceOrigin));
    const serviceName = existing?.label || intent.serviceName || new URL(serviceOrigin).host;
    const saved = { url: serviceOrigin, targetPeerId: intent.targetPeerId, serviceName, serviceOrigin, routes: savedIntent.routes ?? routes };
    await (options.rememberOnly ? rememberServiceConnection : saveServiceConnection)({ id: existing?.id || intent.targetPeerId, ...saved, label: serviceName });
    // A new verified service opens its own document; keep this document's
    // existing transport and stores bound to their original target.
    if (BOOT_SERVICE_ID !== 'unpaired' && BOOT_SERVICE_ID !== intent.targetPeerId && getWorkspaceHost()
      && activateServiceWorkspace({ id: existing?.id || intent.targetPeerId, ...saved, label: serviceName })) {
      next.close();
      for (const client of openedEntries) if (client !== previous && client !== previousEntry) client.close();
      return previous || next;
    }
    saveSelectedTarget(saved);
    active = next; activePath = path; entryClient = nextEntry;
    // Finish the replacement before closing old streams so their reconnects use
    // the new authenticated path, without remounting the terminal interface.
    for (const client of new Set([previous, previousEntry, ...openedEntries])) if (client && client !== next && client !== nextEntry) client.close();
    if (BOOT_SERVICE_ID !== intent.targetPeerId) { location.reload(); return new Promise<SecureClient>(() => {}); }
    window.dispatchEvent(new Event(SECURE_STATE_EVENT)); return next;
  } catch (error) {
    next?.close(); for (const entry of openedEntries) if (entry !== previousEntry) entry.close();
    throw error;
  }
}
/** Periodically prefer direct connectivity again after VPN/LAN conditions
 * improve. Do not interrupt an upload or other in-flight HTTP operation. */
export async function preferDirectConnection(): Promise<void> {
  const previous = active, selected = savedConnection();
  if (Date.now() - lastDirectProbe < 60_000 || probingDirect || activePath !== 'relay' || !previous || previous.closed || !previous.canSwitchTransport || !selected?.serviceOrigin) return;
  probingDirect = true; lastDirectProbe = Date.now(); let candidate: SecureClient | undefined;
  try {
    for (const address of connectionAddresses(selected)) try {
      candidate = await connect({ url: secureUrl(address), targetPeerId: selected.targetPeerId, identity: await getIdentity(), signal: AbortSignal.timeout(3000) });
      await readDeviceAuthorization(candidate);
      break;
    } catch (error) {
      candidate?.close(); candidate = undefined;
      if (error instanceof DeviceAuthorizationRequired) throw error;
    }
    if (!candidate) return;
    if (active !== previous || !previous.canSwitchTransport) return;
    const oldEntry = entryClient;
    active = candidate; candidate = undefined; entryClient = undefined; activePath = 'direct';
    previous.close(); oldEntry?.close(); window.dispatchEvent(new Event(SECURE_STATE_EVENT));
  } catch (error) {
    if (error instanceof DeviceAuthorizationRequired && active === previous) {
      invalidateSecureTransport(); window.dispatchEvent(new Event('auth:unauthorized'));
    }
  } finally { candidate?.close(); probingDirect = false; }
}
export function currentConnectionPath(): 'direct' | 'relay' { return activePath; }
export async function getActiveClient(): Promise<SecureClient> {
  if (active && !active.closed) return active;
  active = undefined;
  if (connecting) return connecting;
  const saved = savedConnection();
  if (!saved) throw new Error('DEVICE_PAIRING_REQUIRED');
  connecting = connectDevice(saved, { rememberOnly: true }).catch(error => {
    if (active && !active.closed && active.targetPeerId === saved.targetPeerId) return active;
    throw error;
  }).finally(() => { connecting = undefined; });
  return connecting;
}
export function secureSocket(url: string): WebSocket {
  const parsed = new URL(url, location.href);
  if (active && !active.closed) return active.openSocket(parsed.pathname + parsed.search) as unknown as WebSocket;
  let target: SecureSocket | undefined;
  const pending = new SecureSocket(url, data => target?.send(data), () => target?.close());
  void getActiveClient().then(client => {
    if (pending.readyState === 3) return;
    target = client.openSocket(parsed.pathname + parsed.search);
    target.onopen = () => pending.accept({ type: 'ws-ready', id: '' });
    target.onmessage = event => pending.accept({ type: 'ws-data', id: '', data: event.data });
    target.onclose = event => pending.accept({ type: 'ws-close', id: '', code: event.code, reason: event.reason });
    target.onerror = () => pending.fail(new Error('Encrypted connection unavailable'));
  }).catch(error => pending.fail(error));
  return pending as unknown as WebSocket;
}

/** Install before mounting application effects; no encrypted request falls back to HTTPS. */
export function installEncryptedFetch(): void {
  installWorkerBridge(getActiveClient);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
    if (url.origin !== location.origin) throw new Error('Remote business API requires a paired encrypted service');
    if (url.pathname === '/api/meta') return nativeFetch(input, init);
    if (url.pathname === '/api/auth/status') {
      if (!savedConnection()) {
        const status = await getDirectAuthStatus();
        return Response.json({ enabled: status.enabled, authenticated: false });
      }
      try {
        const permissions = await readDeviceAuthorization(await getActiveClient());
        return Response.json({ enabled: permissions.grants.length > 0, authenticated: true });
      } catch (error) {
        if (error instanceof DeviceAuthorizationRequired) return Response.json({ enabled: true, authenticated: false });
        throw error;
      }
    }
    if (url.pathname === '/api/auth/login') {
      const request = new Request(input instanceof Request ? input : url.href, init);
      const body = await request.json();
      return passwordLogin(typeof body.password === 'string' ? body.password : '');
    }
    if (url.pathname === '/api/csrf-token') return Response.json({ csrfToken: 'encrypted-device-channel' });
    if (url.pathname === '/api/auth/logout') {
      if (active && !active.closed) await active.request({ type: 'logout' });
      active?.close(); entryClient?.close(); active = undefined; entryClient = undefined;
      clearSelectedTarget();
      location.reload(); return Response.json({ ok: true });
    }
    const client = await getActiveClient();
    if (input instanceof Request) return client.fetch(input, init);
    return client.fetch(url.pathname + url.search, init);
  };
}

export interface EntryRouteGrant { id: string; subjectId: string; targetServiceId: string; active: boolean; revokedAt?: number }
export interface RelayTarget { serviceId: string; label?: string; url?: string; available: boolean; authorized: boolean }
export interface RelayTargetDirectory { route: ServiceRoute; canManage: boolean; items: RelayTarget[] }
/** Browse only a pinned entry's explicit directory, without changing the active service. */
export async function listRelayTargets(service: import('../services/serviceDirectory').ServiceConnection): Promise<RelayTargetDirectory> {
  if (!service.targetPeerId) throw new Error('请先连接这台服务，再查看可中转的服务。');
  for (const url of connectionAddresses({ ...service, targetPeerId: service.targetPeerId })) {
    let client: SecureClient;
    const route = { url, targetPeerId: service.targetPeerId };
    try { client = await connectEntry(route); } catch { continue; }
    try {
      const result = await client.request({ type: 'route-targets' }, { timeoutMs: 5000 });
      if (!Array.isArray(result.items)) throw new Error('入口服务需要更新后才能查看中转列表。');
      return { route, canManage: result.canManage === true, items: result.items as RelayTarget[] };
    } catch (error) {
      if (error instanceof Error && /UNKNOWN|UNSUPPORTED/i.test(error.message)) throw new Error('入口服务需要更新后才能查看中转列表。');
      throw error;
    } finally { client.close(); }
  }
  throw new Error('暂时连不上中转入口，请检查地址和网络后重试。');
}
export async function prepareRelayConnection(route: ServiceRoute, targetServiceId: string): Promise<ConnectionIntent> {
  const entry = await connectEntry(route);
  try {
    // Re-read visibility and grants at the click, so stale lists cannot authorize a target.
    const result = await entry.request({ type: 'route-targets' }, { timeoutMs: 5000 });
    const target = (Array.isArray(result.items) ? result.items as RelayTarget[] : []).find(item => item.serviceId === targetServiceId);
    if (!target) throw new Error('该服务已不可见，请刷新列表或请入口管理员授权。');
    if (!target.available) throw new Error('入口暂时无法中转到这台服务，请稍后重试。');
    const known = (await listServiceConnections()).find(item => item.targetPeerId === target.serviceId);
    const routes = [route, ...(known?.routes || []).filter(item => item.targetPeerId !== route.targetPeerId)];
    if (routes.length > 4) throw new Error('这台服务已保存 4 个备用连接，请先移除一个后重试。');
    if (!target.authorized) {
      if (!result.canManage) throw new Error('请先让入口管理员授权此设备。');
      await entry.request({ type: 'route-grant', serviceId: target.serviceId, subjectId: (await getIdentity()).peerId });
    }
    const origin = known?.serviceOrigin || known?.url || target.url || route.url;
    return { url: origin, serviceOrigin: origin, targetPeerId: target.serviceId, serviceName: known?.label || target.label || (target.url ? new URL(target.url).host : `中转服务 ${target.serviceId.slice(0, 8)}`), routes };
  } finally { entry.close(); }
}
export async function inspectEntryRoute(route: ServiceRoute, targetServiceId: string): Promise<{ canManage: boolean; grants: EntryRouteGrant[] }> {
  const client = await connectEntry(route);
  try {
    const result = await client.request({ type: 'route-access' }, { timeoutMs: 5000 });
    const subjectId = (await getIdentity()).peerId;
    return { canManage: result.canManage === true, grants: (Array.isArray(result.grants) ? result.grants as EntryRouteGrant[] : []).filter(grant => grant.subjectId === subjectId && grant.targetServiceId === targetServiceId) };
  } finally { client.close(); }
}
export async function authorizeEntryRoute(target: ConnectionIntent, route: ServiceRoute, password?: string): Promise<void> {
  if (password !== undefined) {
    const verified = await authenticateServicePassword(normalizeServiceAddress(route.url), password);
    if (verified.targetPeerId !== route.targetPeerId) throw new Error('入口服务的身份已改变，请重新连接并确认。');
  }
  const entry = await connectEntry(route);
  try {
    await entry.request({ type: 'route-grant', serviceId: target.targetPeerId, subjectId: (await getIdentity()).peerId, url: normalizeServiceAddress(target.serviceOrigin || target.url) });
  } finally { entry.close(); }
}
export async function revokeEntryRoute(targetServiceId: string, route: ServiceRoute): Promise<void> {
  const entry = await connectEntry(route);
  try {
    const result = await entry.request({ type: 'route-access' }, { timeoutMs: 5000 });
    const subjectId = (await getIdentity()).peerId;
    const grants = (Array.isArray(result.grants) ? result.grants as EntryRouteGrant[] : []).filter(grant => grant.subjectId === subjectId && grant.targetServiceId === targetServiceId && grant.active);
    for (const grant of grants) await entry.request({ type: 'route-revoke', grantId: grant.id });
  } finally { entry.close(); }
}
export async function createEntryInvitation(target: ConnectionIntent, route: ServiceRoute): Promise<{ routeCode: string; expiresAt: number }> {
  const entry = await connectEntry(route);
  try {
    const result = await entry.request({ type: 'route-invite-create', serviceId: target.targetPeerId });
    if (typeof result.routeCode !== 'string' || typeof result.expiresAt !== 'number') throw new Error('暂时无法生成备用连接邀请。');
    return { routeCode: result.routeCode, expiresAt: result.expiresAt };
  } finally { entry.close(); }
}
export async function saveServiceRoutes(service: import('../services/serviceDirectory').ServiceConnection, routes: ServiceRoute[]): Promise<void> {
  const latest = (await listServiceConnections()).find(item => item.id === service.id || (service.targetPeerId && item.targetPeerId === service.targetPeerId)) || service;
  await saveServiceConnection({ ...latest, url: latest.serviceOrigin || latest.url, entryServiceId: undefined, routes });
  const selected = savedConnection();
  if (selected && selected.targetPeerId === service.targetPeerId) saveSelectedTarget({ ...selected, url: selected.serviceOrigin || selected.url, entryServiceId: undefined, routes });
}

/** Verify before saving: an address on another LAN may belong to a completely
 * different computer. No password or discovery result can replace this pin.
 */
export async function addServiceAddress(service: import('../services/serviceDirectory').ServiceConnection, input: string): Promise<ServiceRoute[]> {
  const targetPeerId = service.targetPeerId;
  if (!targetPeerId) throw new Error('请先连接这台服务，再添加备用地址。');
  let address: string;
  try { address = normalizeServiceAddress(input); }
  catch { throw new Error('请输入有效的 HTTPS 地址，例如 https://电脑地址:9834。'); }
  const latestService = async () => (await listServiceConnections()).find(item => item.targetPeerId === targetPeerId) || service;
  const nextRoutes = (current: typeof service) => {
    const existing = current.routes ?? connectionRoutes({ ...current, targetPeerId });
    if (normalizeServiceAddress(current.serviceOrigin || current.url) === address || existing.some(route => normalizeServiceAddress(route.url) === address)) {
      throw new Error('这个地址已经在连接列表中。');
    }
    if (existing.length >= 4) throw new Error('最多保存 4 个备用地址或入口，请先移除不再使用的连接。');
    return [...existing, { url: address, targetPeerId }];
  };
  nextRoutes(await latestService());
  let candidate: SecureClient | undefined;
  try {
    try {
      candidate = await connect({ url: secureUrl(address), targetPeerId, identity: await getIdentity(), signal: AbortSignal.timeout(5000) });
      await readDeviceAuthorization(candidate);
    } catch (error) {
      if (error instanceof DeviceAuthorizationRequired) throw new Error('这台服务尚未授权当前设备，请先恢复设备授权。');
      throw new Error('无法验证这个地址。请确认能访问该地址、HTTPS 证书受信任，且运行的是同一台 Termdock 服务。');
    }
    const current = await latestService();
    const routes = nextRoutes(current);
    await saveServiceRoutes(current, routes);
    // Restore an offline PWA using the connection just verified, without
    // another attempt at the unreachable home address or a page navigation.
    if (savedConnection()?.targetPeerId === targetPeerId && BOOT_SERVICE_ID === targetPeerId && (!active || active.closed)) {
      const previous = active, previousEntry = entryClient;
      active = candidate; candidate = undefined; entryClient = undefined; activePath = 'direct';
      previous?.close(); previousEntry?.close();
      window.dispatchEvent(new Event(SECURE_STATE_EVENT));
    }
    return routes;
  } finally { candidate?.close(); }
}

export async function authenticateKnownConnection(intent: ConnectionIntent, password: string): Promise<void> {
  await authenticatePinnedPassword(intent, password);
  await connectDevice({ ...intent, pairingCode: undefined, routeCode: undefined });
}
