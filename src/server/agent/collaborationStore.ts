import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
export type CollaborationMessageStatus = 'pending' | 'delivered' | 'read';

export interface CollaborationMessage {
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
}

const MAX_MESSAGES = 2_000;
const MESSAGE_KINDS = new Set<CollaborationMessageKind>(['message', 'ask', 'reply', 'task', 'handoff', 'done']);

export class CollaborationStore {
  private document: CollaborationDocument = { version: 2, groups: [], messages: [] };

  constructor(private readonly filePath: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CollaborationDocument>;
      if (Array.isArray(parsed.groups)) {
        this.document.groups = parsed.groups.filter((group) => group && typeof group.id === 'string' && Array.isArray(group.sessionIds));
      }
      if (Array.isArray(parsed.messages)) {
        this.document.messages = parsed.messages.filter((message) =>
          message && typeof message.id === 'string' && typeof message.toSessionId === 'string' && MESSAGE_KINDS.has(message.kind),
        ).slice(-MAX_MESSAGES);
      }
    } catch { /* first run */ }
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

  send(input: {
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
    const content = input.content.trim();
    if (!content) throw new Error('消息不能为空');
    const recipients = Array.from(new Set(input.toSessionIds)).filter((id) =>
      group.sessionIds.includes(id) && id !== input.fromSessionId,
    );
    if (recipients.length === 0) throw new Error('没有有效的接收会话');
    const now = Date.now();
    const threadId = input.threadId?.trim() || crypto.randomUUID();
    const messages = recipients.map((toSessionId): CollaborationMessage => ({
      id: crypto.randomUUID(), groupId: group.id, fromSessionId: input.fromSessionId,
      toSessionId, kind: input.kind, content, threadId,
      replyTo: input.replyTo?.trim() || null, status: 'pending', createdAt: now,
      deliveredAt: null, readAt: null,
    }));
    this.document.messages = [...this.document.messages, ...messages].slice(-MAX_MESSAGES);
    this.persist();
    return messages;
  }

  listMessages(groupId: string, limit = 200): CollaborationMessage[] {
    return this.document.messages.filter((message) => message.groupId === groupId).slice(-Math.max(1, Math.min(limit, 500)));
  }

  getMessage(id: string): CollaborationMessage | null {
    return this.document.messages.find((message) => message.id === id) ?? null;
  }

  inbox(sessionId: string, options: { pendingOnly?: boolean; limit?: number } = {}): CollaborationMessage[] {
    return this.document.messages
      .filter((message) => message.toSessionId === sessionId && (!options.pendingOnly || message.status === 'pending'))
      .slice(-Math.max(1, Math.min(options.limit ?? 50, 200)));
  }

  markDelivered(messageIds: string[]): CollaborationMessage[] {
    return this.updateStatus(messageIds, 'delivered');
  }

  markRead(messageIds: string[]): CollaborationMessage[] {
    return this.updateStatus(messageIds, 'read');
  }

  private updateStatus(messageIds: string[], status: 'delivered' | 'read'): CollaborationMessage[] {
    const ids = new Set(messageIds);
    const now = Date.now();
    const changed: CollaborationMessage[] = [];
    this.document.messages = this.document.messages.map((message) => {
      if (!ids.has(message.id)) return message;
      const updated: CollaborationMessage = status === 'read'
        ? { ...message, status, deliveredAt: message.deliveredAt ?? now, readAt: now }
        : message.status === 'pending' ? { ...message, status, deliveredAt: now } : message;
      changed.push(updated);
      return updated;
    });
    if (changed.length > 0) this.persist();
    return changed;
  }

  federationSnapshot(): { groups: CollaborationGroup[]; messages: CollaborationMessage[] } {
    const groups = this.document.groups.filter((group) => group.federated);
    const ids = new Set(groups.filter((group) => !group.deleted).map((group) => group.id));
    return { groups, messages: this.document.messages.filter((message) => ids.has(message.groupId)) };
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
    const rank = { pending: 0, delivered: 1, read: 2 };
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const group = this.getGroup(message.groupId);
      if (!group?.federated || group.deleted || !group.sessionIds.includes(message.toSessionId)
        || (message.fromSessionId !== null && !group.sessionIds.includes(message.fromSessionId))
        || typeof message.id !== 'string' || typeof message.threadId !== 'string' || !Number.isFinite(message.createdAt)
        || typeof message.content !== 'string'
        || message.content.length > 20_000 || !MESSAGE_KINDS.has(message.kind)
        || !Object.hasOwn(rank, message.status)) continue;
      const index = this.document.messages.findIndex((item) => item.id === message.id);
      if (index < 0) { this.document.messages.push(message); changed = true; }
      else if (rank[message.status] > rank[this.document.messages[index].status]) {
        const existing = this.document.messages[index];
        // A receipt may advance status, but never rewrite an existing message.
        this.document.messages[index] = { ...existing, status: message.status,
          deliveredAt: message.deliveredAt, readAt: message.readAt };
        changed = true;
      }
    }
    if (changed) { this.document.messages = this.document.messages.slice(-MAX_MESSAGES); this.persist(); }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.document, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
