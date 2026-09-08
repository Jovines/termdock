import { listServiceConnections, normalizeServiceAddress, saveServiceConnection, type ServiceRoute } from '../services/serviceDirectory';
import { connect, SecureSocket, type SecureClient } from './secureClient';
import { createRelaySocketFactory } from './relaySocket';
import { installWorkerBridge } from './workerBridge';
import { DeviceAuthorizationRequired, readDeviceAuthorization } from './deviceAuthorization';
import { BOOT_SERVICE_ID, TARGET_KEY, ENTRY_KEY, selectedTarget, saveSelectedTarget, migrateLegacyServiceState } from './clientScope';
import { createIdentity, importIdentity, exportIdentity, type Identity } from '../../server/federation/secureProtocol';

export const SECURE_STATE_EVENT = 'termdock:secure-state';
let active: SecureClient | undefined;
let connecting: Promise<SecureClient> | undefined;
let identityPromise: Promise<Identity> | undefined;
let entryClient: SecureClient | undefined;
let activePath: 'direct' | 'relay' = 'direct';
let probingDirect = false;
const nativeFetch = globalThis.fetch.bind(globalThis);
export interface ConnectionIntent { url: string; targetPeerId: string; pairingCode?: string; serviceName?: string; serviceOrigin?: string; entryServiceId?: string; routeCode?: string; routeOnly?: boolean; routes?: ServiceRoute[] }

export async function getIdentity(): Promise<Identity> {
  if (!identityPromise) identityPromise = (async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('termdock-device-identity', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const stored = await new Promise<string | undefined>((resolve, reject) => {
        const request = database.transaction('keys').objectStore('keys').get('identity');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (stored) return importIdentity(stored);
      const identity = await createIdentity();
      let winner = identity;
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('keys', 'readwrite');
        const store = tx.objectStore('keys'); const existing = store.get('identity');
        existing.onsuccess = () => { if (typeof existing.result === 'string') winner = importIdentity(existing.result); else store.put(exportIdentity(identity), 'identity'); };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      return winner;
    } finally { database.close(); }
  })();
  return identityPromise;
}
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
  const response = await nativeFetch('/api/auth/status');
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
  try { return await authenticateServicePasswordDirect(url, password); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    const known = (await listServiceConnections()).find(item => item.targetPeerId && (item.serviceOrigin || item.url) === url);
    if (!known?.targetPeerId) throw new Error('暂时连不上这台服务，请检查地址和网络。');
    const intent = { ...known, targetPeerId: known.targetPeerId, serviceName: known.label };
    const client = await openTargetForAuthentication(intent);
    const { startPasswordBootstrap, finishPasswordBootstrap } = await import('../../server/federation/passwordBootstrap');
    let state: Awaited<ReturnType<typeof startPasswordBootstrap>> | undefined;
    try {
      const params = await client.request({ type: 'password-parameters' }, { timeoutMs: 5000 });
      state = await startPasswordBootstrap(password, String(params.saltHex));
      const response = await client.request({ type: 'password-start', startLoginRequest: state.startLoginRequest, origin: location.origin });
      const verified = await finishPasswordBootstrap(state, response as unknown as Parameters<typeof finishPasswordBootstrap>[1], { clientIdentity: (await getIdentity()).peerId, origin: location.origin });
      if (verified.serverIdentity !== known.targetPeerId) throw new Error('服务身份发生变化。');
      await client.request({ type: 'password-finish', attemptId: verified.attemptId, finishLoginRequest: verified.finishLoginRequest });
      return intent;
    } catch { throw new Error('暂时无法登录，请检查密码与入口授权后重试。'); }
    finally { if (state) state.passwordKey = ''; client.close(); }
  }
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
async function connectEntry(route: ServiceRoute): Promise<SecureClient> {
  return connect({ url: secureUrl(route.url), targetPeerId: route.targetPeerId, identity: await getIdentity(), signal: AbortSignal.timeout(5000) });
}
async function openTargetForAuthentication(intent: ConnectionIntent): Promise<SecureClient> {
  const routes = connectionRoutes(intent);
  for (const origin of connectionAddresses(intent)) try {
    return await connect({ url: secureUrl(origin), targetPeerId: intent.targetPeerId, identity: await getIdentity(), signal: AbortSignal.timeout(3000) });
  } catch { /* Try only the explicitly saved entry permissions below. */ }
  for (const route of routes) {
    let entry: SecureClient | undefined;
    try {
      entry = await connectEntry(route);
      const ticket = await entry.request({ type: 'route-ticket', serviceId: intent.targetPeerId }, { timeoutMs: 5000 });
      if (typeof ticket.routeToken !== 'string') continue;
      const url = new URL(secureUrl(route.url)); url.pathname = '/api/federation/relay'; url.searchParams.set('routeToken', ticket.routeToken);
      return await connect({ url: url.href, targetPeerId: intent.targetPeerId, identity: await getIdentity(), socketFactory: createRelaySocketFactory(intent.targetPeerId), signal: AbortSignal.timeout(8000) });
    } catch { /* Another explicitly authorized entry may be reachable. */ }
    finally { entry?.close(); }
  }
  throw new Error('当前无法连接。请检查网络，或请入口管理员授权此设备访问该服务。');
}
export async function connectDevice(intent: ConnectionIntent): Promise<SecureClient> {
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
  const entryFor = async (route: ServiceRoute) => {
    if (previousEntry && !previousEntry.closed && previousEntry.targetPeerId === route.targetPeerId) return previousEntry;
    const cached = entryCache.get(route.targetPeerId); if (cached && !cached.closed) return cached;
    const entry = await connectEntry(route); openedEntries.add(entry); entryCache.set(route.targetPeerId, entry); return entry;
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
    let directFailure: unknown;
    for (const address of addresses) try {
      next = await connect({ url: secureUrl(address), targetPeerId: intent.targetPeerId, pairingCode, identity, signal: AbortSignal.timeout(routes.length || addresses.length > 1 ? 3000 : 10_000) });
      pairingCode = undefined;
      await readDeviceAuthorization(next);
      break;
    } catch (error) {
      next?.close(); next = undefined;
      if (error instanceof DeviceAuthorizationRequired) throw error;
      directFailure = error;
    }
    if (!next) {
      for (const route of routes) {
        let candidateEntry: SecureClient | undefined;
        try {
          candidateEntry = await entryFor(route);
          // A route is usable only after an explicit, target-scoped entry grant.
          const ticket = await candidateEntry.request({ type: 'route-ticket', serviceId: intent.targetPeerId }, { timeoutMs: 5000 });
          if (typeof ticket.routeToken !== 'string' || !ticket.routeToken) throw new Error('入口未允许此设备连接该服务。');
          const url = new URL(secureUrl(route.url)); url.pathname = '/api/federation/relay'; url.searchParams.set('routeToken', ticket.routeToken);
          next = await connect({ url: url.href, targetPeerId: intent.targetPeerId, pairingCode, identity, socketFactory: createRelaySocketFactory(intent.targetPeerId), signal: AbortSignal.timeout(8000) });
          pairingCode = undefined; await readDeviceAuthorization(next);
          nextEntry = candidateEntry; path = 'relay'; break;
        } catch (error) {
          next?.close(); next = undefined;
          if (candidateEntry && candidateEntry !== previousEntry) candidateEntry.close();
          if (error instanceof DeviceAuthorizationRequired) throw error;
          directFailure = error;
        }
      }
    }
    if (!next) throw directFailure || new Error('当前网络无法连接这台服务，也没有可用的已授权入口。');
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
    await saveServiceConnection({ id: existing?.id || intent.targetPeerId, ...saved, label: serviceName });
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
  if (probingDirect || activePath !== 'relay' || !previous || previous.closed || !previous.canSwitchTransport || !selected?.serviceOrigin) return;
  probingDirect = true; let candidate: SecureClient | undefined;
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
  connecting = connectDevice(saved).catch(error => {
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
      const status = await getDirectAuthStatus();
      if (!savedConnection()) return Response.json({ enabled: status.enabled, authenticated: false });
      try {
        await readDeviceAuthorization(await getActiveClient());
        return Response.json({ enabled: status.enabled, authenticated: true });
      } catch (error) {
        if (error instanceof DeviceAuthorizationRequired) return Response.json({ enabled: status.enabled, authenticated: false });
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
      localStorage.removeItem(TARGET_KEY); sessionStorage.removeItem(TARGET_KEY); localStorage.removeItem(ENTRY_KEY);
      location.reload(); return Response.json({ ok: true });
    }
    const client = await getActiveClient();
    if (input instanceof Request) return client.fetch(input, init);
    return client.fetch(url.pathname + url.search, init);
  };
}

export interface EntryRouteGrant { id: string; subjectId: string; targetServiceId: string; active: boolean; revokedAt?: number }
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
  const origin = normalizeServiceAddress(intent.serviceOrigin || intent.url);
  const verified = await authenticateServicePassword(origin, password);
  if (verified.targetPeerId !== intent.targetPeerId) throw new Error('服务身份已改变，请重新确认连接。');
  await connectDevice({ ...intent, pairingCode: undefined, routeCode: undefined });
}
