import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COLLAB_LIMITS, CollaborationError, STATUS_RANK, validateExtras, type MessageExtras, type MessageFragment, type TransportDiagnostic } from './collaborationProtocol.js';

export interface CollaborationGroup {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  updatedAt: number;
  federated?: boolean;
  deleted?: boolean;
  remoteSessions?: CollaborationRemoteSession[];
}

export interface CollaborationRemoteSession {
  sessionId: string;
  serviceOrigin: string;
  serviceLabel: string;
  serviceConnected?: boolean;
  serviceCheckedAt?: number;
  name: string;
  cwd: string;
  status: string;
  capability: string;
  currentTask: string;
  updatedAt: number;
  backendSessionId: null;
  agentNativeSessionId: null;
  agent: { slug: string; displayName: string } | null;
}

export type CollaborationMessageKind = 'message' | 'ask' | 'reply' | 'task' | 'handoff' | 'done';
export type CollaborationMessageStatus = 'pending' | 'delivered' | 'read' | 'failed' | 'expired';

export interface CollaborationMessage extends MessageExtras {
  sequence?: number;
  failureReason?: string | null;
  readSource?: 'explicit' | 'legacy_or_unspecified';
  deliverySource?: 'pty_written' | 'consumer_read' | 'legacy_or_unspecified';
  id: string;
  groupId: string;
  fromSessionId: string | null;
  toSessionId: string;
  kind: CollaborationMessageKind;
  content: string;
  threadId: string;
  replyTo: string | null;
  status: CollaborationMessageStatus;
  createdAt: number;
  deliveredAt: number | null;
  readAt: number | null;
}

interface CollaborationDocument {
  version: 2;
  groups: CollaborationGroup[];
  messages: CollaborationMessage[];
  sequence?: number;
  idempotency?: Record<string, { hash: string; ids: string[]; expiresAt: number }>;
  consumers?: Record<string, number>;
  transport?: Record<string, TransportDiagnostic>;
  prunedThrough?: Record<string, number>;
  fragments?: Record<string, { groupId: string; total: number; sha256: string; chunks: Record<string, string>; createdAt: number }>;
}

const MAX_MESSAGES = 2_000;
const MESSAGE_KINDS = new Set<CollaborationMessageKind>(['message', 'ask', 'reply', 'task', 'handoff', 'done']);

export class CollaborationStore {
  private document: CollaborationDocument = { version: 2, groups: [], messages: [] };
  private persistedDocument = JSON.stringify(this.document);

  constructor(private readonly filePath: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CollaborationDocument>;
      if (Array.isArray(parsed.groups)) {
        this.document.groups = parsed.groups.filter((group) => group && typeof group.id === 'string' && Array.isArray(group.sessionIds));
      }
      if (Array.isArray(parsed.messages)) {
        this.document.messages = parsed.messages.filter((message) =>
          message && typeof message.id === 'string' && typeof message.toSessionId === 'string' && MESSAGE_KINDS.has(message.kind),
        );
        for (const message of this.document.messages) {
          message.sequence ??= (this.document.sequence ?? 0) + 1;
          this.document.sequence = Math.max(this.document.sequence ?? 0, message.sequence);
        }
      }
      this.document.sequence = Math.max(parsed.sequence ?? 0, this.document.sequence ?? 0);

      this.document.idempotency = parsed.idempotency ?? {};
      this.document.consumers = parsed.consumers ?? {};
      this.document.transport = parsed.transport ?? {};
      this.document.fragments = parsed.fragments ?? {};
      this.document.prunedThrough = parsed.prunedThrough ?? {};
    } catch { /* first run */ }
    this.persistedDocument = JSON.stringify(this.document);
  }

  list(): CollaborationGroup[] {
    return this.document.groups.filter((group) => !group.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getGroup(id: string): CollaborationGroup | null {
    return this.document.groups.find((group) => group.id === id) ?? null;
  }

  save(input: { id?: string; name: string; sessionIds: string[] }): CollaborationGroup {
    const now = Date.now();
    const existing = input.id ? this.document.groups.find((group) => group.id === input.id) : null;
    const group: CollaborationGroup = {
      ...existing,
      ...(existing?.remoteSessions ? { remoteSessions: existing.remoteSessions.filter((session) => input.sessionIds.includes(session.sessionId)) } : {}),
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name.trim(),
      sessionIds: Array.from(new Set(input.sessionIds.map((id) => id.trim()).filter(Boolean))),
      createdAt: existing?.createdAt ?? now,
      updatedAt: Math.max(now, (existing?.updatedAt ?? 0) + 1),
    };
    this.document.groups = existing
      ? this.document.groups.map((candidate) => candidate.id === group.id ? group : candidate)
      : [...this.document.groups, group];
    this.persist();
    return group;
  }

  remove(id: string): boolean {
    const before = this.document.groups.length;
    const existing = this.getGroup(id);
    if (existing?.federated) {
      this.mergeFederatedGroup({ ...existing, deleted: true, updatedAt: Math.max(Date.now(), existing.updatedAt + 1) });
      return true;
    }
    this.document.groups = this.document.groups.filter((group) => group.id !== id);
    if (before === this.document.groups.length) return false;
    this.document.messages = this.document.messages.filter((message) => message.groupId !== id);
    this.persist();
    return true;
  }

  removeSession(sessionId: string): { updatedGroups: number; dissolvedGroups: number } {
    const affected = this.document.groups.filter((group) => group.sessionIds.includes(sessionId));
    if (affected.length === 0) return { updatedGroups: 0, dissolvedGroups: 0 };
    const dissolvedIds = new Set(affected.filter((group) => group.sessionIds.length <= 2).map((group) => group.id));
    const now = Date.now();
    this.document.groups = this.document.groups.flatMap((group) => {
      if (!group.sessionIds.includes(sessionId)) return [group];
      if (dissolvedIds.has(group.id)) return group.federated ? [{ ...group, deleted: true, updatedAt: Math.max(now, group.updatedAt + 1) }] : [];
      return [{ ...group, sessionIds: group.sessionIds.filter((id) => id !== sessionId), updatedAt: Math.max(now, group.updatedAt + 1) }];
    });
    this.document.messages = this.document.messages.filter((message) =>
      !dissolvedIds.has(message.groupId)
      && message.fromSessionId !== sessionId
      && message.toSessionId !== sessionId,
    );
    this.persist();
    return { updatedGroups: affected.length - dissolvedIds.size, dissolvedGroups: dissolvedIds.size };
  }

  clear(): void {
    if (this.document.groups.length === 0 && this.document.messages.length === 0) return;
    this.document = { version: 2, groups: this.document.groups.filter((group) => group.federated)
      .map((group) => ({ ...group, deleted: true, updatedAt: Math.max(Date.now(), group.updatedAt + 1) })), messages: [] };
    this.persist();
  }

  groupsForSession(sessionId: string): CollaborationGroup[] {
    return this.list().filter((group) => group.sessionIds.includes(sessionId));
  }

  send(input: MessageExtras & {
    groupId: string;
    fromSessionId: string | null;
    toSessionIds: string[];
    kind: CollaborationMessageKind;
    content: string;
    threadId?: string | null;
    replyTo?: string | null;
  }): CollaborationMessage[] {
    const group = this.getGroup(input.groupId);
    if (!group || group.deleted) throw new Error('协作组不存在');
    if (!MESSAGE_KINDS.has(input.kind)) throw new Error('消息类型无效');
    const extras = validateExtras(input);
    const content = input.content;
    if (Buffer.byteLength(content) > COLLAB_LIMITS.message_bytes) throw new CollaborationError('MESSAGE_TOO_LARGE', `Message exceeds ${COLLAB_LIMITS.message_bytes} UTF-8 bytes`, 413);
    if (!content.trim()) throw new Error('消息不能为空');
    const recipients = Array.from(new Set(input.toSessionIds)).filter((id) =>
      group.sessionIds.includes(id) && id !== input.fromSessionId,
    );
    if (recipients.length === 0) throw new Error('没有有效的接收会话');
    const now = Date.now();
    const key = input.idempotencyKey ? JSON.stringify([input.groupId, input.fromSessionId, input.idempotencyKey]) : null;
    const hash = crypto.createHash('sha256').update(stableJson([recipients.slice().sort(), input.kind, content, input.threadId ?? null, input.replyTo ?? null, extras.responseKind, extras.metadata, extras.task, extras.expiresAt])).digest('hex');
    const previous = key ? this.document.idempotency?.[key] : null;
    if (previous && previous.expiresAt > now) {
      if (previous.hash !== hash) throw new CollaborationError('IDEMPOTENCY_CONFLICT', 'This key was already used with a different payload', 409);
      const originals = previous.ids.map((id) => this.getMessage(id));
      if (originals.some((message) => !message)) throw new CollaborationError('IDEMPOTENCY_RECORD_GONE', 'Original message removed; this key cannot be reused yet', 409);
      return originals as CollaborationMessage[];
    }
    const threadId = input.threadId?.trim() || crypto.randomUUID();
    const messages = recipients.map((toSessionId): CollaborationMessage => ({
      idempotencyKey: input.idempotencyKey, responseKind: extras.responseKind, metadata: extras.metadata, task: extras.task, expiresAt: extras.expiresAt,
      sequence: this.nextSequence(),
      id: crypto.randomUUID(), groupId: group.id, fromSessionId: input.fromSessionId,
      toSessionId, kind: input.kind, content, threadId,
      replyTo: input.replyTo?.trim() || null, status: 'pending', createdAt: now,
      deliveredAt: null, readAt: null,
    }));
    if (messages.some((message) => Buffer.byteLength(JSON.stringify(message)) > COLLAB_LIMITS.wire_bytes)) throw new CollaborationError('MESSAGE_WIRE_TOO_LARGE', `Encoded message exceeds ${COLLAB_LIMITS.wire_bytes} JSON bytes`, 413);
    this.document.messages.push(...messages);
    if (key) (this.document.idempotency ??= {})[key] = { hash, ids: messages.map((message) => message.id), expiresAt: now + COLLAB_LIMITS.idempotency_retention_ms };
    this.persist();
    return messages;
  }

  listMessages(groupId: string, limit = 200): CollaborationMessage[] {
    return this.document.messages.filter((message) => message.groupId === groupId).slice(-Math.max(1, Math.min(limit, 500)));
  }

  getMessage(id: string): CollaborationMessage | null {
    this.expire();
    return this.document.messages.find((message) => message.id === id) ?? null;
  }

  inbox(sessionId: string, options: { pendingOnly?: boolean; limit?: number } = {}): CollaborationMessage[] {
    this.expire();
    const matches = this.document.messages.filter((message) => message.toSessionId === sessionId && (!options.pendingOnly || message.status === 'pending'));
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    return options.pendingOnly ? matches.slice(0, limit) : matches.slice(-limit);
  }

  pendingCount(sessionId: string): number {
    this.expire();
    return this.document.messages.filter((message) => message.toSessionId === sessionId && message.status === 'pending').length;
  }

  markDelivered(messageIds: string[]): CollaborationMessage[] {
    return this.updateStatus(messageIds, 'delivered');
  }

  markRead(messageIds: string[]): CollaborationMessage[] {
    return this.updateStatus(messageIds, 'read');
  }

  private updateStatus(messageIds: string[], status: 'delivered' | 'read'): CollaborationMessage[] {
    const ids = new Set(messageIds);
    this.expire();
    const now = Date.now();
    const changed: CollaborationMessage[] = [];
    this.document.messages = this.document.messages.map((message) => {
      if (!ids.has(message.id) || message.status === 'expired' || message.status === 'failed' || message.status === 'read') return message;
      const updated: CollaborationMessage = status === 'read'
        ? { ...message, status, deliveredAt: message.deliveredAt ?? now, readAt: now, readSource: 'explicit', deliverySource: message.deliverySource ?? (message.deliveredAt === null ? 'consumer_read' : 'legacy_or_unspecified') }
        : message.status === 'pending' ? { ...message, status, deliveredAt: now, deliverySource: 'pty_written' } : message;
      changed.push(updated);
      return updated;
    });
    if (changed.length > 0) this.persist();
    return changed;
  }

  federationSnapshot(): { groups: CollaborationGroup[]; messages: CollaborationMessage[]; transportDiagnostics: Record<string, TransportDiagnostic> } {
    this.expire();
    const groups = this.document.groups.filter((group) => group.federated);
    const ids = new Set(groups.filter((group) => !group.deleted).map((group) => group.id));
    const messages = this.document.messages.filter((message) => ids.has(message.groupId));
    return { groups, messages, transportDiagnostics: Object.fromEntries(messages.flatMap((message) => this.document.transport?.[message.id] ? [[message.id, this.document.transport[message.id]]] : [])) };
  }

  mergeFederatedGroup(group: CollaborationGroup): void {
    if (!group.federated || typeof group.id !== 'string' || !group.id.startsWith('cross-') || typeof group.name !== 'string' || !group.name.trim()
      || !Number.isFinite(group.updatedAt) || !Number.isFinite(group.createdAt)
      || !Array.isArray(group.sessionIds) || group.sessionIds.some((id) => typeof id !== 'string')
      || !Array.isArray(group.remoteSessions) || group.remoteSessions.some((session) => !session
        || typeof session.sessionId !== 'string' || !session.sessionId.startsWith('remote:')
        || typeof session.serviceOrigin !== 'string' || typeof session.serviceLabel !== 'string'
        || typeof session.name !== 'string' || !group.sessionIds.includes(session.sessionId))
      || (!group.deleted && new Set(group.sessionIds).size < 2)) throw new Error('跨服务工作组无效');
    const existing = this.getGroup(group.id);
    if (existing && (!existing.federated || existing.updatedAt > group.updatedAt)) return;
    this.document.groups = [...this.document.groups.filter((item) => item.id !== group.id), group];
    if (group.deleted) this.document.messages = this.document.messages.filter((item) => item.groupId !== group.id);
    this.persist();
  }

  mergeFederatedMessages(messages: CollaborationMessage[]): void {
    let changed = false;
    const rank = STATUS_RANK;
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const group = this.getGroup(message.groupId);
      if (!group?.federated || group.deleted || !group.sessionIds.includes(message.toSessionId)
        || (message.fromSessionId !== null && !group.sessionIds.includes(message.fromSessionId))
        || typeof message.id !== 'string' || typeof message.threadId !== 'string' || !Number.isFinite(message.createdAt)
        || typeof message.content !== 'string'
        || Buffer.byteLength(message.content) > COLLAB_LIMITS.message_bytes || !MESSAGE_KINDS.has(message.kind)
        || !Object.hasOwn(rank, message.status) || Buffer.byteLength(JSON.stringify(message)) > COLLAB_LIMITS.wire_bytes) continue;
      try { validateExtras(message); } catch { continue; }
      const index = this.document.messages.findIndex((item) => item.id === message.id);
      if (index < 0) { this.document.messages.push({ ...message, sequence: this.nextSequence() }); changed = true; }
      else if (rank[message.status] > rank[this.document.messages[index].status]) {
        const existing = this.document.messages[index];
        // A receipt may advance status, but never rewrite an existing message.
        this.document.messages[index] = { ...existing, status: message.status,
          deliveredAt: message.deliveredAt, readAt: message.readAt, failureReason: message.failureReason, readSource: message.readSource, deliverySource: message.deliverySource };
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private nextSequence(): number { return this.document.sequence = (this.document.sequence ?? 0) + 1; }

  private expire(): void {
    let changed = false;
    for (const message of this.document.messages) if (message.status === 'pending' && message.expiresAt && message.expiresAt <= Date.now()) {
      message.status = 'expired'; message.failureReason = 'MESSAGE_EXPIRED'; changed = true;
    }
    if (changed) this.persist();
  }

  fail(id: string, reason: string): void {
    const message = this.getMessage(id);
    if (message?.status === 'pending') { message.status = 'failed'; message.failureReason = reason; this.persist(); }
  }

  diagnostic(id: string): TransportDiagnostic | null { return this.document.transport?.[id] ?? null; }
  recordTransport(id: string, diagnostic: TransportDiagnostic): void {
    if (!this.getMessage(id)) return;
    (this.document.transport ??= {})[id] = diagnostic;
    this.persist();
  }

  receipt(id: string) {
    const message = this.getMessage(id);
    if (!message) throw new CollaborationError('MESSAGE_NOT_FOUND', 'Message not found or no longer retained', 404);
    const replies = this.document.messages.filter((reply) => reply.replyTo === id && reply.fromSessionId === message.toSessionId && reply.toSessionId === message.fromSessionId);
    const diagnostic = this.diagnostic(id);
    return { message_id: id, thread_id: message.threadId, status: message.status, queued_at: message.createdAt,
      delivered_at: message.deliveredAt, read_at: message.readAt, expires_at: message.expiresAt ?? null,
      failure_reason: message.failureReason ?? null, delivery_semantics: message.deliverySource ?? (message.deliveredAt === null ? 'not_delivered' : 'legacy_or_unspecified'), read_semantics: message.readAt ? message.readSource ?? 'legacy_or_unspecified' : 'not_read',
      idempotency_key: message.idempotencyKey ?? null,
      ack_at: replies.find((reply) => reply.responseKind === 'ack')?.createdAt ?? null,
      reply_ids: replies.map((reply) => reply.id), result_ids: replies.filter((reply) => reply.responseKind === 'result').map((reply) => reply.id),
      response_kind: message.responseKind ?? null, task: message.task ?? null,
      size_bytes: Buffer.byteLength(message.content),
      relay_online: diagnostic && Date.now() - diagnostic.checked_at < 15_000 ? diagnostic.relay_online : null,
      peer_reachable: diagnostic && Date.now() - diagnostic.checked_at < 15_000 ? diagnostic.peer_reachable : null,
      attempt_count: diagnostic?.attempt_count ?? 0, next_retry_at: diagnostic?.next_retry_at ?? null,
      last_error: diagnostic?.last_error ?? null, transport_checked_at: diagnostic?.checked_at ?? null,
      fragments_sent: diagnostic?.fragments_sent ?? 0, fragments_total: diagnostic?.fragments_total ?? 0 };
  }

  sessionFacts(sessionId: string, online: boolean, turnState?: string) {
    const reports = this.document.messages.filter((message) => message.fromSessionId === sessionId);
    const tasks = new Map<string, { task_id: string; status: string; reported_at: number; message_id: string }>();
    for (const message of reports) if (message.task) tasks.set(message.task.task_id, { task_id: message.task.task_id, status: message.task.status, reported_at: message.createdAt, message_id: message.id });
    return { session_state: online ? 'online' : 'offline', turn_state: turnState === 'done' ? 'ended' : turnState ?? 'unknown',
      task_state: 'unknown', tasks: [...tasks.values()], last_heartbeat: null, last_tool_activity_at: null,
      last_message_at: reports.length ? Math.max(...reports.map((message) => message.createdAt)) : null,
      state_source: 'optional_adapter', task_source: 'explicit_message' };
  }

  page(sessionId: string, options: { unread?: boolean; since?: number; afterId?: string; cursor?: string; consumer?: string; limit?: number; from?: string; group?: string; thread?: string; kind?: string; responseKind?: string; order?: string } = {}) {
    this.expire();
    if (options.responseKind && !['ack', 'progress', 'result'].includes(options.responseKind)) throw new CollaborationError('INVALID_RESPONSE_KIND', 'response_kind must be ack, progress or result');
    if (options.kind && !MESSAGE_KINDS.has(options.kind as CollaborationMessageKind)) throw new CollaborationError('INVALID_KIND', 'Unknown message kind');
    const limit = options.limit ?? COLLAB_LIMITS.default_page_size;
    if (!Number.isInteger(limit) || limit < 1 || limit > COLLAB_LIMITS.max_page_size) throw new CollaborationError('INVALID_LIMIT', 'limit must be 1–200');
    if (options.consumer !== undefined && (!options.consumer || options.consumer.length > 128)) throw new CollaborationError('INVALID_CONSUMER', 'consumer must contain 1–128 characters');
    if (options.cursor && options.afterId) throw new CollaborationError('INVALID_CURSOR', 'Choose cursor or after-id');
    const scope = JSON.stringify([sessionId, options.group ?? null, options.thread ?? null, options.from ?? null, options.kind ?? null, options.responseKind ?? null, options.unread ?? false, options.since ?? null]);
    const consumerKey = JSON.stringify([scope, options.consumer]);
    let after = options.consumer ? this.document.consumers?.[consumerKey] ?? 0 : 0;
    if (options.cursor) {
      try { const decoded = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
        if (decoded.scope !== scope || !Number.isSafeInteger(decoded.sequence) || decoded.sequence < 0) throw new Error();
        after = decoded.sequence;
      } catch { throw new CollaborationError('INVALID_CURSOR', 'Cursor is invalid or belongs to different filters'); }
    }
    if (options.afterId) {
      const anchor = this.getMessage(options.afterId);
      if (!anchor || anchor.toSessionId !== sessionId) throw new CollaborationError('CURSOR_GONE', 'after-id is unknown or no longer retained; resync explicitly', 410);
      after = anchor.sequence ?? 0;
    }
    const incremental = Boolean(options.cursor || options.afterId || options.consumer || options.since !== undefined);
    const candidates = this.document.messages.filter((message) => message.toSessionId === sessionId && (message.sequence ?? 0) > after
      && (!options.unread || message.status !== 'read') && (options.since === undefined || message.createdAt > options.since)
      && (!options.from || message.fromSessionId === options.from) && (!options.group || message.groupId === options.group)
      && (!options.thread || message.threadId === options.thread) && (!options.kind || message.kind === options.kind)
      && (!options.responseKind || message.responseKind === options.responseKind))
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    const messages = incremental || options.order === 'oldest' ? candidates.slice(0, limit) : candidates.slice().sort((a, b) => Number(a.status === 'read') - Number(b.status === 'read') || (b.sequence ?? 0) - (a.sequence ?? 0)).slice(0, limit);
    const sequence = messages.length ? Math.max(...messages.map((message) => message.sequence ?? 0)) : after;
    const next_cursor = Buffer.from(JSON.stringify({ scope, sequence })).toString('base64url');
    return { messages, next_cursor, retention_gap: incremental && after < (this.document.prunedThrough?.[sessionId] ?? 0), has_more: incremental ? candidates.length > messages.length : false, consumer: options.consumer ?? null };
  }

  commitCursor(sessionId: string, cursor: string, consumer: string): void {
    if (!consumer || consumer.length > 128) throw new CollaborationError('INVALID_CONSUMER', 'consumer must contain 1–128 characters');
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (JSON.parse(decoded.scope)[0] !== sessionId || !Number.isSafeInteger(decoded.sequence) || decoded.sequence < 0 || decoded.sequence > (this.document.sequence ?? 0)) throw new Error();
      const key = JSON.stringify([decoded.scope, consumer]);
      (this.document.consumers ??= {})[key] = Math.max(this.document.consumers?.[key] ?? 0, decoded.sequence);
      this.persist();
    } catch { throw new CollaborationError('INVALID_CURSOR', 'Invalid consumption cursor'); }
  }

  acceptFragment(fragment: MessageFragment): { message_id: string; received: number; total: number; complete: boolean } {
    const group = this.getGroup(fragment.group_id);
    if (!group?.federated || group.deleted || typeof fragment.message_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(fragment.message_id) || ['__proto__', 'constructor', 'prototype'].includes(fragment.message_id) || !Number.isInteger(fragment.total) || fragment.total < 1 || fragment.total > 64
      || !Number.isInteger(fragment.index) || fragment.index < 0 || fragment.index >= fragment.total || !/^[a-f0-9]{64}$/.test(fragment.sha256)
      || typeof fragment.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(fragment.data) || Buffer.from(fragment.data, 'base64').length > COLLAB_LIMITS.fragment_bytes) throw new CollaborationError('INVALID_FRAGMENT', 'Invalid message fragment');
    const existing = this.getMessage(fragment.message_id);
    if (existing) {
      if (existing.groupId !== fragment.group_id) throw new CollaborationError('FRAGMENT_CONFLICT', 'Message belongs to another group', 409);
      return { message_id: existing.id, received: fragment.total, total: fragment.total, complete: true };
    }
    const fragments = this.document.fragments ??= {};
    for (const [id, state] of Object.entries(fragments)) if (state.createdAt + COLLAB_LIMITS.fragment_ttl_ms < Date.now()) delete fragments[id];
    if (!fragments[fragment.message_id] && Object.keys(fragments).length >= 32) throw new CollaborationError('FRAGMENT_CAPACITY', 'Too many incomplete messages', 429);
    const state = fragments[fragment.message_id] ??= { groupId: fragment.group_id, total: fragment.total, sha256: fragment.sha256, chunks: {}, createdAt: Date.now() };
    if (state.groupId !== fragment.group_id || state.total !== fragment.total || state.sha256 !== fragment.sha256 || (state.chunks[fragment.index] && state.chunks[fragment.index] !== fragment.data)) throw new CollaborationError('FRAGMENT_CONFLICT', 'Conflicting fragment', 409);
    state.chunks[fragment.index] = fragment.data;
    const received = Object.keys(state.chunks).length;
    if (received === state.total) {
      const bytes = Buffer.concat(Array.from({ length: state.total }, (_, index) => Buffer.from(state.chunks[index], 'base64')));
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== state.sha256) throw new CollaborationError('FRAGMENT_CHECKSUM', 'Message checksum mismatch');
      const message = JSON.parse(bytes.toString()) as CollaborationMessage;
      if (message.id !== fragment.message_id || message.groupId !== fragment.group_id) throw new CollaborationError('FRAGMENT_IDENTITY', 'Message identity mismatch');
      this.mergeFederatedMessages([message]);
      if (!this.getMessage(message.id)) throw new CollaborationError('INVALID_MESSAGE', 'Reassembled message rejected');
      delete fragments[fragment.message_id];
    }
    this.persist();
    return { message_id: fragment.message_id, received, total: state.total, complete: received === state.total };
  }

  private persist(): void {
    const now = Date.now();
    for (const [key, record] of Object.entries(this.document.idempotency ?? {})) if (record.expiresAt <= now) delete this.document.idempotency![key];
    const protectedIds = new Set(Object.values(this.document.idempotency ?? {}).flatMap((record) => record.ids));
    const history = this.document.messages.filter((message) => message.status !== 'pending' && !protectedIds.has(message.id)).slice(-MAX_MESSAGES);
    const retained = new Set(history.map((message) => message.id));
    this.document.messages = this.document.messages.filter((message) => {
      if (message.status === 'pending' || protectedIds.has(message.id) || retained.has(message.id)) return true;
      (this.document.prunedThrough ??= {})[message.toSessionId] = Math.max(this.document.prunedThrough?.[message.toSessionId] ?? 0, message.sequence ?? 0);
      delete this.document.transport?.[message.id];
      return false;
    });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const serialized = JSON.stringify(this.document);
      fs.writeFileSync(temporaryPath, serialized, { mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
      this.persistedDocument = serialized;
    } catch (error) { this.document = JSON.parse(this.persistedDocument) as CollaborationDocument; throw error; }
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}
