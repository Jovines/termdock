import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface CollaborationGroup {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  updatedAt: number;
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
    return [...this.document.groups].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getGroup(id: string): CollaborationGroup | null {
    return this.document.groups.find((group) => group.id === id) ?? null;
  }

  save(input: { id?: string; name: string; sessionIds: string[] }): CollaborationGroup {
    const now = Date.now();
    const existing = input.id ? this.document.groups.find((group) => group.id === input.id) : null;
    const group: CollaborationGroup = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name.trim(),
      sessionIds: Array.from(new Set(input.sessionIds.map((id) => id.trim()).filter(Boolean))),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.document.groups = existing
      ? this.document.groups.map((candidate) => candidate.id === group.id ? group : candidate)
      : [...this.document.groups, group];
    this.persist();
    return group;
  }

  remove(id: string): boolean {
    const before = this.document.groups.length;
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
      if (dissolvedIds.has(group.id)) return [];
      return [{ ...group, sessionIds: group.sessionIds.filter((id) => id !== sessionId), updatedAt: now }];
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
    this.document = { version: 2, groups: [], messages: [] };
    this.persist();
  }

  groupsForSession(sessionId: string): CollaborationGroup[] {
    return this.document.groups.filter((group) => group.sessionIds.includes(sessionId));
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
    if (!group) throw new Error('协作组不存在');
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

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.document, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
