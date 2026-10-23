import { validShareResources, type ShareResources } from '../shared/shareResources.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuthorizationScope, GrantInput } from './authorization.js';

export interface InvitationInput { resources?: ShareResources; scope: AuthorizationScope; actions: string[]; label?: string; expiresAt?: number }
export interface PendingInvitation extends InvitationInput { id: string; createdAt: number; invitationExpiresAt: number }
interface Invitation extends InvitationInput {
  hash: string; issuerId: string; createdAt: number; invitationExpiresAt: number;
  consumedAt?: number; consumedBy?: string;
}
const TTL = 10 * 60 * 1000;
const actions = new Set(['session.view', 'session.input', 'session.resize', 'session.terminate']);
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\s\x00-\x1f]/.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function requireValid(ok: unknown): asserts ok { if (!ok) throw new Error('INVALID_INVITATION'); }
export function validateInvitation(input: unknown): asserts input is InvitationInput {
  requireValid(record(input) && Object.keys(input).every(k => ['scope', 'actions', 'label', 'expiresAt', 'resources'].includes(k)));
  requireValid(record(input.scope) && Array.isArray(input.actions) && input.actions.length > 0 && new Set(input.actions).size === input.actions.length);
  requireValid(input.resources === undefined || validShareResources(input.resources));
  const scope = input.scope;
  if (scope.kind === 'service') {
    requireValid(Object.keys(scope).length === 1 && ((input.actions.length === 1 && input.actions[0] === 'service:*') || input.actions.every(a => typeof a === 'string' && actions.has(a))));
  } else {
    requireValid(scope.kind === 'sessions' && Object.keys(scope).every(k => ['kind', 'sessionIds'].includes(k))
      && Array.isArray(scope.sessionIds) && scope.sessionIds.length > 0 && scope.sessionIds.length <= 256
      && scope.sessionIds.every(identity) && new Set(scope.sessionIds).size === scope.sessionIds.length
      && input.actions.every(a => typeof a === 'string' && actions.has(a)));
  }
  requireValid(input.label === undefined || (typeof input.label === 'string' && input.label.trim().length > 0 && input.label.length <= 80 && !/[\x00-\x1f\x7f]/.test(input.label)));
  requireValid(input.expiresAt === undefined || (Number.isSafeInteger(input.expiresAt) && Number(input.expiresAt) > 0));
}
/** Single owning process, synchronous consume-before-grant: a crash may burn an invite,
 * but can never redeem it twice. Raw invitation codes are never persisted. */
export class InvitationStore {
  private now: () => number;
  constructor(private options: { filePath: string; serviceId: string; now?: () => number }) {
    requireValid(identity(options.serviceId)); this.now = options.now ?? Date.now; this.read();
  }
  private hash(code: string) { return createHash('sha256').update(`termdock-invitation-v1:${this.options.serviceId}:`).update(code).digest('hex'); }
  private read(): Invitation[] {
    let raw: string;
    try { raw = readFileSync(this.options.filePath, 'utf8'); chmodSync(this.options.filePath, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const data: unknown = JSON.parse(raw);
    requireValid(record(data) && data.version === 1 && data.serviceId === this.options.serviceId && Array.isArray(data.invitations) && data.invitations.length <= 2048);
    const seen = new Set<string>();
    for (const item of data.invitations) {
      requireValid(record(item) && Object.keys(item).every(k => ['scope', 'actions', 'label', 'expiresAt', 'hash', 'issuerId', 'createdAt', 'invitationExpiresAt', 'consumedAt', 'consumedBy', 'resources'].includes(k)));
      const { scope, actions, resources, label, expiresAt, hash, issuerId, createdAt, invitationExpiresAt, consumedAt, consumedBy } = item;
      validateInvitation({ scope, actions, ...(resources === undefined ? {} : { resources }), ...(label === undefined ? {} : { label }), ...(expiresAt === undefined ? {} : { expiresAt }) });
      requireValid(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && !seen.has(hash) && identity(issuerId)); seen.add(hash);
      requireValid(Number.isSafeInteger(createdAt) && Number.isSafeInteger(invitationExpiresAt) && Number(invitationExpiresAt) === Number(createdAt) + TTL);
      requireValid((consumedAt === undefined && consumedBy === undefined) || (Number.isSafeInteger(consumedAt) && identity(consumedBy)));
    }
    return data.invitations as unknown as Invitation[];
  }
  private save(invitations: Invitation[]) {
    mkdirSync(dirname(this.options.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.filePath}.${randomUUID()}.tmp`; let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, serviceId: this.options.serviceId, invitations }, null, 2));
      fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, this.options.filePath);
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  }
  listPending(): PendingInvitation[] {
    const now = this.now();
    return this.read().filter(i => i.consumedAt === undefined && i.invitationExpiresAt > now && (i.expiresAt === undefined || i.expiresAt > now))
      .map(({ hash, scope, actions, resources, label, expiresAt, createdAt, invitationExpiresAt }) => ({ id: hash, scope, actions, ...(resources === undefined ? {} : { resources }), ...(label ? { label } : {}), ...(expiresAt === undefined ? {} : { expiresAt }), createdAt, invitationExpiresAt }));
  }
  revoke(id: string): boolean {
    const current = this.read();
    const index = current.findIndex(i => i.hash === id && i.consumedAt === undefined);
    if (index < 0) return false;
    current.splice(index, 1); this.save(current); return true;
  }
  revokeSession(sessionId: string, normalize: (id: string) => string = id => id): number {
    const current = this.read(); let changed = 0;
    const next = current.filter(invitation => {
      if (invitation.consumedAt !== undefined || invitation.scope.kind !== 'sessions') return true;
      const remaining = invitation.scope.sessionIds.filter(id => normalize(id) !== sessionId);
      if (remaining.length === invitation.scope.sessionIds.length) return true;
      changed++; if (!remaining.length) return false;
      invitation.scope = { kind: 'sessions', sessionIds: remaining }; return true;
    });
    if (changed) this.save(next); return changed;
  }
  create(issuerId: string, input: InvitationInput): { invitationId: string; code: string; expiresAt: number } {
    requireValid(identity(issuerId)); validateInvitation(input);
    const now = this.now(); requireValid(input.expiresAt === undefined || input.expiresAt > now);
    const current = this.read().filter(i => i.consumedAt !== undefined || i.invitationExpiresAt > now);
    if (current.filter(i => i.consumedAt === undefined).length >= 256) throw new Error('INVITATION_LIMIT');
    // Keep bounded device-friendly metadata; retain all still-active invitations.
    while (current.length >= 2048) { const index = current.findIndex(i => i.consumedAt !== undefined); if (index < 0) throw new Error('INVITATION_LIMIT'); current.splice(index, 1); }
    const code = randomBytes(32).toString('base64url');
    const invitation: Invitation = { ...structuredClone(input), ...(input.label ? { label: input.label.trim() } : {}), hash: this.hash(code), issuerId, createdAt: now, invitationExpiresAt: now + TTL };
    current.push(invitation); this.save(current); return { invitationId: invitation.hash, code, expiresAt: invitation.invitationExpiresAt };
  }
  consume(code: string, subjectId: string, issuerAllowed: (issuerId: string) => boolean): GrantInput {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !identity(subjectId)) throw new Error('PAIRING_DENIED');
    const current = this.read(), hash = this.hash(code), now = this.now();
    const invite = current.find(i => i.hash === hash);
    if (!invite || invite.consumedAt !== undefined || invite.invitationExpiresAt <= now || (invite.expiresAt !== undefined && invite.expiresAt <= now) || !issuerAllowed(invite.issuerId)) throw new Error('PAIRING_DENIED');
    invite.consumedAt = now; invite.consumedBy = subjectId; this.save(current);
    return { subjectId, ...(invite.resources ? { resources: structuredClone(invite.resources) } : {}), scope: structuredClone(invite.scope), actions: [...invite.actions], ...(invite.expiresAt === undefined ? {} : { expiresAt: invite.expiresAt }), canDelegate: false };
  }
  subjectLabels(): Record<string, string> {
    return Object.fromEntries(this.read().filter(i => i.consumedBy && i.label).map(i => [i.consumedBy!, i.label!]));
  }
}
