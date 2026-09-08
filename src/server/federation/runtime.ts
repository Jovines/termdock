import { PasswordBootstrapServer } from './passwordBootstrap.js';
import { DeviceNames } from './deviceNames.js';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type express from 'express';
import type WebSocket from 'ws';
import { createIdentity, importIdentity, exportIdentity, secureConnection, type Identity } from './secureProtocol.js';
import { InvitationStore, validateInvitation, type InvitationInput } from './invitations.js';
import { AuthorizationStore, type GrantInput } from './authorization.js';
import { resolveAccessRequest, isBusinessApiPath, terminalMessageAction } from './accessPolicy.js';
import { AsyncQueue, PacketChannel, toBase64, fromBase64, type Packet } from './packets.js';
import { socketDuplex } from './socketDuplex.js';
import { markEncryptedRequest } from './requestContext.js';
import { readTerminalHandshakeDimensions } from '../utils/terminalHandshakeDimensions.js';
import { openAccessAllowed } from './openAccess.js';
import { isAuthEnabled, getPasswordCredentialFingerprint, getPasswordVerifier, getLoginBlockMs, recordLoginFailure, recordLoginSuccess } from '../utils/authProtection.js';
import { MAX_OPEN_SECURE_SOCKETS, MAX_SERVER_HTTP_REQUESTS } from './streamLimits.js';

interface SocketHandlers {
  terminal(socket: WebSocket, sessionId: string, clientId: string, options: {sinceSeq?: number; streamEpoch?: string; flowControl?: boolean; independentTmux?: boolean; outputActive?: boolean}, dimensions?: {cols: number; rows: number}): void;
  control(socket: WebSocket, clientId: string): void;
}
class LogicalSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  constructor(private channel: PacketChannel, readonly id: string, private canRead: () => boolean) { super(); }
  send(data: string): void {
    if (this.readyState !== 1) return;
    if (!this.canRead()) { this.close(4003, 'Authorization revoked'); return; }
    try { this.channel.send({ type: 'ws-data', id: this.id, data }); }
    catch (error) { this.channel.close(error instanceof Error ? error : new Error('Output transport failed')); this.close(); }
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    try { this.channel.send({ type: 'ws-close', id: this.id, code, reason }); }
    catch { /* Transport closure must still release backend observers and timers. */ }
    finally { this.emit('close'); }
  }
}
interface HttpOperation { head: Packet; body: AsyncQueue<Uint8Array>; size: number; abort: AbortController; state: 'uploading' | 'running'; updatedAt: number; uploadSlot: boolean; ack?: () => void }
export interface FederationRuntimeOptions {
  listRouteAccess?: () => Array<{ id: string; subjectId: string; targetServiceId: string; active: boolean; revokedAt?: number }>;
  grantRouteAccess?: (issuerId: string, targetServiceId: string, subjectId: string, url?: string) => unknown;
  revokeRouteAccess?: (id: string) => boolean;
  createRouteInvitation?: (issuerId: string, targetServiceId: string) => { routeCode: string; expiresAt: number };
  consumeRouteInvitation?: (code: string, subjectId: string) => { serviceId: string };
  hasRouteGrant?: (subjectId: string, targetServiceId: string) => boolean;
  issueRouteTicket?: (subjectId: string, targetServiceId: string) => { routeToken: string; expiresAt: number };
}

/** The internal HTTP listener is private and carries only already-authorized requests.
 * No outer Cookie or origin credential is forwarded across a service boundary. */
export async function createFederationRuntime(app: express.Express, directory: string, handlers: SocketHandlers, options: FederationRuntimeOptions = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identityFile = join(directory, 'identity.key');
  let identity: Identity;
  try { identity = importIdentity(readFileSync(identityFile, 'utf8')); chmodSync(identityFile, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    identity = await createIdentity(); writeFileSync(identityFile, exportIdentity(identity), { mode: 0o600, flag: 'wx' });
  }
  const serviceId = identity.peerId;
  const passwordBootstrap = new PasswordBootstrapServer({ getPasswordHash: getPasswordVerifier, serverIdentity: serviceId });
  let passwordComputing = 0; const passwordStarts: number[] = [];
  const passwordAttempts = new Map<string, string>();
  const store = new AuthorizationStore({ serviceId, filePath: join(directory, 'grants.json'), passwordCredential: getPasswordCredentialFingerprint });
  const deviceNames = new DeviceNames(join(directory, 'device-names.json'));
  const invitations = new InvitationStore({ serviceId, filePath: join(directory, 'invitations.json') });
  let pairingCode = randomBytes(32).toString('base64url');
  const savePairing = () => {
    const path = join(directory, 'pairing.json');
    writeFileSync(path, JSON.stringify({ serviceId, pairingCode }, null, 2), { mode: 0o600 }); chmodSync(path, 0o600);
  };
  savePairing();
  const internalToken = randomBytes(32).toString('base64url');
  const internal = createServer((request, response) => {
    if (request.headers['x-termdock-inner'] !== internalToken) { response.writeHead(403).end(); return; }
    delete request.headers['x-termdock-inner'];
    markEncryptedRequest(request); app(request, response);
  });
  await new Promise<void>((resolve, reject) => { internal.once('error', reject); internal.listen(0, '127.0.0.1', resolve); });
  const address = internal.address();
  if (!address || typeof address === 'string') throw new Error('Internal transport unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const channels = new Set<PacketChannel>();
  let uploadSlots = 0;
  const releaseUpload = (operation: HttpOperation) => { if (operation.uploadSlot) { operation.uploadSlot = false; uploadSlots--; } };
  const cancelHttp = (operation: HttpOperation) => { operation.abort.abort(); operation.body.end(new Error('CANCELLED')); releaseUpload(operation); };

  async function sessionInventory(): Promise<Array<Record<string, unknown>>> {
    const response = await fetch(`${baseUrl}/api/terminal/session-inventory`, { headers: { 'x-termdock-inner': internalToken }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('SESSION_INVENTORY_UNAVAILABLE');
    const inventory = await response.json() as { clientSessions?: Array<Record<string, unknown>> };
    return Array.isArray(inventory.clientSessions) ? inventory.clientSessions : [];
  }

  async function accept(socket: WebSocket, context: { allowOpenAccess?: boolean } = {}): Promise<void> {
    const open = (action?: string) => openAccessAllowed(context.allowOpenAccess === true, isAuthEnabled(), action);
    const allowed = (subjectId: string, action: string, sessionId?: string) => open(action) || store.authorize({ subjectId, serviceId, action, sessionId }).allowed;
    const full = (subjectId: string) => open() || store.hasFullServiceAccess({ subjectId, serviceId });
    let channel: PacketChannel | undefined;
    const operations = new Map<string, HttpOperation>();
    const sockets = new Map<string, { socket: LogicalSocket; sessionId?: string }>();
    let revokeTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const secured = await secureConnection({ identity, duplex: socketDuplex(socket), initiator: false, signal: AbortSignal.timeout(15000) });
      const subjectId = secured.authenticatedPeerId;
      channel = new PacketChannel(secured.duplex); channels.add(channel);
      const send = (packet: Packet) => channel!.send(packet);
      const check = (action: string, sessionId?: string) => { if (!allowed(subjectId, action, sessionId)) throw new Error('AUTHORIZATION_DENIED'); };
      const httpAllowed = (head: Packet) => {
        if (typeof head.method !== 'string' || typeof head.path !== 'string' || !isBusinessApiPath(head.method, head.path)) throw new Error('API_NOT_ALLOWED');
        const policy = resolveAccessRequest(head.method, head.path);
        if (!full(subjectId)) { if (!policy) throw new Error('API_NOT_ALLOWED'); check(policy.action, policy.sessionId); }
      };
      async function runHttp(id: string, operation: HttpOperation) {
        const sendHttp = (packet: Packet) => {
          if (operations.get(id) !== operation || operation.abort.signal.aborted) throw new Error('CANCELLED');
          httpAllowed(operation.head); send(packet);
        };
        try {
          httpAllowed(operation.head);
          const headers = new Headers({ 'x-termdock-inner': internalToken });
          const supplied = operation.head.headers;
          if (supplied && typeof supplied === 'object') for (const [name, value] of Object.entries(supplied)) {
            if (['content-type', 'accept', 'range', 'if-none-match', 'if-modified-since'].includes(name.toLowerCase()) && typeof value === 'string') headers.set(name, value);
          }
          const method = String(operation.head.method);
          async function* uploadBody() {
            for await (const bytes of operation.body) {
              if (operation.abort.signal.aborted) throw new Error('CANCELLED');
              httpAllowed(operation.head);
              yield bytes;
              // Undici requests the next chunk only after accepting the previous
              // chunk into its bounded network stream. No whole-body accumulator.
              sendHttp({ type: 'upload-ack', id });
            }
            releaseUpload(operation);
          }
          const request: RequestInit & { duplex: 'half' } = { method, headers,
            body: ['GET', 'HEAD'].includes(method) ? undefined : uploadBody() as unknown as RequestInit['body'],
            duplex: 'half', signal: operation.abort.signal, redirect: 'manual' };
          const response = await fetch(baseUrl + operation.head.path, request);
          if (operation.state !== 'running') { await response.body?.cancel(); throw new Error(`UPLOAD_REJECTED_${response.status}`); }
          httpAllowed(operation.head);
          sendHttp({ type: 'head', id, status: response.status, headers: Object.fromEntries([...response.headers].filter(([name]) => !['set-cookie', 'connection', 'transfer-encoding', 'content-encoding', 'content-length'].includes(name))) });
          const reader = response.body?.getReader();
          if (reader) while (true) {
            httpAllowed(operation.head);
            const { done, value } = await reader.read(); if (done) break;
            for (let offset = 0; offset < value.length; offset += 65536) {
              httpAllowed(operation.head);
              await new Promise<void>((resolve, reject) => {
                const cleanup = () => { clearTimeout(timeout); operation.abort.signal.removeEventListener('abort', abort); operation.ack = undefined; };
                const timeout = setTimeout(() => { cleanup(); reject(new Error('CONSUMER_TIMEOUT')); }, 30000);
                const abort = () => { cleanup(); reject(new Error('CANCELLED')); };
                operation.abort.signal.addEventListener('abort', abort, { once: true });
                operation.ack = () => { cleanup(); resolve(); };
                if (operation.abort.signal.aborted) { abort(); return; }
                try { sendHttp({ type: 'chunk', id, data: toBase64(value.subarray(offset, offset + 65536)) }); }
                catch (error) { cleanup(); reject(error); }
              });
            }
          }
          sendHttp({ type: 'end', id });
        } catch (error) { try { if (operations.get(id) === operation) send({ type: 'error', id, error: error instanceof Error ? error.message : 'REQUEST_FAILED' }); } catch { /* The encrypted connection has closed. */ } }
        finally { cancelHttp(operation); if (operations.get(id) === operation) operations.delete(id); }
      }
      revokeTimer = setInterval(() => {
        for (const { socket: logical, sessionId } of sockets.values()) {
          if (!allowed(subjectId, sessionId ? 'session.view' : 'service.view', sessionId)) logical.close(4003, 'Authorization revoked');
        }
        for (const [id, operation] of operations) try {
          httpAllowed(operation.head);
          if (operation.state === 'uploading' && Date.now() - operation.updatedAt > 30_000) throw new Error('UPLOAD_TIMEOUT');
        } catch {
          cancelHttp(operation);
          if (operation.state === 'uploading') operations.delete(id);
        }
      }, 1000);
      for await (const packet of channel.read()) {
        try {
          if (packet.id.length > 128) throw new Error('INVALID_ID');
          if (packet.type === 'password-parameters') {
            send({ type: 'result', id: packet.id, ...passwordBootstrap.parameters() });
          } else if (packet.type === 'password-start') {
            const now = Date.now(), loginKey = `secure:${subjectId}`;
            while (passwordStarts.length && passwordStarts[0] <= now - 60_000) passwordStarts.shift();
            if (getLoginBlockMs(loginKey) || passwordStarts.length >= 30 || passwordComputing >= 2) throw new Error('LOGIN_RATE_LIMIT');
            if (typeof packet.startLoginRequest !== 'string' || typeof packet.origin !== 'string') throw new Error('INVALID_LOGIN');
            passwordStarts.push(now); passwordComputing++; recordLoginFailure(loginKey);
            try {
              const result = await passwordBootstrap.start({ startLoginRequest: packet.startLoginRequest, clientIdentity: subjectId, origin: packet.origin });
              if (passwordAttempts.size >= 64) passwordAttempts.delete(passwordAttempts.keys().next().value!);
              passwordAttempts.set(result.attemptId, subjectId);
              send({ type: 'result', id: packet.id, ...result });
            } finally { passwordComputing--; }
          } else if (packet.type === 'password-finish') {
            if (typeof packet.attemptId !== 'string' || typeof packet.finishLoginRequest !== 'string' || passwordAttempts.get(packet.attemptId) !== subjectId) throw new Error('INVALID_LOGIN');
            passwordAttempts.delete(packet.attemptId);
            const result = await passwordBootstrap.finish({ attemptId: packet.attemptId, finishLoginRequest: packet.finishLoginRequest });
            if (result.clientIdentity !== subjectId) throw new Error('INVALID_LOGIN');
            store.grantPassword(subjectId); recordLoginSuccess(`secure:${subjectId}`);
            send({ type: 'result', id: packet.id, ok: true });
          } else if (packet.type === 'pair') {

            const supplied = Buffer.from(typeof packet.code === 'string' ? packet.code : '');
            const expected = Buffer.from(pairingCode);
            if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
              // Rotate before granting: a persistence failure cannot reuse a bootstrap code.
              pairingCode = randomBytes(32).toString('base64url'); savePairing();
              store.grant({ subjectId, scope: { kind: 'service' }, actions: ['service:*'], canDelegate: true });
            } else {
              const grant = invitations.consume(typeof packet.code === 'string' ? packet.code : '', subjectId, issuer => allowed(issuer, 'authorization.manage'));
              store.grant(grant);
            }
            send({ type: 'result', id: packet.id, serviceId, subjectId });
          } else if (packet.type === 'logout') {
            for (const grant of store.list()) if (grant.subjectId === subjectId) store.revoke(grant.id);
            send({ type: 'result', id: packet.id, ok: true });
          } else if (packet.type === 'permissions') {
            const grants = store.listEffective({ subjectId, serviceId });
            send({ type: 'result', id: packet.id, subjectId, serviceId, fullService: full(subjectId), grants });
          } else if (packet.type === 'session-list') {
            const inventory = await sessionInventory();
            const seen = new Set<string>();
            const items = inventory.flatMap(session => {
              const sessionId = session.backendSessionId;
              if (typeof sessionId !== 'string' || !sessionId || seen.has(sessionId) || !allowed(subjectId, 'session.view', sessionId)) return [];
              seen.add(sessionId);
              return [{ sessionId, ...(typeof session.sessionId === 'string' ? { sourceSessionId: session.sessionId } : {}),
                name: typeof session.name === 'string' ? session.name : sessionId, live: session.live === true,
                canWrite: allowed(subjectId, 'session.input', sessionId), canResize: allowed(subjectId, 'session.resize', sessionId) }];
            });
            send({ type: 'result', id: packet.id, items });
          } else if (packet.type === 'route-invite-create') {
            check('authorization.manage');
            if (!options.createRouteInvitation || typeof packet.serviceId !== 'string' || !packet.serviceId || packet.serviceId.length > 512) throw new Error('ROUTE_NOT_AVAILABLE');
            send({ type: 'result', id: packet.id, ...options.createRouteInvitation(subjectId, packet.serviceId) });
          } else if (packet.type === 'route-pair') {
            if (!options.consumeRouteInvitation || typeof packet.code !== 'string') throw new Error('PAIRING_DENIED');
            send({ type: 'result', id: packet.id, ...options.consumeRouteInvitation(packet.code, subjectId) });
          } else if (packet.type === 'route-access') {
            const all = options.listRouteAccess?.() || [];
            const canManage = allowed(subjectId, 'authorization.manage');
            send({ type: 'result', id: packet.id, canManage, grants: canManage ? all : all.filter(grant => grant.subjectId === subjectId) });
          } else if (packet.type === 'route-grant') {
            check('authorization.manage');
            if (!options.grantRouteAccess || typeof packet.serviceId !== 'string' || typeof packet.subjectId !== 'string') throw new Error('ROUTE_NOT_AVAILABLE');
            send({ type: 'result', id: packet.id, grant: await options.grantRouteAccess(subjectId, packet.serviceId, packet.subjectId, typeof packet.url === 'string' ? packet.url : undefined) });
          } else if (packet.type === 'route-revoke') {
            const grant = options.listRouteAccess?.().find(item => item.id === packet.grantId);
            if (!grant || (grant.subjectId !== subjectId && !allowed(subjectId, 'authorization.manage'))) throw new Error('AUTHORIZATION_DENIED');
            if (!options.revokeRouteAccess || typeof packet.grantId !== 'string') throw new Error('ROUTE_NOT_AVAILABLE');
            send({ type: 'result', id: packet.id, revoked: options.revokeRouteAccess(packet.grantId) });
          } else if (packet.type === 'route-ticket') {
            if (typeof packet.serviceId !== 'string' || !options.hasRouteGrant?.(subjectId, packet.serviceId)) throw new Error('AUTHORIZATION_DENIED');
            if (!options.issueRouteTicket || typeof packet.serviceId !== 'string' || !packet.serviceId || packet.serviceId.length > 512) throw new Error('ROUTE_NOT_AVAILABLE');
            send({ type: 'result', id: packet.id, ...options.issueRouteTicket(subjectId, packet.serviceId) });
          } else if (packet.type === 'invite-create') {
            check('authorization.manage');
            const invitation = { scope: packet.scope, actions: packet.actions,
              ...(packet.label === undefined ? {} : { label: packet.label }),
              ...(packet.expiresAt === undefined ? {} : { expiresAt: packet.expiresAt }) };
            validateInvitation(invitation);
            if (invitation.scope.kind === 'sessions') {
              const known = new Set((await sessionInventory()).filter(session => session.live === true).map(session => session.backendSessionId));
              if (!invitation.scope.sessionIds.every(id => known.has(id))) throw new Error('UNKNOWN_SESSION');
            }
            check('authorization.manage');
            send({ type: 'result', id: packet.id, serviceId, ...invitations.create(subjectId, invitation as InvitationInput) });
          } else if (packet.type === 'device-name') {
            const target = typeof packet.subjectId === 'string' ? packet.subjectId : subjectId;
            if (target !== subjectId) check('authorization.manage');
            if (!store.listEffective({ subjectId: target, serviceId }).length && !(target === subjectId && (full(subjectId) || options.listRouteAccess?.().some(grant => grant.subjectId === subjectId && grant.active)))) throw new Error('AUTHORIZATION_DENIED');
            const existing = invitations.subjectLabels()[target];
            const name = packet.onlyIfMissing === true && existing && !deviceNames.list()[target] ? existing : deviceNames.set(target, packet.name, packet.onlyIfMissing === true);
            send({ type: 'result', id: packet.id, name });
          } else if (packet.type === 'grants-list') {
            check('authorization.manage'); send({ type: 'result', id: packet.id, grants: store.list(), subjectLabels: { ...invitations.subjectLabels(), ...deviceNames.list() } });
          } else if (packet.type === 'grant') {
            check('authorization.manage'); send({ type: 'result', id: packet.id, grant: store.grant(packet.grant as GrantInput) });
          } else if (packet.type === 'revoke') {
            check('authorization.manage'); send({ type: 'result', id: packet.id, revoked: store.revoke(String(packet.grantId)) });
          } else if (packet.type === 'delegate') {
            const grant = store.delegate(String(packet.parentGrantId), subjectId, packet.grant as GrantInput); send({ type: 'result', id: packet.id, grant });
          } else if (packet.type === 'http') {
            if (operations.size >= MAX_SERVER_HTTP_REQUESTS || operations.has(packet.id) || sockets.has(packet.id)) throw new Error('STREAM_LIMIT');
            httpAllowed(packet);
            const upload = !['GET', 'HEAD'].includes(String(packet.method));
            if (upload && uploadSlots >= 8) throw new Error('UPLOAD_CONCURRENCY_LIMIT');
            const operation: HttpOperation = { head: packet, body: new AsyncQueue<Uint8Array>(2), size: 0, abort: new AbortController(), state: 'uploading', updatedAt: Date.now(), uploadSlot: upload };
            if (upload) uploadSlots++;
            operations.set(packet.id, operation);
            if (upload) void runHttp(packet.id, operation);
          } else if (packet.type === 'upload') {
            const operation = operations.get(packet.id); if (!operation || operation.state !== 'uploading' || typeof packet.data !== 'string') throw new Error('INVALID_UPLOAD');
            httpAllowed(operation.head);
            const bytes = fromBase64(packet.data); operation.size += bytes.length;
            const limit = new URL(String(operation.head.path), 'http://inner').pathname === '/api/terminal/fs/upload' ? 110 * 1024 * 1024 : 5 * 1024 * 1024;
            if (['GET', 'HEAD'].includes(String(operation.head.method)) || bytes.length > 65536 || operation.size > limit) { cancelHttp(operation); operations.delete(packet.id); throw new Error('UPLOAD_LIMIT'); }
            operation.updatedAt = Date.now();
            try { operation.body.push(bytes); } catch { cancelHttp(operation); operations.delete(packet.id); throw new Error('UPLOAD_QUEUE_LIMIT'); }
          } else if (packet.type === 'upload-end') {
            const operation = operations.get(packet.id); if (!operation || operation.state !== 'uploading') throw new Error('INVALID_STREAM');
            operation.state = 'running'; operation.body.end();
            if (['GET', 'HEAD'].includes(String(operation.head.method))) void runHttp(packet.id, operation);
          } else if (packet.type === 'ack') {
            const operation = operations.get(packet.id); operation?.ack?.(); if (operation) operation.ack = undefined;
          } else if (packet.type === 'cancel') {
            const operation = operations.get(packet.id); if (operation) cancelHttp(operation); operations.delete(packet.id);
          } else if (packet.type === 'ws-open') {
            if (sockets.size >= MAX_OPEN_SECURE_SOCKETS || operations.has(packet.id) || sockets.has(packet.id)) throw new Error('STREAM_LIMIT');
            if (typeof packet.path !== 'string' || !isBusinessApiPath('GET', packet.path)) throw new Error('API_NOT_ALLOWED');
            const url = new URL(packet.path, 'http://inner');
            const match = /^\/api\/terminal\/([^/%]+)\/ws$/.exec(url.pathname);
            if (match) check('session.view', match[1]);
            else if (url.pathname === '/api/control/ws') check('service.view');
            else throw new Error('API_NOT_ALLOWED');
            const logical = new LogicalSocket(channel, packet.id, () => allowed(subjectId, match ? 'session.view' : 'service.view', match?.[1]));
            sockets.set(packet.id, { socket: logical, sessionId: match?.[1] });
            logical.once('close', () => sockets.delete(packet.id));
            send({ type: 'ws-ready', id: packet.id });
            if (match) handlers.terminal(logical as unknown as WebSocket, match[1], randomUUID(), {
              sinceSeq: Math.max(0, Number(url.searchParams.get('since')) || 0), streamEpoch: url.searchParams.get('epoch') ?? undefined,
              flowControl: url.searchParams.get('flow') === '2', outputActive: url.searchParams.get('active') !== '0',
              independentTmux: full(subjectId) && url.searchParams.get('transport') === 'tmux-client',
            }, allowed(subjectId, 'session.resize', match[1]) ? readTerminalHandshakeDimensions(url.searchParams) : undefined);
            else handlers.control(logical as unknown as WebSocket, randomUUID());
          } else if (packet.type === 'ws-data') {
            const item = sockets.get(packet.id); if (!item || typeof packet.data !== 'string') throw new Error('INVALID_STREAM');
            const data = JSON.parse(packet.data);
            if (item.sessionId) { const action = terminalMessageAction(data.type); if (!action) throw new Error('ACTION_NOT_ALLOWED'); check(action, action.startsWith('session.') ? item.sessionId : undefined); }
            else { check('service.view'); if (data?.type !== 'pong') throw new Error('ACTION_NOT_ALLOWED'); }
            item.socket.emit('message', Buffer.from(packet.data));
          } else if (packet.type === 'ws-close') sockets.get(packet.id)?.socket.close();
          else throw new Error('UNKNOWN_PACKET');
        } catch (error) { send({ type: 'error', id: packet.id, error: error instanceof Error ? error.message : 'REQUEST_FAILED' }); }
      }
    } catch { socket.close(4003, 'Secure channel closed'); }
    finally {
      clearInterval(revokeTimer);
      for (const operation of operations.values()) cancelHttp(operation);
      for (const { socket: logical } of sockets.values()) { try { logical.close(); } catch { logical.emit('close'); } }
      if (channel) { channels.delete(channel); channel.close(); }
    }
  }
  return { serviceId, store, accept, close() { for (const channel of channels) channel.close(); internal.close(); } };
}
export type FederationRuntime = Awaited<ReturnType<typeof createFederationRuntime>>;
