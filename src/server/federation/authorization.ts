import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export type AuthorizationScope = { kind: 'service' } | { kind: 'sessions'; sessionIds: string[] };
export interface GrantConditions { entryServiceIds?: string[]; relayIds?: string[] }
export interface GrantInput {
  subjectId: string;
  scope: AuthorizationScope;
  actions: string[];
  expiresAt?: number;
  canDelegate?: boolean;
  conditions?: GrantConditions;
}
export interface AuthorizationGrant extends GrantInput {
  id: string;
  serviceId: string;
  createdAt: number;
  parentGrantId?: string;
  revokedAt?: number;
  passwordCredential?: string;
}
export interface AuthorizationRequest {
  subjectId: string;
  serviceId: string;
  action: string;
  sessionId?: string;
  entryServiceId?: string;
  relayId?: string;
}
export interface AuthorizationDecision { allowed: boolean; grantIds: string[] }
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\s\x00-\x1f]/.test(v);
const action = (v: unknown): v is string => typeof v === 'string' && (v === 'service:*' || /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/.test(v));
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Invalid authorization: ${message}`); }
function keys(v: Record<string, unknown>, allowed: string[]) { assert(Object.keys(v).every(k => allowed.includes(k)), 'unknown field'); }
function ids(v: unknown): v is string[] { return Array.isArray(v) && v.length > 0 && v.length <= 10000 && v.every(id) && new Set(v).size === v.length; }
function validateInput(v: unknown): asserts v is GrantInput {
  assert(object(v), 'grant object');
  assert(id(v.subjectId), 'subject identity');
  assert(object(v.scope), 'scope');
  if (v.scope.kind === 'service') keys(v.scope, ['kind']);
  else { assert(v.scope.kind === 'sessions' && ids(v.scope.sessionIds), 'session scope'); keys(v.scope, ['kind', 'sessionIds']); }
  assert(Array.isArray(v.actions) && v.actions.length > 0 && v.actions.length <= 256 && v.actions.every(action) && new Set(v.actions).size === v.actions.length, 'actions');
  if (v.scope.kind === 'sessions') assert(v.actions.every(a => a.startsWith('session.')), 'session scope cannot grant service or file capabilities');
  assert(v.expiresAt === undefined || (Number.isSafeInteger(v.expiresAt) && Number(v.expiresAt) > 0), 'expiry');
  assert(v.canDelegate === undefined || typeof v.canDelegate === 'boolean', 'delegation flag');
  if (v.conditions !== undefined) {
    assert(object(v.conditions), 'conditions'); keys(v.conditions, ['entryServiceIds', 'relayIds']);
    for (const list of Object.values(v.conditions)) assert(ids(list), 'condition identities');
  }
}
function isSubset(child: AuthorizationGrant, parent: AuthorizationGrant): boolean {
  if (child.serviceId !== parent.serviceId || !parent.canDelegate) return false;
  if (parent.expiresAt !== undefined && (child.expiresAt === undefined || child.expiresAt > parent.expiresAt)) return false;
  if (parent.scope.kind === 'sessions' && (child.scope.kind !== 'sessions' || !child.scope.sessionIds.every(s => parent.scope.kind === 'sessions' && parent.scope.sessionIds.includes(s)))) return false;
  if (!parent.actions.includes('service:*') && !child.actions.every(a => parent.actions.includes(a))) return false;
  for (const key of ['entryServiceIds', 'relayIds'] as const) {
    const limit = parent.conditions?.[key];
    if (limit && (!child.conditions?.[key] || !child.conditions[key]!.every(x => limit.includes(x)))) return false;
  }
  return true;
}
function active(g: AuthorizationGrant, grants: AuthorizationGrant[], now: number, seen = new Set<string>(), passwordCredential?: string | null): boolean {
  if (seen.has(g.id) || g.createdAt > now || g.revokedAt !== undefined || (g.expiresAt !== undefined && g.expiresAt <= now)) return false;
  if (g.passwordCredential && g.passwordCredential !== passwordCredential) return false;
  seen.add(g.id);
  if (!g.parentGrantId) return true;
  const parent = grants.find(p => p.id === g.parentGrantId);
  return !!parent && isSubset(g, parent) && active(parent, grants, now, seen, passwordCredential);
}

/** Target-service authority. Root mutations must only be exposed to authenticated administrators.
 * Every operation reloads disk; synchronous atomic writes support one owning server process.
 * Do not share this file between concurrently writing processes. */
export class AuthorizationStore {
  private readonly now: () => number;
  constructor(private readonly options: { filePath: string; serviceId: string; now?: () => number; passwordCredential?: () => string | null }) {
    assert(id(options.serviceId), 'service identity'); this.now = options.now ?? Date.now;
    this.read();
  }
  private read(): AuthorizationGrant[] {
    let raw: string;
    try { raw = readFileSync(this.options.filePath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const data: unknown = JSON.parse(raw);
    assert(object(data) && data.version === 1 && data.serviceId === this.options.serviceId && Array.isArray(data.grants), 'store header');
    keys(data, ['version', 'serviceId', 'grants']);
    const grants: AuthorizationGrant[] = [];
    for (const value of data.grants) {
      validateInput(value); const g = value as AuthorizationGrant;
      keys(g as unknown as Record<string, unknown>, ['id', 'serviceId', 'createdAt', 'parentGrantId', 'revokedAt', 'subjectId', 'scope', 'actions', 'expiresAt', 'canDelegate', 'conditions', 'passwordCredential']);
      assert(id(g.id) && g.serviceId === this.options.serviceId && Number.isSafeInteger(g.createdAt) && g.createdAt >= 0, 'grant metadata');
      assert(g.parentGrantId === undefined || id(g.parentGrantId), 'parent identity');
      assert(g.revokedAt === undefined || (Number.isSafeInteger(g.revokedAt) && g.revokedAt >= 0), 'revocation');
      assert(g.passwordCredential === undefined || /^[a-f0-9]{64}$/.test(g.passwordCredential), 'password credential');
      assert(!grants.some(p => p.id === g.id), 'duplicate grant'); grants.push(g);
    }
    return grants;
  }
  private save(grants: AuthorizationGrant[]) {
    mkdirSync(dirname(this.options.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.options.filePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, serviceId: this.options.serviceId, grants }, null, 2));
      fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.options.filePath);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private create(input: GrantInput): AuthorizationGrant {
    validateInput(input);
    keys(input as unknown as Record<string, unknown>, ['subjectId', 'scope', 'actions', 'expiresAt', 'canDelegate', 'conditions']);
    const now = this.now(); assert(input.expiresAt === undefined || input.expiresAt > now, 'already expired');
    return { ...structuredClone(input), id: randomUUID(), serviceId: this.options.serviceId, createdAt: now };
  }
  /** Trusted target administrator only; never authorize this from a relay's identity. */
  grant(input: GrantInput): AuthorizationGrant {
    const grants = this.read(); const grant = this.create(input); grants.push(grant); this.save(grants); return structuredClone(grant);
  }
  /** Only call after a successful mutually authenticated password proof. */
  grantPassword(subjectId: string): AuthorizationGrant {
    const passwordCredential = this.options.passwordCredential?.();
    assert(passwordCredential && /^[a-f0-9]{64}$/.test(passwordCredential), 'password unavailable');
    const grants = this.read();
    for (const grant of grants) if (grant.subjectId === subjectId && grant.passwordCredential) grant.revokedAt = this.now();
    const grant = { ...this.create({ subjectId, scope: { kind: 'service' }, actions: ['service:*'], canDelegate: true, expiresAt: this.now() + 30 * 24 * 60 * 60 * 1000 }), passwordCredential };
    grants.push(grant); this.save(grants); return structuredClone(grant);
  }
  delegate(parentGrantId: string, authenticatedSubjectId: string, input: GrantInput): AuthorizationGrant {
    const grants = this.read(); const parent = grants.find(g => g.id === parentGrantId);
    assert(parent && parent.subjectId === authenticatedSubjectId && active(parent, grants, this.now(), new Set(), this.options.passwordCredential?.()), 'inactive or unowned parent');
    const child = { ...this.create(input), parentGrantId };
    assert(isSubset(child, parent), 'delegation exceeds parent'); grants.push(child); this.save(grants); return structuredClone(child);
  }
  /** Trusted target administrator only. Descendants become ineffective immediately on next check. */
  revoke(grantId: string): boolean {
    const grants = this.read(); const grant = grants.find(g => g.id === grantId);
    if (!grant || grant.revokedAt !== undefined) return false;
    grant.revokedAt = this.now(); this.save(grants); return true;
  }
  list(): AuthorizationGrant[] { return this.read(); }
  listEffective(request: Omit<AuthorizationRequest, 'action' | 'sessionId'>): AuthorizationGrant[] {
    if (!request || !id(request.subjectId) || request.serviceId !== this.options.serviceId) return [];
    let grants: AuthorizationGrant[];
    try { grants = this.read(); } catch { return []; }
    const now = this.now();
    return grants.filter(g => g.subjectId === request.subjectId && active(g, grants, now, new Set(), this.options.passwordCredential?.())
      && (!g.conditions?.entryServiceIds || (!!request.entryServiceId && g.conditions.entryServiceIds.includes(request.entryServiceId)))
      && (!g.conditions?.relayIds || (!!request.relayId && g.conditions.relayIds.includes(request.relayId))));
  }
  /** Tests the actual wildcard, not an invented action that custom grants could allow. */
  hasFullServiceAccess(request: Omit<AuthorizationRequest, 'action' | 'sessionId'>): boolean {
    return this.listEffective(request).some(g => g.scope.kind === 'service' && g.actions.includes('service:*'));
  }
  authorize(request: AuthorizationRequest): AuthorizationDecision {
    const deny = { allowed: false, grantIds: [] };
    if (!request || !id(request.subjectId) || request.serviceId !== this.options.serviceId || !action(request.action) || request.action === 'service:*') return deny;
    if (request.action.startsWith('session.') && !id(request.sessionId)) return deny;
    if (request.sessionId !== undefined && !id(request.sessionId)) return deny;
    if (request.entryServiceId !== undefined && !id(request.entryServiceId)) return deny;
    if (request.relayId !== undefined && !id(request.relayId)) return deny;
    let grants: AuthorizationGrant[];
    try { grants = this.read(); } catch { return deny; }
    const now = this.now();
    const grantIds = grants.filter(g => {
      if (g.subjectId !== request.subjectId || !active(g, grants, now, new Set(), this.options.passwordCredential?.())) return false;
      if (!g.actions.includes('service:*') && !g.actions.includes(request.action)) return false;
      if (g.scope.kind === 'sessions' && (!request.action.startsWith('session.') || !request.sessionId || !g.scope.sessionIds.includes(request.sessionId))) return false;
      if (g.conditions?.entryServiceIds && (!request.entryServiceId || !g.conditions.entryServiceIds.includes(request.entryServiceId))) return false;
      if (g.conditions?.relayIds && (!request.relayId || !g.conditions.relayIds.includes(request.relayId))) return false;
      return true;
    }).map(g => g.id);
    return { allowed: grantIds.length > 0, grantIds };
  }
}
