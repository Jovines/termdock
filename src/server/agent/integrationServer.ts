import express from 'express';
import { createServer, type ServerResponse, type Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { CollaborationError } from './collaborationProtocol.js';
import { terminalMessage, type CollaborationStore } from './collaborationStore.js';
import type { CollaborationTaskStore } from './collaborationTaskStore.js';
import type { CollaborationTaskService } from './collaborationTaskService.js';
import type { CollaborationService } from './collaborationService.js';
import type { TaskOrigin, TaskOperation, TaskCreateInput } from './collaborationTaskTypes.js';
import { IntegrationStore, INTEGRATION_PROTOCOL, INTEGRATION_OPERATIONS, integrationError, type IntegrationPermission, type IntegrationPrincipal, type IntegrationEvent } from './integrationStore.js';
import { IntegrationSessions, publicIntegrationSession, type IntegrationSessionAdapter } from './integrationSessions.js';
import { getTermdockVersion } from '../utils/version.js';

export function integrationSocketPath(port: number): string { return path.join(homedir(), '.termdock', `integration-${port}.sock`); }
export interface IntegrationRuntimeOptions {
  directory: string; socketPath: string; adminToken?: string;
  messages: CollaborationStore; taskStore: CollaborationTaskStore;
  tasks: CollaborationTaskService; peers: CollaborationService; sessions: IntegrationSessionAdapter;
}
type Update = { sourceKey: string; sourceVersion: string; eventId?: string; event: Omit<IntegrationEvent, 'event_id' | 'sequence' | 'cursor'> };
/** A local authenticated API and push stream. It is never mounted on the
 * public HTTP application and does not reuse an integration's admin token. */
export class IntegrationRuntime {
  readonly store: IntegrationStore;
  readonly sessions: IntegrationSessions;
  private server: Server;
  private stops: Array<() => void> = [];
  private streams = new Set<ServerResponse>();
  private sent = new Map<string, number>();
  private syncing = false;
  private retry?: ReturnType<typeof setTimeout>;
  constructor(private options: IntegrationRuntimeOptions) {
    this.store = new IntegrationStore(path.join(options.directory, 'integrations.json'));
    this.sessions = new IntegrationSessions(path.join(options.directory, 'integration-sessions.json'), options.sessions);
    const changed = () => { try { this.sync(); } catch (error) { this.failStreams(error); this.scheduleRetry(); } };
    this.stops.push(options.messages.subscribe(changed), options.taskStore.subscribe(changed), this.sessions.subscribe(changed));
    const app = express(); app.use(express.json({ limit: '1mb' }));
    app.use((req, res, next) => {
      if (req.headers['x-termdock-integration-protocol'] !== String(INTEGRATION_PROTOCOL)) { res.status(409).json({ ...this.error(new CollaborationError('INCOMPATIBLE_INTEGRATION_PROTOCOL', 'Unsupported integration protocol', 409)), protocol: INTEGRATION_PROTOCOL }); return; }
      next();
    });
    const run = (handler: (req: express.Request, res: express.Response) => unknown | Promise<unknown>): express.RequestHandler => async (req, res) => {
      try { const value = await handler(req, res); if (!res.headersSent) res.json(value); }
      catch (error) { res.status(error instanceof CollaborationError ? error.httpStatus : 500).json(this.error(error)); }
    };
    const principal = (req: express.Request) => this.store.authenticate(String(req.headers['x-termdock-integration-id'] ?? ''), String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const admin = (req: express.Request) => {
      const given = Buffer.from(String(req.headers['x-termdock-local-token'] ?? '')), expected = Buffer.from(options.adminToken ?? '');
      if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) integrationError('INTEGRATION_ADMIN_REQUIRED', 'Local administration credential is required', 401);
    };
    app.get('/admin/groups', run(req => { admin(req); return { groups: options.messages.list().filter(g => !g.federated).map(g => ({ id: g.id, name: g.name })) }; }));
    app.get('/admin/capabilities', run(req => { admin(req); return this.capabilities(); }));
    app.get('/admin/sessions/:id/restore-diagnostics', run(req => { admin(req); return this.sessions.restoreDiagnostics(req.params.id); }));
    app.get('/admin/principals', run(req => { admin(req); return { integrations: this.store.policies() }; }));
    app.post('/admin/principals', run(req => { admin(req); this.group(req.body?.groupId); const provisioned = this.store.provision(req.body); try { this.sync(); } catch { this.scheduleRetry(); } return { id: provisioned.principal.id, token: provisioned.token, protocol: INTEGRATION_PROTOCOL }; }));
    app.post('/admin/principals/:id/policy', run(req => { admin(req); if (req.body?.id !== req.params.id) integrationError('INVALID_INTEGRATION_POLICY', 'Policy identity must match the requested identity'); this.group(req.body?.groupId); this.store.update(req.body); return { ok: true, id: req.params.id }; }));
    app.post('/admin/principals/:id/revoke', run(req => { admin(req); this.store.revoke(req.params.id); return { ok: true }; }));
    app.get('/capabilities', run(req => { const p = principal(req); return { ...this.capabilities(), principal: { id: p.id, group_id: p.groupId, permissions: p.permissions, launch_profiles: p.launchProfiles.map(profile => ({ id: profile.id, agent_slug: profile.agentSlug, cwd_roots: profile.cwdRoots, startup_input_condition: !!profile.startupInput })) } }; }));
    app.get('/tasks', run(req => { const p = principal(req); this.authorize(p, 'task.read', req.query.group); return { tasks: options.tasks.list(p.groupId, null, req.query.purpose) }; }));
    app.get('/tasks/:id', run(async req => { const p = principal(req); this.taskPermission(p, req.params.id, 'task.read'); return { task: await options.tasks.get(req.params.id, null) }; }));
    app.post('/tasks', run(async req => {
      const p = principal(req), raw = req.body?.input ?? {};
      this.authorize(p, 'task.create', raw.groupId);
      if (raw.managed || raw.parentTaskId || raw.dependsOn?.length || raw.coordinatorSessionId || raw.reviewerSessionIds?.length || raw.integration) integrationError('INTEGRATION_OPERATION_DENIED', 'Integration creates ordinary standalone tasks only', 403);
      const input: TaskCreateInput = { idempotencyKey: raw.idempotencyKey, groupId: p.groupId, title: raw.title, spec: raw.spec,
        purpose: raw.purpose, constraints: raw.constraints, acceptance: raw.acceptance, assignee: raw.assigneeSessionId ? options.peers.taskMember(String(raw.assigneeSessionId)) : undefined };
      if (input.assignee) this.authorize(p, 'task.assign');
      const task = await options.tasks.create(input, null, this.origin(p, req.body?.origin)); this.sync(); return { task };
    }));
    app.post('/tasks/:id', run(async req => {
      const p = principal(req), raw = req.body?.input ?? {};
      const permissions: Record<string, IntegrationPermission> = { configure: 'task.configure', assign: 'task.assign', comment: 'task.comment', revise: 'task.revise', answer: 'task.answer' };
      const permission = permissions[raw.kind]; if (!permission) integrationError('INTEGRATION_OPERATION_DENIED', 'Operation requires a user or terminal member', 403);
      this.taskPermission(p, req.params.id, permission);
      const input: TaskOperation = { kind: raw.kind, idempotencyKey: raw.idempotencyKey, content: raw.content,
        purpose: raw.purpose, expectedRevision: raw.expectedRevision, decisionId: raw.decisionId,
        assignee: raw.assigneeSessionId ? options.peers.taskMember(String(raw.assigneeSessionId)) : undefined };
      const task = await options.tasks.apply(req.params.id, input, null, this.origin(p, req.body?.origin)); this.sync();
      const event = options.taskStore.integrationRequestEvent(p.id, input.idempotencyKey, task.id);
      return { task, event_id: event?.id ?? null, attempt_id: event?.attemptId ?? null, delivery_id: event?.deliveryId ?? null };
    }));
    app.get('/message/:id', run(req => {
      const p = principal(req), message = options.messages.getMessage(req.params.id);
      if (!message) integrationError('MESSAGE_NOT_FOUND', 'Message does not exist', 404);
      this.authorize(p, 'task.read', message.groupId);
      const receipt = options.messages.receipt(message.id); const { snapshot: _, ...diagnostic } = receipt;
      return { ok: true, ...diagnostic, ...(req.query.receipt_only === 'true' ? {} : { message: terminalMessage(message) }) };
    }));
    app.post('/sessions', run(async req => {
      const p = principal(req); this.authorize(p, 'session.create', req.body?.group_id);
      const session = await this.sessions.create(p, { profile: req.body?.launch_profile, cwd: req.body?.cwd, idempotencyKey: req.body?.idempotency_key });
      this.sync(); return { session: publicIntegrationSession(session) };
    }));
    app.get('/sessions/:id', run(async req => { const p = principal(req); this.authorize(p, 'session.read'); return { session: publicIntegrationSession(await this.sessions.get(p, req.params.id)) }; }));
    app.post('/sessions/:id/restore', run(async req => { const p = principal(req); this.authorize(p, 'session.restore'); const session = await this.sessions.restore(p, req.params.id, req.body?.idempotency_key); this.sync(); return { session: publicIntegrationSession(session) }; }));
    app.get('/events', run((req, res) => {
      const p = principal(req); this.authorize(p, 'events.read', req.query.group);
      this.sync(); this.stream(p, String(req.query.consumer ?? 'default'), req, res);
    }));
    app.post('/events/ack', run(req => {
      const p = principal(req); this.authorize(p, 'events.read');
      const cursor = String(req.body?.cursor ?? ''), consumer = String(req.body?.consumer ?? 'default');
      const sequence = this.store.cursorSequence(p.groupId, cursor);
      if (sequence > (this.sent.get(`${p.id}:${p.groupId}:${consumer}`) ?? -1)) integrationError('EVENT_ACK_NOT_SENT', 'Subscribe and durably receive the continuous prefix before acknowledging', 409);
      return this.store.ack(p, consumer, cursor);
    }));
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json(this.error(new CollaborationError('INVALID_REQUEST', 'Invalid integration request', 400))); });
    this.server = createServer(app);
  }
  capabilities() {
    return { integration_protocol: INTEGRATION_PROTOCOL, server_version: getTermdockVersion(), local_only: true,
      integration_principal: true, group_scoped_permissions: true, durable_event_push: true,
      event_ack_semantics: 'durable_received', correlated_task_responses: true, accepted_task_comments: true,
      idempotent_session_create: true, exact_session_restore: true, external_validation: false,
      startup_input_conditions: true,
      integration_policy_update: true,
      session_restore_diagnostics: true,
      native_identity_linux_flock_owner: process.platform === 'linux',
      background_task_records: true, task_purpose_configuration: true, explicit_execution_state: true,
      permissions: INTEGRATION_OPERATIONS };
  }
  private error(error: unknown) {
    return { type: 'error', ok: false, code: error instanceof CollaborationError ? error.code : 'INTEGRATION_INTERNAL_ERROR',
      error: error instanceof CollaborationError ? error.message : 'Integration operation failed', retryable: !(error instanceof CollaborationError) || error.httpStatus >= 500 };
  }
  private group(id: unknown) {
    const group = typeof id === 'string' ? this.options.messages.getGroup(id) : null;
    if (!group || group.deleted) integrationError('TASK_GROUP_NOT_FOUND', 'A live group is required', 404);
    if (group.federated) integrationError('INTEGRATION_LOCAL_ONLY', 'First integration protocol uses a local collaboration group', 409);
    return group;
  }
  private authorize(p: IntegrationPrincipal, operation: IntegrationPermission, group?: unknown) { this.store.authorize(p, operation, group === undefined ? p.groupId : String(group)); this.group(p.groupId); }
  private taskPermission(p: IntegrationPrincipal, id: string, operation: IntegrationPermission) {
    const task = this.options.taskStore.get(id);
    if (!task || task.groupId !== p.groupId) integrationError('TASK_NOT_FOUND', 'Task does not exist within this integration grant', 404);
    this.authorize(p, operation, task.groupId);
  }
  private origin(p: IntegrationPrincipal, input: unknown): TaskOrigin {
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    if (Buffer.byteLength(JSON.stringify(value)) > 16384) integrationError('INVALID_SOURCE_METADATA', 'Source metadata exceeds 16 KiB');
    if (value.externalActor !== undefined && (!value.externalActor || typeof value.externalActor !== 'object' || Array.isArray(value.externalActor))) integrationError('INVALID_SOURCE_METADATA', 'externalActor must be an object');
    if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== 'object' || Array.isArray(value.metadata))) integrationError('INVALID_SOURCE_METADATA', 'metadata must be an object');
    return { integrationId: p.id, source: typeof value.source === 'string' ? value.source.slice(0, 128) : 'integration',
      ...(value.externalActor ? { externalActor: value.externalActor as Record<string, unknown> } : {}),
      ...(typeof value.externalMessageId === 'string' ? { externalMessageId: value.externalMessageId.slice(0, 512) } : {}),
      ...(value.metadata ? { metadata: value.metadata as Record<string, unknown> } : {}) };
  }
  sync(): void {
    if (this.syncing) return; this.syncing = true;
    try {
      const groups = new Set(this.store.policies().filter(p => !p.revoked).map(p => p.groupId)), updates: Update[] = [];
      if (!groups.size) return;
      for (const task of this.options.taskStore.snapshot()) if (groups.has(task.groupId)) {
        for (const event of task.events) updates.push({ sourceKey: `task:${task.id}:${event.id}`, sourceVersion: '1', eventId: event.id, event: {
          group_id: task.groupId, kind: `task.${event.kind}`, created_at: event.createdAt, task_id: task.id, attempt_id: event.attemptId,
          artifact_id: event.artifactId ?? null, reply_to_event_id: event.replyToEventId ?? null,
          source: event.source ?? (event.actor ? 'member' : 'user'), actor: event.actor, external_actor: event.origin?.externalActor ?? null, payload: { event } } });
        for (const artifact of task.artifacts) if (artifact.kind === 'result') updates.push({ sourceKey: `artifact:${artifact.id}`, sourceVersion: '1', event: {
          group_id: task.groupId, kind: 'task.result', created_at: artifact.createdAt, task_id: task.id, attempt_id: artifact.attemptId,
          artifact_id: artifact.id, source: 'member', actor: artifact.actor, payload: { artifact } } });
        for (const delivery of task.deliveries) updates.push({ sourceKey: `task-delivery:${delivery.id}`, sourceVersion: JSON.stringify(delivery), event: {
          group_id: task.groupId, kind: 'task.delivery', created_at: delivery.deliveredAt ?? task.updatedAt,
          task_id: task.id, attempt_id: delivery.attemptId, message_id: delivery.messageId, source: 'system', payload: { delivery } } });
      }
      for (const message of this.options.messages.snapshotMessages()) if (groups.has(message.groupId)) {
        const link = message.metadata?.termdockTask as { taskId?: string; attemptId?: string; replyToEventId?: string } | undefined;
        const context = { group_id: message.groupId, task_id: link?.taskId ?? null, attempt_id: link?.attemptId ?? null,
          reply_to_event_id: link?.replyToEventId ?? null, message_id: message.id, source: message.fromSessionId ? 'member' : 'system' };
        updates.push({ sourceKey: `message:${message.id}`, sourceVersion: '1', event: { ...context,
          kind: message.kind === 'reply' ? 'message.reply' : 'message.queued', created_at: message.createdAt,
          payload: { message_id: message.id, thread_id: message.threadId, reply_to: message.replyTo ?? null,
            from_session_id: message.fromSessionId, to_session_id: message.toSessionId, content: message.content, metadata: message.metadata ?? null } } });
        const { snapshot: _, ...receipt } = this.options.messages.receipt(message.id);
        updates.push({ sourceKey: `message-status:${message.id}`, sourceVersion: JSON.stringify(receipt), event: {
          ...context, kind: 'message.delivery', created_at: message.deliveredAt ?? message.createdAt, payload: { receipt } } });
      }
      for (const session of this.sessions.snapshot()) if (groups.has(session.group_id)) updates.push({ sourceKey: `session:${session.session_id}`, sourceVersion: JSON.stringify(publicIntegrationSession(session)), event: {
        group_id: session.group_id, kind: `session.${session.state}`, created_at: session.updated_at, source: 'system', actor: { integration_id: session.principal_id }, payload: { session: publicIntegrationSession(session) } } });
      updates.sort((a, b) => a.event.created_at - b.event.created_at);
      this.store.append(updates);
    } finally { this.syncing = false; }
  }
  private failStreams(error: unknown): void {
    for (const stream of this.streams) stream.end(`${JSON.stringify(this.error(error))}\n`);
  }
  private scheduleRetry(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; try { this.sync(); } catch { this.scheduleRetry(); } }, 1000); this.retry.unref();
  }
  private stream(p: IntegrationPrincipal, consumer: string, req: express.Request, res: express.Response): void {
    let cursor: string | undefined, pumping = false, closed = false;
    const key = `${p.id}:${p.groupId}:${consumer}`;
    // Resolve the initial cursor before sending headers so retention gaps
    // and bad consumer names are ordinary machine-readable HTTP errors.
    const initial = this.store.page(p, consumer); cursor = initial.cursor;
    res.setHeader('Content-Type', 'application/x-ndjson'); res.setHeader('Cache-Control', 'no-store'); res.flushHeaders(); this.streams.add(res);
    const stop = this.store.subscribe(() => pump());
    const cleanup = () => { closed = true; stop(); clearInterval(heartbeat); this.streams.delete(res); };
    const pump = () => {
      if (pumping || closed) return; pumping = true;
      try {
        this.authorize(p, 'events.read');
        for (;;) {
          const page = this.store.page(p, consumer, cursor);
          if (!page.events.length) break;
          for (const event of page.events) {
            if (res.writableLength > 1024 * 1024) integrationError('EVENT_CONSUMER_SLOW', 'Reconnect from the last acknowledged cursor', 503);
            res.write(`${JSON.stringify({ type: 'event', ...event })}\n`); cursor = event.cursor;
            this.sent.set(key, Math.max(this.sent.get(key) ?? 0, event.sequence));
          }
        }
      } catch (error) { res.end(`${JSON.stringify(this.error(error))}\n`); cleanup(); }
      finally { pumping = false; }
    };
    const heartbeat = setInterval(() => { pump(); if (!closed) res.write(`${JSON.stringify({ type: 'heartbeat', ack_semantics: 'durable_received' })}\n`); }, 15000); heartbeat.unref();
    res.once('close', cleanup); req.once('aborted', cleanup); pump();
  }
  async listen(): Promise<void> {
    fs.mkdirSync(path.dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    // A stale socket may be removed only after proving no listener exists.
    if (fs.existsSync(this.options.socketPath)) {
      const { createConnection } = await import('node:net');
      const active = await new Promise<boolean>((resolve, reject) => {
        const socket = createConnection(this.options.socketPath); socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); if (['ECONNREFUSED', 'ENOENT'].includes(error.code ?? '')) resolve(false); else reject(error); });
      });
      if (active) integrationError('INTEGRATION_SOCKET_IN_USE', 'Another integration service owns this socket', 409);
      if (!fs.lstatSync(this.options.socketPath).isSocket()) integrationError('INTEGRATION_SOCKET_INVALID', 'Refusing to replace a non-socket file');
      fs.unlinkSync(this.options.socketPath);
    }
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.options.socketPath, () => { this.server.removeListener('error', reject); fs.chmodSync(this.options.socketPath, 0o600); resolve(); }); });
    this.sync(); await this.sessions.refreshAll();
  }
  async close(): Promise<void> {
    for (const stop of this.stops) stop(); if (this.retry) clearTimeout(this.retry); this.sessions.close();
    for (const stream of this.streams) stream.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
