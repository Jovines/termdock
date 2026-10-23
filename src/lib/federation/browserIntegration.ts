import { RELAY_CLIENT_CONNECT_TIMEOUT_MS } from '../../server/federation/streamLimits';
import { directConnectionAddresses, relayConnectionRoutes, serviceEndpoint, hasIndependentConnectionRoute, MAX_SAVED_ROUTES } from '../../server/federation/connectionModel';
import { listServiceConnections, normalizeServiceAddress, saveServiceConnection, rememberServiceConnection, type ServiceRoute } from '../services/serviceDirectory';
import { relayTargetName, relayTargetFailure } from './relayTarget';
import { connect, SecureSocket, type SecureClient } from './secureClient';
import { createRelaySocketFactory } from './relaySocket';
import { installWorkerBridge } from './workerBridge';
import { DeviceAuthorizationRequired, readDeviceAuthorization } from './deviceAuthorization';
import { raceConnectionAttempts, preferredConnectionPath, rememberConnectionPath, type ConnectionAttempt } from './connectionAttempts';
import { activateServiceWorkspace, getWorkspaceHost } from '../services/workspaceHost';
import { BOOT_SERVICE_ID, ENTRY_KEY, selectedTarget, saveSelectedTarget, clearSelectedTarget, migrateLegacyServiceState } from './clientScope';
import { getIdentity } from './deviceIdentity';
import { isConnectionInterruption, setConnectionRecovery } from './connectionRecovery';
import { PasswordLoginFailure, passwordLoginFailure } from './passwordLoginFailure';
import { ConnectionAccessError, connectionAccessError, relayAuthorizationError } from './accessFailure';
export { getIdentity } from './deviceIdentity';

export const SECURE_STATE_EVENT = 'termdock:secure-state';
let active: SecureClient | undefined;
let connecting: Promise<SecureClient> | undefined;
let entryClient: SecureClient | undefined;
let activePath: 'direct' | 'relay' = 'direct';
let probingDirect = false;
let lastDirectProbe = 0;
let renewing = false;
let lastRenewalAttemptAt = -Infinity;
const accessBlocks = new Map<string, ConnectionAccessError>();
const deniedEntries = new Map<string, Set<string>>();
function rememberDeniedEntry(error: ConnectionAccessError): void {
  const { targetServiceId, entryServiceId } = error.context;
  if (error.code !== 'RELAY_AUTHORIZATION_REQUIRED' || !targetServiceId || !entryServiceId) return;
  if (deniedEntries.size > 32) deniedEntries.clear();
  const entries = deniedEntries.get(targetServiceId) || new Set<string>(); entries.add(entryServiceId); deniedEntries.set(targetServiceId, entries);
}
function allowedEntry(targetId: string, entryId: string): boolean { return !deniedEntries.get(targetId)?.has(entryId); }
export function pauseConnectionAccess(error: ConnectionAccessError): void {
  rememberDeniedEntry(error);
  const id = error.context.targetServiceId || savedConnection()?.targetPeerId;
  if (id) { if (accessBlocks.size > 32) accessBlocks.clear(); accessBlocks.set(id, error); }
}
export function resumeConnectionAccess(): void {
  const id = savedConnection()?.targetPeerId; if (id) { accessBlocks.delete(id); deniedEntries.delete(id); }
}
const nativeFetch = globalThis.fetch.bind(globalThis);
export interface ConnectionIntent { viewMode?: 'terminal' | 'chat'; url: string; targetPeerId: string; pairingCode?: string; serviceName?: string; serviceOrigin?: string; entryServiceId?: string; routeCode?: string; routeOnly?: boolean; routes?: ServiceRoute[] }

export function savedConnection(): ConnectionIntent | null {
  return selectedTarget();
}
export function currentSecureClient(): SecureClient | undefined { return active; }
export function currentEntryClient(): SecureClient | undefined { return entryClient; }
/** Replace a suspended transport without changing saved identity or authorization. */
export function invalidateSecureTransport(): void {
  active?.close(); entryClient?.close(); active = undefined; entryClient = undefined;
}
class SecureReadTargetChanged extends Error { constructor(){super('Secure read target changed');this.name='SecureReadTargetChanged';} }
function isRecoverableReadInterruption(error: unknown): boolean {
  if (isConnectionInterruption(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === 'UnexpectedEOFError'
    && typeof candidate.message === 'string'
    && /^Unexpected EOF - stream closed while reading \d+\/\d+ bytes$/.test(candidate.message);
}
/** Retry a complete read (including its body) once on an interrupted encrypted
 * channel. Writes and reads belonging to a changed service are never replayed. */
export async function readWithSecureReconnect<T>(read: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
  const target = savedConnection();
  const targetPeerId = target?.targetPeerId;
  const targetStamp = JSON.stringify(target);
  const targetIsCurrent = () => JSON.stringify(savedConnection()) === targetStamp;
  const previous = currentSecureClient();
  const complete = (result:T):T => {
    if (!targetIsCurrent()) throw new SecureReadTargetChanged();
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    return result;
  };
  try { return complete(await read()); }
  catch (error) {
    if (error instanceof SecureReadTargetChanged || signal?.aborted || error instanceof Error && error.name === 'AbortError'
      || error && typeof error === 'object' && 'status' in error
      || !targetPeerId || !targetIsCurrent()
      || (!previous?.closed && !isRecoverableReadInterruption(error))) throw error;
    setConnectionRecovery(navigator.onLine === false ? 'offline' : 'reconnecting');
    if (previous && currentSecureClient() === previous) invalidateSecureTransport();
    window.dispatchEvent(new Event(SECURE_STATE_EVENT));
    await waitForActiveClient(signal);
    if (!targetIsCurrent()) throw new SecureReadTargetChanged();
    const result = complete(await read());
    setConnectionRecovery('ready');
    return result;
  }
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
  // Preview's transport uses a private loopback document. Its native boundary
  // binds this proof to the exact approved upstream Origin for old servers;
  // ordinary browsers and Electron keep their existing document binding.
  const preview = typeof window !== 'undefined' ? window.termdockDesktop as (typeof window.termdockDesktop & { previewCapabilities?: unknown; passwordBootstrapOrigin?: (url: string) => string }) : undefined;
  let proofOrigin = location.origin;
  if (preview?.previewCapabilities && preview.passwordBootstrapOrigin) {
    const candidate = preview.passwordBootstrapOrigin(url);
    const parsed = new URL(candidate);
    if (parsed.origin !== candidate || (url !== location.origin && parsed.origin !== url) || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new PasswordLoginFailure('LOGIN_UNAVAILABLE');
    proofOrigin = candidate;
  }
  const endpoint = (path: string) => url === location.origin ? path : new URL(path, url).href;
  const request = async (path: string, body?: unknown) => {
    const response = await nativeFetch(endpoint(path), { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15_000), ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const retryAfterMs = typeof data?.retryAfterMs === 'number' && Number.isFinite(data.retryAfterMs) && data.retryAfterMs >= 0 ? data.retryAfterMs : undefined;
      throw new PasswordLoginFailure(response.status === 429 ? 'RATE_LIMITED' : response.status === 401 ? 'INVALID_PASSWORD' : 'LOGIN_UNAVAILABLE', retryAfterMs);
    }
    return response.json();
  };
  const { saltHex } = await request('/api/auth/password/parameters');
  const identity = await getIdentity();
  const state = await startPasswordBootstrap(password, saltHex);
  try {
    const started = await request('/api/auth/password/start', { startLoginRequest: state.startLoginRequest, clientIdentity: identity.peerId });
    const verified = await finishPasswordBootstrap(state, started, { clientIdentity: identity.peerId, origin: proofOrigin });
    await request('/api/auth/password/finish', { attemptId: verified.attemptId, finishLoginRequest: verified.finishLoginRequest });
    const address = proofOrigin === location.origin ? url : proofOrigin;
    return { url: address, targetPeerId: verified.serverIdentity, serviceName: new URL(address).host, serviceOrigin: address };
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
    if (!known?.targetPeerId) throw passwordLoginFailure(error);
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
    if (verified.serverIdentity !== intent.targetPeerId) throw new PasswordLoginFailure('IDENTITY_MISMATCH');
    await client.request({ type: 'password-finish', attemptId: verified.attemptId, finishLoginRequest: verified.finishLoginRequest });
  } catch (error) { throw passwordLoginFailure(error); }
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
    const failure = passwordLoginFailure(error);
    return Response.json({ error: failure.message, code: failure.code, retryAfterMs: failure.retryAfterMs }, { status: failure.status });
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
  return relayConnectionRoutes({ ...intent, routes: candidates });
}
const relayRouteKey = (route: ServiceRoute) => `relay:${route.targetPeerId}:${route.url}`;
/** Recovery may inspect other saved, pinned services for a known target.
 * Directory membership never implies permission: B must expose and authorize A.
 * A new target only considers entries with an existing forward relationship. */
async function reverseConnectionRoutes(intent: ConnectionIntent): Promise<ServiceRoute[]> {
  const explicit = connectionRoutes(intent);
  const seen = new Set(explicit.map(relayRouteKey));
  const candidates: ServiceRoute[] = [];
  const services = await listServiceConnections();
  const knownTarget = services.some(service => service.targetPeerId === intent.targetPeerId);
  for (const service of services) {
    if (!service.targetPeerId || service.targetPeerId === intent.targetPeerId
      || (!knownTarget && !connectionRoutes({ ...service, targetPeerId: service.targetPeerId }).some(route => route.targetPeerId === intent.targetPeerId))) continue;
    for (const url of connectionAddresses({ ...service, targetPeerId: service.targetPeerId })) {
      const route = { url, targetPeerId: service.targetPeerId };
      if (!seen.has(relayRouteKey(route))) { seen.add(relayRouteKey(route)); candidates.push(route); }
    }
  }
  return candidates.slice(0, Math.max(0, MAX_SAVED_ROUTES - Math.max(intent.routes?.length ?? 0, explicit.length)));
}
/** Every direct address must authenticate as the same pinned service. Keep
 * alternate addresses in the existing route format so desktop bridges preserve
 * them too, without requiring a native-shell update.
 */
export function connectionAddresses(intent: ConnectionIntent): string[] {
  const relays = connectionRoutes(intent);
  return directConnectionAddresses({ ...intent, routes: [...relays, ...(intent.routes || [])] });
}
function secureUrl(address: string): string {
  return serviceEndpoint(address).href;
}
async function connectEntry(route: ServiceRoute, signal?: AbortSignal): Promise<SecureClient> {
  return connect({ url: secureUrl(route.url), targetPeerId: route.targetPeerId, identity: await getIdentity(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
}
async function openTargetForAuthentication(intent: ConnectionIntent, outerSignal?: AbortSignal,
  readOnly?: { connected: (key: string) => void }): Promise<SecureClient> {
  const identity = await getIdentity();
  const attempts: ConnectionAttempt<SecureClient>[] = connectionAddresses(intent).map(origin => ({
    key: `direct:${origin}`,
    run: signal => connect({ url: secureUrl(origin), targetPeerId: intent.targetPeerId, identity,
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000), ...(outerSignal ? [outerSignal] : [])]) }),
  }));
  // Directory reads may use saved grants, never discover/authorize a reverse
  // route as a side effect of opening a settings panel.
  const reverseRoutes = readOnly ? [] : await reverseConnectionRoutes(intent);
  for (const route of [...connectionRoutes(intent), ...reverseRoutes].filter(route => allowedEntry(intent.targetPeerId, route.targetPeerId))) attempts.push({ key: relayRouteKey(route), run: async signal => {
    if (outerSignal) signal = AbortSignal.any([signal, outerSignal]);
    const reused = [active, entryClient].find(client => client && !client.closed && client.targetPeerId === route.targetPeerId);
    const entry = reused || await connectEntry(route, signal);
    try {
      if (signal.aborted) throw signal.reason;
      // Connection recovery never recreates a revoked route grant.
      const ticket = await entry.request({ type: 'route-ticket', serviceId: intent.targetPeerId }, { timeoutMs: 5000 })
        .catch(error => { throw relayAuthorizationError(error, { targetServiceId: intent.targetPeerId, entryServiceId: route.targetPeerId, entryUrl: route.url }); });
      if (signal.aborted) throw signal.reason;
      if (typeof ticket.routeToken !== 'string') throw new Error('入口未允许此设备连接该服务。');
      const url = new URL(secureUrl(route.url)); url.pathname = '/api/federation/relay'; url.searchParams.set('routeToken', ticket.routeToken);
      return await connect({ url: url.href, targetPeerId: intent.targetPeerId, identity, socketFactory: createRelaySocketFactory(intent.targetPeerId, { entryServiceId: route.targetPeerId, entryUrl: route.url }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(RELAY_CLIENT_CONNECT_TIMEOUT_MS)]) });
    } finally { if (!reused) entry.close(); }
  } });
  const preferred = preferredConnectionPath(intent.targetPeerId);
  attempts.sort((a, b) => Number(b.key === preferred) - Number(a.key === preferred));
  const result = await raceConnectionAttempts(attempts, client => client.close(), false, { signal: outerSignal });
  if (readOnly) readOnly.connected(result.key);
  else rememberConnectionPath(intent.targetPeerId, result.key);
  return result.value;
}
/** Read public bootstrap metadata through the saved, pinned Noise identity.
 * This does not require borrowing that service window's device authorization. */
export async function readPinnedCollaborationDescriptor(intent: ConnectionIntent, signal: AbortSignal): Promise<{ serviceId: string; origin?: string; caFingerprint256?: string }> {
  const client = await openTargetForAuthentication(intent, signal);
  try {
    const result = await client.request({ type: 'collaboration-descriptor' }, { timeoutMs: 5000 });
    const node = result.node as { serviceId?: unknown; origin?: string; caFingerprint256?: string } | undefined;
    if (node?.serviceId !== intent.targetPeerId) throw new Error('PEER_IDENTITY_MISMATCH');
    return { ...node, serviceId: intent.targetPeerId };
  } finally { client.close(); }
}
/** Open another saved service without replacing this page's active target or stores. */
export async function openAuthorizedServiceClient(intent: ConnectionIntent, signal: AbortSignal): Promise<SecureClient> {
  const client = await openTargetForAuthentication(intent, signal);
  const abort = () => client.close();
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    await readDeviceAuthorization(client, { timeoutMs: 3000 });
    if (signal.aborted) throw signal.reason;
    return client;
  } catch (error) { client.close(); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}
export async function connectDevice(intent: ConnectionIntent, options: { rememberOnly?: boolean; renewIfCurrent?: SecureClient; directOnly?: boolean } = {}): Promise<SecureClient> {
  if (intent.entryServiceId) assertRelayTarget(intent.entryServiceId, intent.targetPeerId);
  const previous = active, previousEntry = entryClient;
  const identity = await getIdentity();
  const serviceOrigin = normalizeServiceAddress(intent.serviceOrigin || intent.url);
  const known = (await listServiceConnections()).find(item => item.targetPeerId === intent.targetPeerId);
  const savedIntent = { ...intent, routes: intent.routes ?? known?.routes };
  if (intent.routeCode && intent.entryServiceId) deniedEntries.get(intent.targetPeerId)?.delete(intent.entryServiceId);
  const reverseRoutes = options.directOnly || accessBlocks.get(intent.targetPeerId)?.code === 'RELAY_AUTHORIZATION_REQUIRED' ? [] : await reverseConnectionRoutes(savedIntent);
  const routes = options.directOnly ? [] : [...connectionRoutes(savedIntent), ...reverseRoutes].filter(route => allowedEntry(intent.targetPeerId, route.targetPeerId));
  const addresses = connectionAddresses(savedIntent);
  let next: SecureClient | undefined, nextEntry: SecureClient | undefined;
  let pairingCode = intent.pairingCode;
  let path: 'direct' | 'relay' = 'direct';
  const openedEntries = new Set<SecureClient>();
  const entryCache = new Map<string, SecureClient>();
  const entryFor = async (route: ServiceRoute, signal?: AbortSignal) => {
    if (previous && !previous.closed && previous.targetPeerId === route.targetPeerId) return previous;
    if (previousEntry && !previousEntry.closed && previousEntry.targetPeerId === route.targetPeerId) return previousEntry;
    const key = JSON.stringify([route.targetPeerId, route.url]);
    const cached = entryCache.get(key); if (cached && !cached.closed) return cached;
    const entry = await connectEntry(route, signal); openedEntries.add(entry); entryCache.set(key, entry); return entry;
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
        const ticket = await candidateEntry.request({ type: 'route-ticket', serviceId: intent.targetPeerId }, { timeoutMs: 5000 })
          .catch(error => { throw relayAuthorizationError(error, { targetServiceId: intent.targetPeerId, entryServiceId: route.targetPeerId, entryUrl: route.url }); });
        if (signal.aborted) throw signal.reason;
        if (typeof ticket.routeToken !== 'string' || !ticket.routeToken) throw new Error('入口未允许此设备连接该服务。');
        const url = new URL(secureUrl(route.url)); url.pathname = '/api/federation/relay'; url.searchParams.set('routeToken', ticket.routeToken);
        client = await connect({ url: url.href, targetPeerId: intent.targetPeerId, pairingCode, identity,
          socketFactory: createRelaySocketFactory(intent.targetPeerId, { entryServiceId: route.targetPeerId, entryUrl: route.url }), signal: AbortSignal.any([signal, AbortSignal.timeout(RELAY_CLIENT_CONNECT_TIMEOUT_MS)]) });
        pairingCode = undefined;
        await validate(client, signal);
        return { client, entry: candidateEntry, path: 'relay' };
      } catch (error) {
        client?.close();
        if (candidateEntry && candidateEntry !== previousEntry && candidateEntry !== previous) candidateEntry.close();
        const access = connectionAccessError(error, { targetServiceId: intent.targetPeerId,
          ...(error instanceof ConnectionAccessError && error.code === 'RELAY_AUTHORIZATION_REQUIRED' ? { entryServiceId: route.targetPeerId, entryUrl: route.url } : {}) });
        if (access) rememberDeniedEntry(access);
        throw access || error;
      }
    } });
    const preferred = preferredConnectionPath(intent.targetPeerId);
    attempts.sort((a, b) => Number(b.key === preferred) - Number(a.key === preferred));
    const result = await raceConnectionAttempts(attempts, transport => {
      transport.client.close();
      if (transport.entry && transport.entry !== previous && transport.entry !== previousEntry) transport.entry.close();
    }, !!pairingCode);
    next = result.value.client; nextEntry = result.value.entry; path = result.value.path;
    if (options.renewIfCurrent) {
      // A request or a manual service change may have happened during the
      // handshake. Never retire its transport or overwrite its saved selection.
      if (active !== options.renewIfCurrent || previous !== options.renewIfCurrent
        || previous.closed || !previous.canSwitchTransport
        || savedConnection()?.targetPeerId !== intent.targetPeerId) {
        next.close();
        for (const entry of openedEntries) if (entry !== entryClient && entry !== active) entry.close();
        return active ?? previous!;
      }
      active = next; activePath = path; entryClient = nextEntry;
      rememberConnectionPath(intent.targetPeerId, result.key);
      previous.retire();
      for (const client of new Set([previousEntry, ...openedEntries])) {
        if (client && client !== previous && client !== next && client !== nextEntry) client.close();
      }
      window.dispatchEvent(new Event(SECURE_STATE_EVENT));
      return next;
    }
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
    const reverse = reverseRoutes.find(route => relayRouteKey(route) === result.key);
    const savedRoutes = savedIntent.routes ?? connectionRoutes(savedIntent);
    const directOrigin = connectionAddresses(savedIntent)[0];
    const saved = { url: directOrigin || serviceOrigin, targetPeerId: intent.targetPeerId, serviceName,
      ...(directOrigin ? { serviceOrigin: directOrigin } : { entryServiceId: nextEntry?.targetPeerId || intent.entryServiceId }),
      routes: reverse ? [...savedRoutes, reverse] : savedRoutes };
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
    // This client has just returned valid target permissions. An explicit new
    // invitation/login must not inherit the previous connection's denial.
    accessBlocks.delete(intent.targetPeerId);
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
/** Prepare a fresh authenticated channel while the old one can still serve
 * traffic. Failure leaves it intact; its original cryptographic limits remain. */
export async function renewSecureTransport(): Promise<void> {
  const previous = active, selected = savedConnection();
  if (selected && accessBlocks.has(selected.targetPeerId)) return;
  if (renewing || probingDirect || connecting || !previous?.renewalDue
    || !previous.canSwitchTransport || !selected || performance.now() - lastRenewalAttemptAt < 30_000) return;
  lastRenewalAttemptAt = performance.now();
  renewing = true;
  try { await connectDevice(selected, { renewIfCurrent: previous }); }
  catch (error) {
    console.debug('[connection] renewal deferred', { reason: error instanceof Error ? error.message : 'unknown' });
  } finally { renewing = false; }
}
/** Periodically prefer direct connectivity again after VPN/LAN conditions
 * improve. Do not interrupt an upload or other in-flight HTTP operation. */
export async function preferDirectConnection(): Promise<void> {
  const previous = active, selected = savedConnection();
  if (selected && accessBlocks.has(selected.targetPeerId)) return;
  if (Date.now() - lastDirectProbe < 60_000 || renewing || probingDirect || activePath !== 'relay' || !previous || previous.closed || !previous.canSwitchTransport || !selected?.serviceOrigin) return;
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
/** Cancel only this caller's wait; other requests may share the connection. */
async function waitForActiveClient(signal?: AbortSignal | null): Promise<SecureClient> {
  if (!signal) return getActiveClient();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void getActiveClient().then(client => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else resolve(client);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}
export async function getActiveClient(): Promise<SecureClient> {
  const blocked = accessBlocks.get(savedConnection()?.targetPeerId || '');
  if (blocked) throw blocked;
  if (active && !active.closed) {
    // Regular permission checks also reach here while the terminal is idle.
    // Renewal prepares in the background; this caller retains its live channel.
    const current = active;
    void renewSecureTransport();
    return current;
  }
  active = undefined;
  if (connecting) return connecting;
  const saved = savedConnection();
  if (!saved) throw new Error('DEVICE_PAIRING_REQUIRED');
  connecting = connectDevice(saved, { rememberOnly: true }).catch(error => {
    if (active && !active.closed && active.targetPeerId === saved.targetPeerId) return active;
    const access = connectionAccessError(error, { targetServiceId: saved.targetPeerId });
    if (access) { pauseConnectionAccess(access); throw access; }
    throw error;
  }).finally(() => { connecting = undefined; });
  return connecting;
}
/** A denied entry cannot revoke the target's independent direct authorization.
 * Only the recovery gate retries here; ordinary callers remain paused. Never
 * request another route ticket or recreate a grant as part of this recovery. */
export async function retryDirectConnection(): Promise<SecureClient> {
  const selected = savedConnection();
  const blocked = accessBlocks.get(selected?.targetPeerId || '');
  if (!selected || blocked?.code !== 'RELAY_AUTHORIZATION_REQUIRED' || !connectionAddresses(selected).length) {
    throw blocked || new Error('没有可用的直连地址。');
  }
  if (connecting) return connecting;
  connecting = connectDevice(selected, { rememberOnly: true, directOnly: true }).then(client => {
    if (savedConnection()?.targetPeerId !== selected.targetPeerId || active !== client || activePath !== 'direct') throw blocked;
    accessBlocks.delete(selected.targetPeerId);
    return client;
  }).catch(error => {
    const access = connectionAccessError(error, { targetServiceId: selected.targetPeerId });
    if (access) { pauseConnectionAccess(access); throw access; }
    throw error;
  }).finally(() => { connecting = undefined; });
  return connecting;
}

/** A revoked entry is excluded across all its addresses. Recovery may use an
 * already-saved independent entry; it never discovers or grants a new route. */
export function canRetryConnectionAccess(selected = savedConnection(), blocked = accessBlocks.get(selected?.targetPeerId || '')): boolean {
  return !!selected && blocked?.code === 'RELAY_AUTHORIZATION_REQUIRED'
    && hasIndependentConnectionRoute(selected, blocked.context.entryServiceId, deniedEntries.get(selected.targetPeerId));
}
export async function retryConnectionAccess(): Promise<SecureClient> {
  const selected = savedConnection(), blocked = accessBlocks.get(selected?.targetPeerId || '');
  if (!selected || !canRetryConnectionAccess(selected, blocked)) throw blocked || new Error('没有独立的已保存连接路线。');
  const alternatives = connectionRoutes(selected).filter(route => allowedEntry(selected.targetPeerId, route.targetPeerId));
  if (!alternatives.length) return retryDirectConnection();
  if (connecting) return connecting;
  connecting = connectDevice(selected, { rememberOnly: true }).catch(error => {
    const access = connectionAccessError(error, { targetServiceId: selected.targetPeerId });
    if (access) pauseConnectionAccess(access);
    throw access || error;
  }).finally(() => { connecting = undefined; });
  return connecting;
}
export function secureSocket(url: string): WebSocket {
  const parsed = new URL(url, location.href);
  if (active && !active.closed && !accessBlocks.has(active.targetPeerId)) return active.openSocket(parsed.pathname + parsed.search) as unknown as WebSocket;
  let target: SecureSocket | undefined;
  const pending = new SecureSocket(url, data => target?.send(data), () => target?.close(), () => target?.bufferedAmount ?? 0);
  void getActiveClient().then(client => {
    if (pending.readyState === 3) return;
    target = client.openSocket(parsed.pathname + parsed.search);
    pending.getConnectionDiagnostics = () => {
      const details = target?.getConnectionDiagnostics?.();
      return details ? { ...details, socketOpenMs: pending.openedAfterMs } : undefined;
    };
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
    const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    const client = await waitForActiveClient(signal);
    if (input instanceof Request) return client.fetch(input, init);
    return client.fetch(url.pathname + url.search, init);
  };
}

export interface EntryRouteGrant { id: string; subjectId: string; targetServiceId: string; active: boolean; revokedAt?: number }
export interface RelayTarget { serviceId: string; label?: string; url?: string; available: boolean; authorized: boolean; error?: string }
export interface RelayTargetDirectory { route: ServiceRoute; canManage: boolean; items: RelayTarget[] }
function assertRelayTarget(entryId: string, targetId: string): void {
  if (entryId === targetId) throw new ConnectionAccessError('RELAY_SELF_TARGET', { entryServiceId: entryId, targetServiceId: targetId });
}
/** Borrow the page's exact pinned service channel, or own a temporary channel
 * over already saved routes. Release must never close a borrowed terminal. */
async function acquireEntryClient(route: ServiceRoute, known?: import('../services/serviceDirectory').ServiceConnection) {
  const origin = normalizeServiceAddress(route.url);
  const reused = [active, entryClient].find(client => client && !client.closed && client.targetPeerId === route.targetPeerId);
  if (reused) return { client: reused, route: { ...route, url: origin }, release() {} };
  const saved = known ?? (await listServiceConnections()).find(service => service.targetPeerId === route.targetPeerId);
  const routes = [...(saved?.routes ?? [])];
  if (saved?.targetPeerId && normalizeServiceAddress(saved.serviceOrigin || saved.url) !== origin) {
    routes.push({ url: saved.serviceOrigin || saved.url, targetPeerId: route.targetPeerId });
  }
  let connectedRoute = { ...route, url: origin };
  const client = await openTargetForAuthentication({ url: origin, targetPeerId: route.targetPeerId, routes }, AbortSignal.timeout(15000), {
    connected(key) { if (key.startsWith('direct:')) connectedRoute = { ...route, url: key.slice('direct:'.length) }; },
  });
  return { client, route: connectedRoute, release() { client.close(); } };
}
/** Browse only a pinned entry's explicit directory, without changing the active service. */
export async function listRelayTargets(service: import('../services/serviceDirectory').ServiceConnection): Promise<RelayTargetDirectory> {
  if (!service.targetPeerId) throw new Error('请先连接这台服务，再查看可中转的服务。');
  const lease = await acquireEntryClient({ url: service.serviceOrigin || service.url, targetPeerId: service.targetPeerId }, service);
  try {
    const result = await lease.client.request({ type: 'route-targets' }, { timeoutMs: 5000 });
    if (!Array.isArray(result.items)) throw new Error('入口服务需要更新后才能查看中转列表。');
    const seen = new Set<string>();
    const items = (result.items as RelayTarget[]).filter(target => {
      if (!target || typeof target.serviceId !== 'string' || !target.serviceId || target.serviceId === lease.client.targetPeerId || seen.has(target.serviceId)) return false;
      seen.add(target.serviceId); return true;
    });
    return { route: lease.route, canManage: result.canManage === true, items };
  } catch (error) {
    if (error instanceof Error && /UNKNOWN|UNSUPPORTED/i.test(error.message)) throw new Error('入口服务需要更新后才能查看中转列表。', { cause: error });
    throw error;
  } finally { lease.release(); }
}
export async function prepareRelayConnection(route: ServiceRoute, targetServiceId: string): Promise<ConnectionIntent> {
  assertRelayTarget(route.targetPeerId, targetServiceId);
  const lease = await acquireEntryClient(route), entry = lease.client;
  try {
    assertRelayTarget(entry.targetPeerId, targetServiceId);
    // Re-read visibility and grants at the click, so stale lists cannot authorize a target.
    const result = await entry.request({ type: 'route-targets' }, { timeoutMs: 5000 });
    const target = (Array.isArray(result.items) ? result.items as RelayTarget[] : []).find(item => item.serviceId === targetServiceId);
    if (!target) throw new Error('该服务已不可见，请刷新列表或请入口管理员授权。');
    if (!target.available) throw new Error(relayTargetFailure(target));
    const known = (await listServiceConnections()).find(item => item.targetPeerId === target.serviceId);
    const routes = [route, ...(known?.routes || []).filter(item => item.targetPeerId !== route.targetPeerId || normalizeServiceAddress(item.url) !== normalizeServiceAddress(route.url))];
    if (routes.length > MAX_SAVED_ROUTES) throw new Error(`这台服务已保存 ${MAX_SAVED_ROUTES} 个备用连接，请先移除一个后重试。`);
    if (!target.authorized) {
      if (!result.canManage) throw new Error('请先让入口管理员授权此设备。');
      await entry.request({ type: 'route-grant', serviceId: target.serviceId, subjectId: (await getIdentity()).peerId });
    }
    deniedEntries.get(targetServiceId)?.delete(route.targetPeerId);
    const direct = known ? connectionAddresses({ ...known, targetPeerId: target.serviceId })[0] : undefined;
    const origin = direct || (target.url && normalizeServiceAddress(target.url) !== normalizeServiceAddress(route.url) ? target.url : undefined);
    return { url: origin || route.url, ...(origin ? { serviceOrigin: origin } : { entryServiceId: route.targetPeerId }), targetPeerId: target.serviceId, serviceName: known?.label || relayTargetName(target), routes };
  } finally { lease.release(); }
}
export async function inspectEntryRoute(route: ServiceRoute, targetServiceId: string): Promise<{ canManage: boolean; grants: EntryRouteGrant[] }> {
  assertRelayTarget(route.targetPeerId, targetServiceId);
  const lease = await acquireEntryClient(route), client = lease.client;
  try {
    const result = await client.request({ type: 'route-access' }, { timeoutMs: 5000 });
    const subjectId = (await getIdentity()).peerId;
    return { canManage: result.canManage === true, grants: (Array.isArray(result.grants) ? result.grants as EntryRouteGrant[] : []).filter(grant => grant.subjectId === subjectId && grant.targetServiceId === targetServiceId) };
  } finally { lease.release(); }
}
export async function authorizeEntryRoute(target: ConnectionIntent, route: ServiceRoute, password?: string): Promise<void> {
  assertRelayTarget(route.targetPeerId, target.targetPeerId);
  if (password !== undefined) {
    const verified = await authenticateServicePassword(normalizeServiceAddress(route.url), password);
    if (verified.targetPeerId !== route.targetPeerId) throw new Error('入口服务的身份已改变，请重新连接并确认。');
  }
  const lease = await acquireEntryClient(route), entry = lease.client;
  try {
    await entry.request({ type: 'route-grant', serviceId: target.targetPeerId, subjectId: (await getIdentity()).peerId, url: normalizeServiceAddress(target.serviceOrigin || target.url) });
    deniedEntries.get(target.targetPeerId)?.delete(route.targetPeerId);
  } finally { lease.release(); }
}
export async function revokeEntryRoute(targetServiceId: string, route: ServiceRoute): Promise<void> {
  const lease = await acquireEntryClient(route), entry = lease.client;
  try {
    const result = await entry.request({ type: 'route-access' }, { timeoutMs: 5000 });
    const subjectId = (await getIdentity()).peerId;
    const grants = (Array.isArray(result.grants) ? result.grants as EntryRouteGrant[] : []).filter(grant => grant.subjectId === subjectId && grant.targetServiceId === targetServiceId && grant.active);
    for (const grant of grants) await entry.request({ type: 'route-revoke', grantId: grant.id });
  } finally { lease.release(); }
}
export async function createEntryInvitation(target: ConnectionIntent, route: ServiceRoute): Promise<{ routeCode: string; expiresAt: number }> {
  assertRelayTarget(route.targetPeerId, target.targetPeerId);
  const lease = await acquireEntryClient(route), entry = lease.client;
  try {
    const result = await entry.request({ type: 'route-invite-create', serviceId: target.targetPeerId });
    if (typeof result.routeCode !== 'string' || typeof result.expiresAt !== 'number') throw new Error('暂时无法生成备用连接邀请。');
    return { routeCode: result.routeCode, expiresAt: result.expiresAt };
  } finally { lease.release(); }
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
    if (existing.length >= MAX_SAVED_ROUTES) throw new Error(`最多保存 ${MAX_SAVED_ROUTES} 个备用地址或入口，请先移除不再使用的连接。`);
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
