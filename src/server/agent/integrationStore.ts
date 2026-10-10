import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CollaborationError } from './collaborationProtocol.js';

export const INTEGRATION_PROTOCOL = 1;
export const INTEGRATION_OPERATIONS = ['message.send', 'message.read', 'task.read', 'task.create', 'task.configure', 'task.assign', 'task.comment', 'task.revise', 'task.answer', 'events.read', 'session.create', 'session.read', 'session.restore', 'session.release'] as const;
export type IntegrationPermission = typeof INTEGRATION_OPERATIONS[number];
export interface StartupInputCondition {
  /** Literal terms in the current terminal viewport, with horizontal space folded. */
  allOf: string[]; noneOf?: string[]; stableMs?: number; timeoutMs?: number;
}
export interface LaunchProfile {
  id: string; agentSlug: string; executable: string; argv: string[]; cwdRoots: string[];
  /** Exact structured resume template; {sessionId} must be its own argument. */
  resumeArgv: string[];
  startupInput?: StartupInputCondition;
}
export interface IntegrationPolicy { id: string; groupId: string; permissions: IntegrationPermission[]; launchProfiles: LaunchProfile[] }
export interface IntegrationPrincipal extends IntegrationPolicy { tokenHash: string; revoked: boolean }
export interface IntegrationEvent {
  event_id: string; group_id: string; sequence: number; cursor: string; kind: string; created_at: number;
  task_id?: string | null; attempt_id?: string | null; artifact_id?: string | null; message_id?: string | null;
  reply_to_event_id?: string | null; source?: string; actor?: unknown; external_actor?: unknown; payload: unknown;
}
interface Journal {
  version: 1; principals: IntegrationPrincipal[]; events: IntegrationEvent[];
  sequences: Record<string, number>; prunedThrough: Record<string, number>;
  sources: Record<string, string>; consumers: Record<string, number>;
}
export function integrationError(code: string, message: string, status = 400): never { throw new CollaborationError(code, message, status); }
export function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, 'w', 0o600);
  try { fs.fchmodSync(descriptor, 0o600); fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(value)) integrationError('INVALID_INTEGRATION_POLICY', `Invalid ${label}`);
}
export function validatePolicy(value: IntegrationPolicy): IntegrationPolicy {
  identifier(value?.id, 'principal id');
  if (!value.groupId || typeof value.groupId !== 'string' || value.groupId.length > 160) integrationError('INVALID_INTEGRATION_POLICY', 'A single groupId is required');
  if (!Array.isArray(value.permissions) || value.permissions.some(p => !INTEGRATION_OPERATIONS.includes(p))) integrationError('INVALID_INTEGRATION_POLICY', 'Unknown permission');
  if (!Array.isArray(value.launchProfiles) || value.launchProfiles.length > 16) integrationError('INVALID_INTEGRATION_POLICY', 'launchProfiles must be an array');
  const ids = new Set<string>();
  for (const profile of value.launchProfiles) {
    identifier(profile?.id, 'profile id'); identifier(profile.agentSlug, 'agent slug');
    if (ids.has(profile.id)) integrationError('INVALID_INTEGRATION_POLICY', 'Duplicate launch profile'); ids.add(profile.id);
    if (typeof profile.executable !== 'string' || !path.isAbsolute(profile.executable) || /[\x00-\x1f\x7f]/.test(profile.executable)) integrationError('INVALID_INTEGRATION_POLICY', 'Launcher must be an absolute path');
    if (!Array.isArray(profile.argv) || !Array.isArray(profile.resumeArgv) || [...profile.argv, ...profile.resumeArgv].some(a => typeof a !== 'string' || /[\x00-\x1f\x7f]/.test(a) || a.length > 8192) || profile.argv.length > 128 || profile.resumeArgv.length > 128) integrationError('INVALID_INTEGRATION_POLICY', 'Invalid structured argv');
    if (profile.resumeArgv.filter(a => a === '{sessionId}').length !== 1 || profile.resumeArgv.filter(a => a === '{launchArgs}').length !== 1 || profile.resumeArgv.some(a => a.includes('{sessionId}') && a !== '{sessionId}') || profile.resumeArgv.includes('--last')) integrationError('INVALID_INTEGRATION_POLICY', 'resumeArgv requires one {sessionId} and one {launchArgs}; --last is forbidden');
    if (!Array.isArray(profile.cwdRoots) || !profile.cwdRoots.length || profile.cwdRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root))) integrationError('INVALID_INTEGRATION_POLICY', 'cwdRoots must be absolute paths');
    if (profile.startupInput !== undefined) {
      const condition = profile.startupInput;
      const validTerms = (terms: unknown): terms is string[] => Array.isArray(terms) && terms.length <= 16
        && terms.every(term => typeof term === 'string' && !!term.trim() && term.length <= 256 && !/[\x00-\x1f\x7f]/.test(term));
      if (!condition || !validTerms(condition.allOf) || !condition.allOf.length || condition.noneOf !== undefined && !validTerms(condition.noneOf)
        || condition.stableMs !== undefined && (!Number.isInteger(condition.stableMs) || condition.stableMs < 500 || condition.stableMs > 5000)
        || condition.timeoutMs !== undefined && (!Number.isInteger(condition.timeoutMs) || condition.timeoutMs < 1000 || condition.timeoutMs > 120000)) {
        integrationError('INVALID_INTEGRATION_POLICY', 'Invalid startupInput literal conditions or timing bounds');
      }
    }
  }
  // Policies contain launcher configuration, never authentication material.
  return structuredClone({ id: value.id, groupId: value.groupId, permissions: value.permissions, launchProfiles: value.launchProfiles });
}
export class IntegrationStore {
  private doc: Journal = { version: 1, principals: [], events: [], sequences: {}, prunedThrough: {}, sources: {}, consumers: {} };
  private listeners = new Set<() => void>();
  constructor(private file: string, private retention = 10000) {
    try {
      const document = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
      if (document.version !== 1 || !Array.isArray(document.events) || !Array.isArray(document.principals) || !document.sources || !document.consumers || !document.sequences || !document.prunedThrough) throw new Error('Invalid integration journal');
      this.doc = document;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private write(next: Journal): void {
    if (Buffer.byteLength(JSON.stringify(next)) > 64 * 1024 * 1024) integrationError('EVENT_STORAGE_FULL', 'Integration journal is full; no event was acknowledged', 503);
    atomicJson(this.file, next); this.doc = next;
    for (const listener of this.listeners) { try { listener(); } catch { /* Subscription reports its own failure. */ } }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  policies(): Omit<IntegrationPrincipal, 'tokenHash'>[] { return this.doc.principals.map(({ tokenHash: _, ...principal }) => structuredClone(principal)); }
  provision(policy: IntegrationPolicy): { principal: IntegrationPolicy; token: string } {
    const checked = validatePolicy(policy);
    if (this.doc.principals.some(p => p.id === checked.id)) integrationError('INTEGRATION_EXISTS', 'Use a new id; credentials cannot be silently replaced', 409);
    const token = randomBytes(32).toString('base64url');
    const next = structuredClone(this.doc); next.principals.push({ ...checked, tokenHash: hash(token), revoked: false }); this.write(next);
    return { principal: checked, token };
  }
  update(policy: IntegrationPolicy): void {
    const checked = validatePolicy(policy), next = structuredClone(this.doc);
    const index = next.principals.findIndex(principal => principal.id === checked.id);
    if (index < 0) integrationError('INTEGRATION_NOT_FOUND', 'Integration does not exist', 404);
    const existing = next.principals[index];
    if (existing.revoked) integrationError('INTEGRATION_REVOKED', 'Revoked identities cannot be reactivated', 403);
    if (existing.groupId !== checked.groupId) integrationError('INTEGRATION_GROUP_IMMUTABLE', 'An existing identity cannot change its group', 409);
    next.principals[index] = { ...checked, tokenHash: existing.tokenHash, revoked: false };
    this.write(next);
  }
  revoke(id: string): void {
    const next = structuredClone(this.doc), principal = next.principals.find(p => p.id === id);
    if (!principal) integrationError('INTEGRATION_NOT_FOUND', 'Integration does not exist', 404);
    principal.revoked = true; this.write(next);
  }
  authenticate(id: string, token: string): IntegrationPrincipal {
    const principal = this.doc.principals.find(p => p.id === id);
    const given = Buffer.from(hash(token)), expected = Buffer.from(principal?.tokenHash ?? hash('invalid'));
    if (!principal || !timingSafeEqual(given, expected)) integrationError('INTEGRATION_UNAUTHORIZED', 'Invalid integration credential', 401);
    if (principal.revoked) integrationError('INTEGRATION_REVOKED', 'Integration authorization was revoked', 403);
    return structuredClone(principal);
  }
  authorize(principal: IntegrationPrincipal, permission: IntegrationPermission, groupId = principal.groupId): void {
    const active = this.doc.principals.find(p => p.id === principal.id);
    if (!active || active.revoked) integrationError('INTEGRATION_REVOKED', 'Integration authorization was revoked', 403);
    if (groupId !== active.groupId || !active.permissions.includes(permission)) integrationError('INTEGRATION_PERMISSION_DENIED', 'Operation is outside the integration grant', 403);
  }
  append(updates: Array<{ sourceKey: string; sourceVersion: string; eventId?: string; event: Omit<IntegrationEvent, 'event_id' | 'sequence' | 'cursor'> }>): void {
    const next = structuredClone(this.doc); let changed = false;
    for (const update of updates) {
      if (next.sources[update.sourceKey] === update.sourceVersion) continue;
      const group = update.event.group_id, sequence = (next.sequences[group] ?? 0) + 1;
      next.events.push({ ...update.event, event_id: update.eventId ?? randomUUID(), sequence, cursor: this.cursor(group, sequence) });
      next.sequences[group] = sequence; next.sources[update.sourceKey] = update.sourceVersion; changed = true;
    }
    if (!changed) return;
    const counts = new Map<string, number>();
    next.events = next.events.reverse().filter(event => {
      const count = (counts.get(event.group_id) ?? 0) + 1; counts.set(event.group_id, count);
      if (count <= this.retention) return true;
      next.prunedThrough[event.group_id] = Math.max(next.prunedThrough[event.group_id] ?? 0, event.sequence); return false;
    }).reverse();
    this.write(next);
  }
  private cursor(group: string, sequence: number): string { return Buffer.from(JSON.stringify({ v: 1, group, sequence })).toString('base64url'); }
  private decode(group: string, cursor: string): number {
    let value: { v?: number; group?: string; sequence?: number };
    try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { return integrationError('INVALID_EVENT_CURSOR', 'Invalid cursor'); }
    if (value.v !== 1 || value.group !== group || !Number.isSafeInteger(value.sequence) || value.sequence! < 0 || value.sequence! > (this.doc.sequences[group] ?? 0)) integrationError('INVALID_EVENT_CURSOR', 'Cursor does not belong to this group');
    return value.sequence!;
  }
  private key(principal: IntegrationPrincipal, consumer: string): string { identifier(consumer, 'consumer'); return `${principal.id}:${principal.groupId}:${consumer}`; }
  page(principal: IntegrationPrincipal, consumer: string, cursor?: string): { events: IntegrationEvent[]; cursor: string } {
    this.authorize(principal, 'events.read');
    const key = this.key(principal, consumer), group = principal.groupId;
    const floor = this.doc.prunedThrough[group] ?? 0;
    // A new consumer explicitly starts at the earliest retained fact. Existing
    // consumers never silently skip a retention gap.
    if (this.doc.consumers[key] === undefined) {
      const next = structuredClone(this.doc); next.consumers[key] = floor; this.write(next);
    }
    const after = cursor ? this.decode(group, cursor) : this.doc.consumers[key];
    if (after < floor) integrationError('EVENT_RETENTION_GAP', 'Confirmed cursor is older than retained history; reconcile task/session snapshots and use a new consumer', 409);
    return { events: structuredClone(this.doc.events.filter(e => e.group_id === group && e.sequence > after).slice(0, 100)), cursor: this.cursor(group, after) };
  }
  ack(principal: IntegrationPrincipal, consumer: string, cursor: string): { cursor: string; ack_semantics: 'durable_received' } {
    this.authorize(principal, 'events.read');
    const key = this.key(principal, consumer), sequence = this.decode(principal.groupId, cursor), confirmed = this.doc.consumers[key];
    if (confirmed === undefined) integrationError('EVENT_CONSUMER_NOT_STARTED', 'Subscribe before acknowledging');
    if (sequence < confirmed) integrationError('EVENT_ACK_REWIND', 'Acknowledgement cannot rewind');
    if (confirmed < (this.doc.prunedThrough[principal.groupId] ?? 0)) integrationError('EVENT_RETENTION_GAP', 'Consumer has a retention gap', 409);
    // Cursor is a cumulative declaration that every preceding event is safely
    // in the bridge inbox. The subscription server separately checks it was sent.
    const next = structuredClone(this.doc); next.consumers[key] = sequence; this.write(next);
    return { cursor, ack_semantics: 'durable_received' };
  }
  cursorSequence(group: string, cursor: string): number { return this.decode(group, cursor); }
}
