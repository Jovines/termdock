import { androidRouteAccess } from '../shared/androidDevices.js';
import { SessionSharingPresence } from './sessionSharing.js';
import { collaborationSessionDisplayName } from '../utils/sessionDisplayName.js';
import { mergeShareResources } from '../shared/shareResources.js';
import { canonicalShareDirectories, computerResource, resourceHttpAllowed } from './resourceAccess.js';
import { CollaborationRpc, type CollaborationNode } from '../agent/collaborationPeerTransport.js';
import { PasswordBootstrapServer } from './passwordBootstrap.js';
import { DeviceProfiles } from './deviceProfiles.js';
import { DeviceNames } from './deviceNames.js';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type express from 'express';
import type WebSocket from 'ws';
import { createIdentity, importIdentity, exportIdentity, secureConnection, type Identity, type ByteDuplex } from './secureProtocol.js';
import type { WebTransportDescriptor } from './webTransportProtocol.js';
import { InvitationStore, validateInvitation, type InvitationInput } from './invitations.js';
import { AuthorizationStore, type GrantInput } from './authorization.js';
import { resolveAccessRequest, isBusinessApiPath, terminalMessageAction } from './accessPolicy.js';
import { httpUploadLimit } from './httpUploadLimit.js';
import { AsyncQueue, PacketChannel, toBase64, fromBase64, type Packet } from './packets.js';
import { socketDuplex } from './socketDuplex.js';
import { markEncryptedRequest } from './requestContext.js';
import { readTerminalHandshakeDimensions } from '../utils/terminalHandshakeDimensions.js';
import { openAccessAllowed } from './openAccess.js';
import { relayPasswordConfigured, requireRelayPassword } from './relaySecurity.js';
import { isAuthEnabled, getPasswordCredentialFingerprint, getPasswordVerifier, getLoginBlockMs, recordLoginFailure, recordLoginSuccess } from '../utils/authProtection.js';
import { MAX_OPEN_SECURE_SOCKETS, MAX_SERVER_HTTP_REQUESTS } from './streamLimits.js';
import { MAX_TRANSFER_WINDOW, TRANSFER_CHUNK_BYTES, TransferWindow, transferWindow } from './transferWindow.js';

interface SocketHandlers {
  terminal(socket: WebSocket, sessionId: string, clientId: string, options: {pushClientId?: string; sinceSeq?: number; streamEpoch?: string; flowControl?: boolean; independentTmux?: boolean; outputActive?: boolean}, dimensions?: {cols: number; rows: number}): void;
  control(socket: WebSocket, clientId: string): void;
  /** 本机 Android 投屏/控制。仅限全权服务授权:它直通本机 adb,与终端同级。 */
  android?(socket: WebSocket, serial: string, clientId: string, options?: { maxSize?: number; bitRate?: number; maxFps?: number }): void;
  /** Desktop control is available only to full-service identities. */
  computer?(socket: WebSocket, host: string, options?: { protocol?: string; port?: string; readOnly?: boolean }): void;
}
class LogicalSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  get bufferedAmount(): number { return this.channel.queuedBytesFor(this.id); }
  private readonly maxQueuedBytes: number;
  constructor(private channel: PacketChannel, readonly id: string, private canRead: () => boolean, maxQueuedBytes = 4 * 1024 * 1024, private compress = false) {
    super(); this.maxQueuedBytes = maxQueuedBytes;
  }
  send(data: string): void {
    if (this.readyState !== 1) return;
    if (!this.canRead()) { this.close(4003, 'Authorization revoked'); return; }
    // Apply the terminal backlog threshold to bytes already queued, leaving a
    // single protocol-valid record (up to MAX_PACKET) intact. Other logical
    // streams retain the shared channel budget and its own backpressure guard.
    if (this.channel.queuedBytesFor(this.id) > this.maxQueuedBytes) {
      this.close(1013, 'Output consumer is too slow');
      return;
    }
    try { this.channel.send({ type: 'ws-data', id: this.id, data }, this.compress); }
    catch { this.close(1013, 'Output consumer is too slow'); }
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    try { this.channel.send({ type: 'ws-close', id: this.id, code, reason }); }
    catch { /* Transport closure must still release backend observers and timers. */ }
    finally { this.emit('close'); }
  }
}
interface HttpOperation { head: Packet; body: AsyncQueue<Uint8Array>; size: number; abort: AbortController; state: 'uploading' | 'running'; updatedAt: number; uploadSlot: boolean; responseWindow: TransferWindow }
export interface FederationRuntimeOptions {
  webTransport?: () => WebTransportDescriptor | undefined;
  collaborationConnected?: (subjectId: string, rpc: CollaborationRpc) => () => void;
  collaborationDescriptor?: () => Record<string, unknown>;
  collaborationService?: (subjectId: string, packet: Packet) => Record<string, unknown> | Promise<Record<string, unknown>>;
  collaborationExchange?: (subjectId: string, packet: Packet) => Record<string, unknown>;
  /** Registers another service as a peer limited to the sessions the calling
   * device may write to. The scope is derived from its effective grants here,
   * never from the request body. */
  registerScopedCollaborationPeer?: (deviceSubject: string, origin: string, node: CollaborationNode, sessions: string[]) => Record<string, unknown>;
  listRouteTargets?: () => Array<{ serviceId: string; label?: string; url?: string; available: boolean }>;
  listRouteAccess?: () => Array<{ id: string; subjectId: string; targetServiceId: string; active: boolean; revokedAt?: number }>;
  grantRouteAccess?: (issuerId: string, targetServiceId: string, subjectId: string, url?: string) => unknown;
  revokeRouteAccess?: (id: string) => boolean;
  createRouteInvitation?: (issuerId: string, targetServiceId: string) => { routeCode: string; expiresAt: number };
  consumeRouteInvitation?: (code: string, subjectId: string) => { serviceId: string };
  hasRouteGrant?: (subjectId: string, targetServiceId: string) => boolean;
  issueRouteTicket?: (subjectId: string, targetServiceId: string) => { routeToken: string; expiresAt: number };
  issueSelfRelayTicket?: (serviceId: string) => { selfRelayToken: string; expiresAt: number };
  /** Maps any session id on the wire (client session id or transient backend
   * PTY id) to the stable client session id. Session-scoped grants are bound to
   * the stable id so a backend replacement never invalidates them. */
  resolveSessionId?: (id: string) => string | null;
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
  const sharingPresence = new SessionSharingPresence();
  const deviceProfiles = new DeviceProfiles(join(directory, 'device-profiles.json'));
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
    const subject = request.headers['x-termdock-device'];
    delete request.headers['x-termdock-device'];
    const fullService = request.headers['x-termdock-full-service'] === '1';
    delete request.headers['x-termdock-full-service'];
    const resourcesHeader = request.headers['x-termdock-resources']; delete request.headers['x-termdock-resources'];
    markEncryptedRequest(request, typeof subject === 'string' ? subject : undefined, fullService, typeof resourcesHeader === 'string' ? JSON.parse(resourcesHeader) : undefined); app(request, response);
  });
  // The outer encrypted consumer can apply backpressure long after a local
  // response was written. Expiring this private keepalive socket while Undici
  // still drains it can truncate a slow download (UND_ERR_SOCKET / terminated).
  // Let the local client expire idle connections after it finishes consuming.
  internal.keepAliveTimeout = 0;
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

  async function acceptDuplex(duplex: ByteDuplex, context: { allowOpenAccess?: boolean; singleOperation?: boolean; relayed?: boolean } = {}): Promise<void> {
    let collaborationRpc: CollaborationRpc | undefined;
    let unregisterCollaboration: (() => void) | undefined;
    const open = (action?: string) => openAccessAllowed(!context.relayed && context.allowOpenAccess === true, isAuthEnabled(), action);
    const stableSessionId = (id: string): string | undefined => {
      try {
        const resolved = options.resolveSessionId?.(id);
        return typeof resolved === 'string' && resolved && resolved !== id ? resolved : undefined;
      } catch { return undefined; }
    };
    const allowed = (subjectId: string, action: string, sessionId?: string) => {
      if (context.relayed && !relayPasswordConfigured()) return false;
      if (open(action) || store.authorize({ subjectId, serviceId, action, sessionId }).allowed) return true;
      // The wire may still carry the transient backend PTY id while the grant
      // is bound to the stable client session id (or an older backend id).
      if (sessionId === undefined) return false;
      const stable = stableSessionId(sessionId);
      return stable !== undefined && store.authorize({ subjectId, serviceId, action, sessionId: stable }).allowed;
    };
    const resources = (subjectId: string) => mergeShareResources(context.relayed && !relayPasswordConfigured() ? [] : store.listEffective({ subjectId, serviceId }).map(g => g.resources));
    const androidAllowed = (subjectId: string, serial: string, control = false) => full(subjectId) || (control ? androidRouteAccess(resources(subjectId).android, serial) === 'control' : !!androidRouteAccess(resources(subjectId).android, serial));
    const computerAllowed = (subjectId: string, target: { host: string; protocol: string; port: number }) => full(subjectId) || !!computerResource(resources(subjectId), target.host, target.protocol, target.port);
    const full = (subjectId: string) => (!context.relayed || relayPasswordConfigured()) && (open() || store.hasFullServiceAccess({ subjectId, serviceId }));
    let channel: PacketChannel | undefined;
    const operations = new Map<string, HttpOperation>();
    const sockets = new Map<string, { socket: LogicalSocket; sessionId?: string; android?: string; computer?: boolean; computerTarget?: { host: string; protocol: string; port: number }; computerProtocol?: string; computerControl?: boolean }>();
    const presenceKey = randomUUID();
    let revokeTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const secured = await secureConnection({ identity, duplex, initiator: false, signal: AbortSignal.timeout(15000) });
      const subjectId = secured.authenticatedPeerId;
      channel = new PacketChannel(secured.duplex); channels.add(channel);
      const send = (packet: Packet) => channel!.send(packet);
      const check = (action: string, sessionId?: string) => { if (!allowed(subjectId, action, sessionId)) throw new Error('AUTHORIZATION_DENIED'); };
      const httpAllowed = (head: Packet) => {
        if (context.relayed) requireRelayPassword();
        if (typeof head.method !== 'string' || typeof head.path !== 'string' || !isBusinessApiPath(head.method, head.path)) throw new Error('API_NOT_ALLOWED');
        const policy = resolveAccessRequest(head.method, head.path);
        if (!full(subjectId) && !resourceHttpAllowed(resources(subjectId), head.method, head.path)) { if (!policy) throw new Error('API_NOT_ALLOWED'); check(policy.action, policy.sessionId); }
      };
      async function runHttp(id: string, operation: HttpOperation) {
        const scopeStamp = JSON.stringify([full(subjectId), resources(subjectId)]);
        const sendHttp = (packet: Packet) => {
          if (operations.get(id) !== operation || operation.abort.signal.aborted) throw new Error('CANCELLED');
          if (scopeStamp !== JSON.stringify([full(subjectId), resources(subjectId)])) throw new Error('AUTHORIZATION_CHANGED');
          httpAllowed(operation.head); send(packet);
        };
        try {
          httpAllowed(operation.head);
          const headers = new Headers({ 'x-termdock-inner': internalToken, 'x-termdock-device': subjectId,
            'x-termdock-full-service': full(subjectId) ? '1' : '0', 'x-termdock-resources': JSON.stringify(resources(subjectId)) });
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
            for (let offset = 0; offset < value.length; offset += TRANSFER_CHUNK_BYTES) {
              httpAllowed(operation.head);
              await operation.responseWindow.wait();
              httpAllowed(operation.head);
              operation.responseWindow.sent();
              const chunk = value.subarray(offset, offset + TRANSFER_CHUNK_BYTES);
              await channel!.sendBulk({ type: 'chunk', id, ...(operation.head.binaryChunks === true ? { bytes: chunk } : { data: toBase64(chunk) }) }, operation.abort.signal, () => httpAllowed(operation.head));
            }
          }
          await operation.responseWindow.wait(true);
          sendHttp({ type: 'end', id });
        } catch (error) { try { if (operations.get(id) === operation) send({ type: 'error', id, error: error instanceof Error ? error.message : 'REQUEST_FAILED' }); } catch { /* The encrypted connection has closed. */ } }
        finally { cancelHttp(operation); if (operations.get(id) === operation) operations.delete(id); }
      }
      revokeTimer = setInterval(() => {
        if (context.relayed && !relayPasswordConfigured()) { duplex.close?.(new Error('TARGET_PASSWORD_REQUIRED')); return; }
        for (const { socket: logical, sessionId, android, computer, computerTarget, computerControl } of sockets.values()) {
          if (android || computer) { if (android ? !androidAllowed(subjectId, android) : !computerTarget || !computerAllowed(subjectId, computerTarget) || (computerControl && !full(subjectId) && !resources(subjectId).computers?.some(c => c.host.toLowerCase() === computerTarget.host.toLowerCase() && c.protocol === computerTarget.protocol && c.port === computerTarget.port && c.access === 'control'))) logical.close(4003, 'Authorization revoked'); continue; }
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
          if (context.relayed) requireRelayPassword();
          if (collaborationRpc?.accept(packet)) continue;
          if (packet.type === 'collaboration-connect') {
            if (!options.collaborationService || !options.collaborationConnected) throw new Error('COLLABORATION_UPGRADE_REQUIRED');
            options.collaborationService(subjectId, { type: 'collaboration-service', id: packet.id, action: 'duplex' });
            if (!collaborationRpc) {
              collaborationRpc = new CollaborationRpc(channel, undefined, true);
              unregisterCollaboration = options.collaborationConnected(subjectId, collaborationRpc);
            }
            send({ type: 'result', id: packet.id, ok: true });
          } else if (packet.type === 'collaboration-descriptor') {
            if (!options.collaborationDescriptor) throw new Error('COLLABORATION_UPGRADE_REQUIRED');
            send({ type: 'result', id: packet.id, node: options.collaborationDescriptor() });
          } else if (packet.type === 'collaboration-service') {
            if (!options.collaborationService) throw new Error('COLLABORATION_UPGRADE_REQUIRED');
            // Task preparation may use the same channel for a directory request; do not block its reader.
            void Promise.resolve(options.collaborationService(subjectId, packet)).then(result => send({ type: 'result', id: packet.id, ...result }))
              .catch(error => { try { send({ type: 'error', id: packet.id, error: error instanceof Error ? error.message : 'REQUEST_FAILED' }); } catch { /* Connection closed. */ } });
          } else if (packet.type === 'collaboration-scoped-peer') {
            if (!options.registerScopedCollaborationPeer) throw new Error('COLLABORATION_UPGRADE_REQUIRED');
            const origin = typeof packet.origin === 'string' ? packet.origin : '';
            if (!origin || !packet.node || typeof packet.node !== 'object') throw new Error('INVALID_COLLABORATION_PEER');
            // The peer may only touch sessions this device can write to right now.
            const sessions = [...new Set(store.listEffective({ subjectId, serviceId })
              .filter(grant => grant.scope.kind === 'sessions' && grant.actions.includes('session.input'))
              .flatMap(grant => grant.scope.kind === 'sessions' ? grant.scope.sessionIds : []))];
            if (!sessions.length) throw new Error('AUTHORIZATION_DENIED');
            send({ type: 'result', id: packet.id, ...options.registerScopedCollaborationPeer(subjectId, origin, packet.node as CollaborationNode, sessions) });
          } else if (packet.type === 'collaboration-exchange') {
            if (!options.collaborationExchange) throw new Error('COLLABORATION_UNAVAILABLE');
            send({ type: 'result', id: packet.id, ...options.collaborationExchange(subjectId, packet) });
          } else if (packet.type === 'password-parameters') {
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
            send({ type: 'result', id: packet.id, subjectId, serviceId, fullService: full(subjectId), grants, httpWindow: MAX_TRANSFER_WINDOW, binaryChunks: true, relayAuthorizationErrors: true, relaySelfTargetGuard: true, webTransport: options.webTransport?.() });
          } else if (packet.type === 'session-list') {
            const inventory = await sessionInventory();
            const displayGrants = store.listEffective({ subjectId, serviceId }).filter(grant => grant.actions.includes('session.view')).reverse().sort((a, b) => b.createdAt - a.createdAt);
            const seen = new Set<string>();
            const items = inventory.flatMap(session => {
              const sessionId = session.backendSessionId;
              if (typeof sessionId !== 'string' || !sessionId || seen.has(sessionId) || !allowed(subjectId, 'session.view', sessionId)) return [];
              seen.add(sessionId);
              const matches = (id: string) => id === session.sessionId || id === sessionId || stableSessionId(id) === session.sessionId;
              const displayGrant = displayGrants.find(grant => grant.scope.kind === 'service' || grant.scope.sessionIds.some(matches));
              const appearance = Object.entries(displayGrant?.sessionAppearance || {}).find(([id]) => matches(id))?.[1];
              return [{ sessionId, ...(typeof session.sessionId === 'string' ? { sourceSessionId: session.sessionId } : {}),
                name: appearance?.name || collaborationSessionDisplayName({ ...session, name: typeof session.name === 'string' ? session.name : sessionId } as Parameters<typeof collaborationSessionDisplayName>[0]), ...(appearance?.icon ? { icon: appearance.icon } : {}), live: session.live === true,
                canWrite: allowed(subjectId, 'session.input', sessionId), canResize: allowed(subjectId, 'session.resize', sessionId) }];
            });
            send({ type: 'result', id: packet.id, items });
          } else if (packet.type === 'session-sharing-status') {
            check('authorization.manage');
            const normalize = (id: string) => options.resolveSessionId?.(id) || id;
            send({ type: 'result', id: packet.id, items: sharingPresence.summary(store.listActive(), invitations.listPending(), normalize) });
          } else if (packet.type === 'session-sharing-stop') {
            check('authorization.manage');
            if (typeof packet.sessionId !== 'string' || !packet.sessionId) throw new Error('INVALID_SESSION');
            const normalize = (id: string) => options.resolveSessionId?.(id) || id;
            const sessionId = normalize(packet.sessionId);
            const revoked = store.revokeSession(sessionId, normalize);
            invitations.revokeSession(sessionId, normalize);
            send({ type: 'result', id: packet.id, revoked });
          } else if (packet.type === 'self-relay-ticket') {
            if (!options.issueSelfRelayTicket) throw new Error('SELF_RELAY_UNAVAILABLE');
            send({ type: 'result', id: packet.id, serviceId: subjectId, ...options.issueSelfRelayTicket(subjectId) });
          } else if (packet.type === 'route-invite-create') {
            if (packet.serviceId === serviceId) throw new Error('RELAY_SELF_TARGET');
            check('authorization.manage');
            if (!options.createRouteInvitation || typeof packet.serviceId !== 'string' || !packet.serviceId || packet.serviceId.length > 512) throw new Error('ROUTE_NOT_AVAILABLE');
            send({ type: 'result', id: packet.id, ...options.createRouteInvitation(subjectId, packet.serviceId) });
          } else if (packet.type === 'route-pair') {
            if (!options.consumeRouteInvitation || typeof packet.code !== 'string') throw new Error('PAIRING_DENIED');
            send({ type: 'result', id: packet.id, ...options.consumeRouteInvitation(packet.code, subjectId) });
          } else if (packet.type === 'route-targets') {
            const canManage = allowed(subjectId, 'authorization.manage');
            const items = (options.listRouteTargets?.() || []).filter(target => target.serviceId !== serviceId && (canManage || options.hasRouteGrant?.(subjectId, target.serviceId)))
              .map(target => ({ ...target, authorized: options.hasRouteGrant?.(subjectId, target.serviceId) === true }));
            send({ type: 'result', id: packet.id, canManage, items });
          } else if (packet.type === 'route-access') {
            const all = options.listRouteAccess?.() || [];
            const canManage = allowed(subjectId, 'authorization.manage');
            send({ type: 'result', id: packet.id, canManage, grants: canManage ? all : all.filter(grant => grant.subjectId === subjectId) });
          } else if (packet.type === 'route-grant') {
            if (packet.serviceId === serviceId) throw new Error('RELAY_SELF_TARGET');
            check('authorization.manage');
            if (!options.grantRouteAccess || typeof packet.serviceId !== 'string' || typeof packet.subjectId !== 'string') throw new Error('ROUTE_NOT_AVAILABLE');
            send({ type: 'result', id: packet.id, grant: await options.grantRouteAccess(subjectId, packet.serviceId, packet.subjectId, typeof packet.url === 'string' ? packet.url : undefined) });
          } else if (packet.type === 'route-revoke') {
            const grant = options.listRouteAccess?.().find(item => item.id === packet.grantId);
            if (!grant || (grant.subjectId !== subjectId && !allowed(subjectId, 'authorization.manage'))) throw new Error('AUTHORIZATION_DENIED');
            if (!options.revokeRouteAccess || typeof packet.grantId !== 'string') throw new Error('ROUTE_NOT_AVAILABLE');
            send({ type: 'result', id: packet.id, revoked: options.revokeRouteAccess(packet.grantId) });
          } else if (packet.type === 'route-ticket') {
            if (packet.serviceId === serviceId) throw new Error('RELAY_SELF_TARGET');
            if (typeof packet.serviceId !== 'string' || !options.hasRouteGrant?.(subjectId, packet.serviceId)) throw new Error('AUTHORIZATION_DENIED');
            if (!options.issueRouteTicket || typeof packet.serviceId !== 'string' || !packet.serviceId || packet.serviceId.length > 512) throw new Error('ROUTE_NOT_AVAILABLE');
            send({ type: 'result', id: packet.id, ...options.issueRouteTicket(subjectId, packet.serviceId) });
          } else if (packet.type === 'invite-create') {
            check('authorization.manage');
            const invitation = { scope: packet.scope, actions: packet.actions, ...(packet.resources === undefined ? {} : { resources: packet.resources }),
              ...(packet.sessionAppearance === undefined ? {} : { sessionAppearance: packet.sessionAppearance }),
              ...(packet.label === undefined ? {} : { label: packet.label }),
              ...(packet.expiresAt === undefined ? {} : { expiresAt: packet.expiresAt }) };
            validateInvitation(invitation);
            if (invitation.resources) invitation.resources = canonicalShareDirectories(invitation.resources);
            if (invitation.scope.kind === 'sessions') {
              // Bind to the stable client session id, never the transient backend
              // PTY id: backends are replaced on restart, tmux recovery or
              // re-attach, which would otherwise invalidate the whole grant.
              const stable = new Map<string, string>();
              for (const session of await sessionInventory()) {
                if (session.live !== true) continue;
                const frontendSessionId = typeof session.sessionId === 'string' ? session.sessionId : '';
                if (!frontendSessionId) continue;
                stable.set(frontendSessionId, frontendSessionId);
                if (typeof session.backendSessionId === 'string' && session.backendSessionId) stable.set(session.backendSessionId, frontendSessionId);
              }
              const sessionIds = invitation.scope.sessionIds.map(id => stable.get(id)).filter((id): id is string => typeof id === 'string');
              if (sessionIds.length !== invitation.scope.sessionIds.length || new Set(sessionIds).size !== sessionIds.length) throw new Error('UNKNOWN_SESSION');
              if (invitation.sessionAppearance) invitation.sessionAppearance = Object.fromEntries(Object.entries(invitation.sessionAppearance).map(([id, appearance]) => [stable.get(id)!, appearance]));
              invitation.scope = { kind: 'sessions', sessionIds };
            }
            check('authorization.manage');
            send({ type: 'result', id: packet.id, serviceId, ...invitations.create(subjectId, invitation as InvitationInput) });
          } else if (packet.type === 'device-name') {
            const target = typeof packet.subjectId === 'string' ? packet.subjectId : subjectId;
            if (target !== subjectId) check('authorization.manage');
            if (!store.listEffective({ subjectId: target, serviceId }).length && !(target === subjectId && (full(subjectId) || options.listRouteAccess?.().some(grant => grant.subjectId === subjectId && grant.active)))) throw new Error('AUTHORIZATION_DENIED');
            if (target === subjectId && packet.profile) deviceProfiles.set(subjectId, packet.profile);
            const existing = invitations.subjectLabels()[target];
            const name = packet.onlyIfMissing === true && existing && !deviceNames.list()[target] ? existing : deviceNames.set(target, packet.name, packet.onlyIfMissing === true);
            send({ type: 'result', id: packet.id, name });
          } else if (packet.type === 'grants-list') {
            check('authorization.manage'); send({ type: 'result', id: packet.id, grants: store.list(), invitations: invitations.listPending(), deviceProfiles: deviceProfiles.list(), subjectLabels: { ...invitations.subjectLabels(), ...deviceNames.list() } });
          } else if (packet.type === 'invite-revoke') {
            check('authorization.manage');
            send({ type: 'result', id: packet.id, revoked: typeof packet.invitationId === 'string' && invitations.revoke(packet.invitationId) });
          } else if (packet.type === 'grant') {
            check('authorization.manage'); send({ type: 'result', id: packet.id, grant: store.grant(packet.grant as GrantInput) });
          } else if (packet.type === 'revoke') {
            check('authorization.manage'); send({ type: 'result', id: packet.id, revoked: store.revoke(String(packet.grantId)) });
          } else if (packet.type === 'delegate') {
            const grant = store.delegate(String(packet.parentGrantId), subjectId, packet.grant as GrantInput); send({ type: 'result', id: packet.id, grant });
          } else if (packet.type === 'http') {
            if ((context.singleOperation ? operations.size + sockets.size >= 1 : operations.size >= MAX_SERVER_HTTP_REQUESTS) || operations.has(packet.id) || sockets.has(packet.id)) throw new Error('STREAM_LIMIT');
            httpAllowed(packet);
            const requestedSession = resolveAccessRequest(String(packet.method), String(packet.path))?.sessionId;
            if (requestedSession && !full(subjectId)) sharingPresence.visit(presenceKey, subjectId, stableSessionId(requestedSession) || requestedSession);
            const upload = !['GET', 'HEAD'].includes(String(packet.method));
            if (upload && uploadSlots >= 8) throw new Error('UPLOAD_CONCURRENCY_LIMIT');
            const window = transferWindow(packet.window);
            const abort = new AbortController();
            const operation: HttpOperation = { head: packet, body: new AsyncQueue<Uint8Array>(Math.max(2, window)), size: 0, abort, state: 'uploading', updatedAt: Date.now(), uploadSlot: upload, responseWindow: new TransferWindow(window, abort.signal) };
            if (upload) uploadSlots++;
            operations.set(packet.id, operation);
            if (upload) void runHttp(packet.id, operation);
          } else if (packet.type === 'upload') {
            const operation = operations.get(packet.id); if (!operation || operation.state !== 'uploading'
              || !(operation.head.binaryChunks === true && packet.bytes instanceof Uint8Array) && typeof packet.data !== 'string') throw new Error('INVALID_UPLOAD');
            httpAllowed(operation.head);
            const bytes = operation.head.binaryChunks === true && packet.bytes instanceof Uint8Array ? packet.bytes : fromBase64(packet.data as string); operation.size += bytes.length;
            const limit = httpUploadLimit(new URL(String(operation.head.path), 'http://inner').pathname);
            if (['GET', 'HEAD'].includes(String(operation.head.method)) || bytes.length > TRANSFER_CHUNK_BYTES || operation.size > limit) { cancelHttp(operation); operations.delete(packet.id); throw new Error('UPLOAD_LIMIT'); }
            operation.updatedAt = Date.now();
            try { operation.body.push(bytes); } catch { cancelHttp(operation); operations.delete(packet.id); throw new Error('UPLOAD_QUEUE_LIMIT'); }
          } else if (packet.type === 'upload-end') {
            const operation = operations.get(packet.id); if (!operation || operation.state !== 'uploading') throw new Error('INVALID_STREAM');
            operation.state = 'running'; operation.body.end();
            if (['GET', 'HEAD'].includes(String(operation.head.method))) void runHttp(packet.id, operation);
          } else if (packet.type === 'ack') {
            operations.get(packet.id)?.responseWindow.acknowledge();
          } else if (packet.type === 'cancel') {
            const operation = operations.get(packet.id); if (operation) cancelHttp(operation); operations.delete(packet.id);
          } else if (packet.type === 'ws-open') {
            if ((context.singleOperation ? operations.size + sockets.size >= 1 : sockets.size >= MAX_OPEN_SECURE_SOCKETS) || operations.has(packet.id) || sockets.has(packet.id)) throw new Error('STREAM_LIMIT');
            if (typeof packet.path !== 'string' || !isBusinessApiPath('GET', packet.path)) throw new Error('API_NOT_ALLOWED');
            const url = new URL(packet.path, 'http://inner');
            const match = /^\/api\/terminal\/([^/%]+)\/ws$/.exec(url.pathname);
            const androidMatch = /^\/api\/android\/([^/%]+)\/ws$/.exec(url.pathname);
            const computer = url.pathname === '/api/computer/ws';
            const computerTarget = { host: url.searchParams.get('host') ?? '', protocol: url.searchParams.get('protocol') ?? 'vnc', port: Number(url.searchParams.get('port') ?? (url.searchParams.get('protocol') === 'rdp' ? '3389' : '5900')) };
            const canView = () => androidMatch ? androidAllowed(subjectId, androidMatch[1]) : computer ? computerAllowed(subjectId, computerTarget) : allowed(subjectId, match ? 'session.view' : 'service.view', match?.[1]);
            if (match) { check('session.view', match[1]); if (!full(subjectId)) sharingPresence.visit(presenceKey, subjectId, stableSessionId(match[1]) || match[1]); }
            else if (url.pathname === '/api/control/ws') check('service.view');
            else if (androidMatch || computer) { if (!canView()) throw new Error('API_NOT_ALLOWED'); }
            else throw new Error('API_NOT_ALLOWED');
            const logical = new LogicalSocket(channel, packet.id, canView, match ? 1024 * 1024 : undefined, !!match && packet.compression === 'gzip');
            sockets.set(packet.id, { socket: logical, sessionId: match?.[1], android: androidMatch?.[1], computer, computerTarget: computer ? computerTarget : undefined,
              computerControl: computer && (full(subjectId) || resources(subjectId).computers?.some(c => c.host.toLowerCase() === computerTarget.host.toLowerCase() && c.protocol === computerTarget.protocol && c.port === computerTarget.port && c.access === 'control')), computerProtocol: computer ? url.searchParams.get('protocol') ?? 'vnc' : undefined });
            const shareStreamKey = `${presenceKey}:${packet.id}`;
            if (match && !full(subjectId)) sharingPresence.openStream(shareStreamKey, presenceKey, subjectId, stableSessionId(match[1]) || match[1]);
            logical.once('close', () => { sockets.delete(packet.id); sharingPresence.closeStream(shareStreamKey); });
            send({ type: 'ws-ready', id: packet.id });
            if (match) handlers.terminal(logical as unknown as WebSocket, match[1], randomUUID(), {
              pushClientId: `device:${subjectId}`, sinceSeq: Math.max(0, Number(url.searchParams.get('since')) || 0), streamEpoch: url.searchParams.get('epoch') ?? undefined,
              flowControl: url.searchParams.get('flow') === '2', outputActive: url.searchParams.get('active') !== '0',
              independentTmux: allowed(subjectId, 'session.resize', match[1]) && url.searchParams.get('transport') === 'tmux-client',
            }, allowed(subjectId, 'session.resize', match[1]) ? readTerminalHandshakeDimensions(url.searchParams) : undefined);
            else if (androidMatch) {
              if (!handlers.android) throw new Error('API_NOT_ALLOWED');
              handlers.android(logical as unknown as WebSocket, androidMatch[1], randomUUID(), {
                maxSize: Number(url.searchParams.get('max_size')) || undefined,
                bitRate: Number(url.searchParams.get('bit_rate')) || undefined,
                maxFps: Number(url.searchParams.get('max_fps')) || undefined,
              });
            }
            else if (computer) {
              if (!handlers.computer) { logical.close(4403, 'API_NOT_ALLOWED'); continue; }
              handlers.computer(logical as unknown as WebSocket, url.searchParams.get('host') ?? '', {
                protocol: computerTarget.protocol, port: String(computerTarget.port), readOnly: !full(subjectId) && computerResource(resources(subjectId), computerTarget.host, computerTarget.protocol, computerTarget.port)?.access !== 'control',
              });
            }
            else handlers.control(logical as unknown as WebSocket, randomUUID());
          } else if (packet.type === 'ws-data') {
            const item = sockets.get(packet.id); if (!item || typeof packet.data !== 'string') throw new Error('INVALID_STREAM');
            const data = JSON.parse(packet.data);
            if (item.computer) {
              if (!item.computerTarget || !computerAllowed(subjectId, item.computerTarget) || (item.computerControl && !full(subjectId) && !resources(subjectId).computers?.some(c => c.host.toLowerCase() === item.computerTarget!.host.toLowerCase() && c.protocol === item.computerTarget!.protocol && c.port === item.computerTarget!.port && c.access === 'control'))) throw new Error('AUTHORIZATION_DENIED');
              const types = item.computerProtocol === 'rdp' ? ['start', 'instruction', 'ack'] : ['data', 'ack'];
              if (!types.includes(data?.type)) throw new Error('ACTION_NOT_ALLOWED');
            }
            else if (item.android) {
              if (!androidAllowed(subjectId, item.android, data?.type === 'control' && data?.data !== 'EQ==')) throw new Error('AUTHORIZATION_DENIED');
              if (!['control', 'ack', 'ping', 'bitrate'].includes(data?.type)) throw new Error('ACTION_NOT_ALLOWED');
            }
            else if (item.sessionId) {
              const action = terminalMessageAction(data.type); if (!action) throw new Error('ACTION_NOT_ALLOWED');
              check(action, action.startsWith('session.') ? item.sessionId : undefined);
              // Combining a tmux control action with input retains the control
              // permission of the older two-message protocol.
              if (data.type === 'input' && data.exitCopyMode === true) check('service.configure');
            }
            else { check('service.view'); if (data?.type !== 'pong') throw new Error('ACTION_NOT_ALLOWED'); }
            item.socket.emit('message', Buffer.from(packet.data));
          } else if (packet.type === 'ws-close') sockets.get(packet.id)?.socket.close();
          else throw new Error('UNKNOWN_PACKET');
        } catch (error) { send({ type: 'error', id: packet.id, error: error instanceof Error ? error.message : 'REQUEST_FAILED' }); }
      }
    } catch { duplex.close?.(new Error('Secure channel closed')); }
    finally {
      sharingPresence.close(presenceKey);
      unregisterCollaboration?.(); collaborationRpc?.close();
      clearInterval(revokeTimer);
      for (const operation of operations.values()) cancelHttp(operation);
      for (const { socket: logical } of sockets.values()) { try { logical.close(); } catch { logical.emit('close'); } }
      if (channel) { channels.delete(channel); channel.close(); }
    }
  }
  return { serviceId, identity, store, acceptDuplex,
    accept(socket: WebSocket, context: { allowOpenAccess?: boolean; relayed?: boolean } = {}) { return acceptDuplex(socketDuplex(socket), context); },
    close() { for (const channel of channels) channel.close(); internal.close(); } };
}
export type FederationRuntime = Awaited<ReturnType<typeof createFederationRuntime>>;
