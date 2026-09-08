import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const INVITATION_TTL_MS = 10 * 60 * 1000;
const MAX_RECORDS = 2048;
const MAX_PENDING = 256;
const validIdentity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
interface RouteInvitation {
  hash: string;
  issuerId: string;
  targetServiceId: string;
  createdAt: number;
  expiresAt: number;
  subjectId?: string;
  consumedAt?: number;
  revokedAt?: number;
}
export interface RouteInvitationOptions {
  filePath: string;
  /** Entry B's cryptographic identity, binding the store and code hashes to this service. */
  serviceId: string;
  /** Must test real authorization.manage authority, never an inherited route-only grant. */
  issuerAllowed(issuerId: string): boolean;
  /** Target must be in the configured registry and currently advertised by an authorized route. */
  targetAvailable(targetServiceId: string): boolean;
  now?: () => number;
}
function valid(value: unknown): asserts value { if (!value) throw new Error('INVALID_ROUTE_INVITATION_STORE'); }
/** Grants only permission to traverse the entry to one fixed target. No terminal,
 * file, service-management or further invitation authority is conferred.
 * One process owns this file. Atomic synchronous consume binds a single device
 * before returning success, so a restart cannot redeem the invitation again. */
export class RouteInvitationStore {
  private readonly now: () => number;
  constructor(private readonly options: RouteInvitationOptions) {
    valid(validIdentity(options.serviceId)); this.now = options.now ?? Date.now;
    this.read();
    try { chmodSync(options.filePath, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private hash(code: string): string {
    return createHash('sha256').update(`termdock-route-invitation-v1:${this.options.serviceId}:`).update(code).digest('hex');
  }
  private available(issuerId: string, targetServiceId: string): boolean {
    try { return this.options.issuerAllowed(issuerId) && this.options.targetAvailable(targetServiceId); } catch { return false; }
  }
  private read(): RouteInvitation[] {
    let raw: string;
    try { raw = readFileSync(this.options.filePath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const data: unknown = JSON.parse(raw);
    valid(object(data) && Object.keys(data).every(key => ['version', 'serviceId', 'invitations'].includes(key))
      && data.version === 1 && data.serviceId === this.options.serviceId && Array.isArray(data.invitations) && data.invitations.length <= MAX_RECORDS);
    const hashes = new Set<string>();
    for (const item of data.invitations) {
      valid(object(item) && Object.keys(item).every(key => ['hash', 'issuerId', 'targetServiceId', 'createdAt', 'expiresAt', 'subjectId', 'consumedAt', 'revokedAt'].includes(key)));
      valid(typeof item.hash === 'string' && /^[a-f0-9]{64}$/.test(item.hash) && !hashes.has(item.hash)); hashes.add(item.hash);
      valid(validIdentity(item.issuerId) && validIdentity(item.targetServiceId) && timestamp(item.createdAt) && timestamp(item.expiresAt)
        && item.expiresAt === item.createdAt + INVITATION_TTL_MS);
      valid(item.revokedAt === undefined || timestamp(item.revokedAt));
      valid((item.subjectId === undefined && item.consumedAt === undefined)
        || (validIdentity(item.subjectId) && timestamp(item.consumedAt) && item.consumedAt >= item.createdAt && item.consumedAt < item.expiresAt));
    }
    return data.invitations as unknown as RouteInvitation[];
  }
  private save(invitations: RouteInvitation[]): void {
    mkdirSync(dirname(this.options.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.filePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, serviceId: this.options.serviceId, invitations }, null, 2));
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.options.filePath);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  create(issuerId: string, targetServiceId: string): { routeCode: string; expiresAt: number } {
    if (!validIdentity(issuerId) || !validIdentity(targetServiceId) || !this.available(issuerId, targetServiceId)) throw new Error('ROUTE_INVITATION_DENIED');
    const now = this.now();
    const current = this.read().filter(item => item.subjectId !== undefined || item.expiresAt > now);
    if (current.length >= MAX_RECORDS || current.filter(item => item.subjectId === undefined).length >= MAX_PENDING) throw new Error('ROUTE_INVITATION_LIMIT');
    const routeCode = randomBytes(32).toString('base64url');
    const expiresAt = now + INVITATION_TTL_MS;
    current.push({ hash: this.hash(routeCode), issuerId, targetServiceId, createdAt: now, expiresAt });
    this.save(current);
    return { routeCode, expiresAt };
  }
  consume(routeCode: string, actualSubjectId: string): { serviceId: string } {
    if (typeof routeCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(routeCode) || !validIdentity(actualSubjectId)) throw new Error('ROUTE_PAIRING_DENIED');
    const hash = this.hash(routeCode), current = this.read(), now = this.now();
    const invitation = current.find(item => item.hash === hash);
    if (invitation?.subjectId === actualSubjectId && invitation.revokedAt === undefined && this.available(invitation.issuerId, invitation.targetServiceId)) return { serviceId: invitation.targetServiceId };
    if (!invitation || invitation.revokedAt !== undefined || invitation.subjectId !== undefined || invitation.createdAt > now || invitation.expiresAt <= now
      || !this.available(invitation.issuerId, invitation.targetServiceId)) throw new Error('ROUTE_PAIRING_DENIED');
    invitation.subjectId = actualSubjectId; invitation.consumedAt = now;
    this.save(current);
    return { serviceId: invitation.targetServiceId };
  }
  list() {
    return this.read().filter(item => item.subjectId !== undefined).map(item => ({
      id: item.hash, subjectId: item.subjectId!, targetServiceId: item.targetServiceId,
      issuerId: item.issuerId, createdAt: item.consumedAt!,
      ...(item.revokedAt !== undefined ? { revokedAt: item.revokedAt } : {}),
      active: item.revokedAt === undefined && this.available(item.issuerId, item.targetServiceId),
    }));
  }
  grant(issuerId: string, targetServiceId: string, subjectId: string) {
    if (!validIdentity(subjectId) || !this.available(issuerId, targetServiceId)) throw new Error('ROUTE_GRANT_DENIED');
    const existing = this.list().find(item => item.subjectId === subjectId && item.targetServiceId === targetServiceId && item.active);
    if (existing) return existing;
    const invitation = this.create(issuerId, targetServiceId);
    this.consume(invitation.routeCode, subjectId);
    return this.list().find(item => item.subjectId === subjectId && item.targetServiceId === targetServiceId && item.active)!;
  }
  revoke(id: string): boolean {
    const current = this.read(), entry = current.find(item => item.hash === id);
    if (!entry || entry.revokedAt !== undefined) return false;
    entry.revokedAt = this.now(); this.save(current); return true;
  }
  /** Re-evaluated for tickets and every active routed frame. Revoking the issuer's
   * entry authority or withdrawing the target disables all descendant access. */
  allows(subjectId: string, targetServiceId: string): boolean {
    if (!validIdentity(subjectId) || !validIdentity(targetServiceId)) return false;
    try {
      return this.read().some(item => item.subjectId === subjectId && item.targetServiceId === targetServiceId
        && item.revokedAt === undefined && item.consumedAt !== undefined && item.consumedAt <= this.now() && this.available(item.issuerId, targetServiceId));
    } catch { return false; }
  }
}
