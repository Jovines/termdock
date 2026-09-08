import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DirectTargetConfig } from './directRoutes.js';
export type RoutePrincipal = { kind: 'relay'; id: string; tokenHash: string } | { kind: 'client'; subjectId: string; serviceId: string };
interface RelayRecord { id: string; token: string; targets: string[] }
const validId = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(x);
const digest = (s: string) => createHash('sha256').update(s).digest();
/** Target directory is re-read on every permission check; invalid config denies all. */
export class RouteAccess {
  private tickets = new Map<string, { subjectId: string; serviceId: string; expiresAt: number }>();
  constructor(private filePath: string, private now: () => number = Date.now, private canRouteSubject: (subjectId: string, serviceId: string) => boolean = () => false) {}
  private registry(): { relays: RelayRecord[]; directTargets: DirectTargetConfig[] } {
    const empty = { relays: [], directTargets: [] };
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['relays', 'directTargets'].includes(k))
        || (data.relays !== undefined && !Array.isArray(data.relays)) || (data.directTargets !== undefined && !Array.isArray(data.directTargets))) return empty;
      const relays = data.relays ?? [], directTargets = data.directTargets ?? [];
      if (relays.length > 64 || directTargets.length > 64) return empty;
      const ids = new Set<string>();
      for (const r of relays) {
        if (!r || Object.keys(r).some(k => !['id', 'token', 'targets'].includes(k)) || !validId(r.id) || ids.has(r.id) || typeof r.token !== 'string' || r.token.length < 32 || /[\r\n]/.test(r.token) || !Array.isArray(r.targets) || r.targets.length > 64 || !r.targets.every(validId)) return empty;
        ids.add(r.id);
      }
      const targetIds = new Set<string>();
      for (const target of directTargets) {
        if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['serviceId', 'url', 'caPath'].includes(key))
          || !validId(target.serviceId) || targetIds.has(target.serviceId) || typeof target.url !== 'string' || (target.caPath !== undefined && typeof target.caPath !== 'string')) return empty;
        const url = new URL(target.url);
        if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/', '/api/federation/secure'].includes(url.pathname)) return empty;
        targetIds.add(target.serviceId);
      }
      return { relays, directTargets };
    } catch { return empty; }
  }
  private relays(): RelayRecord[] { return this.registry().relays; }
  issueRouteTicket(subjectId: string, serviceId: string): { routeToken: string; expiresAt: number } {
    if (!validId(subjectId) || !validId(serviceId) || !this.canRouteSubject(subjectId, serviceId) || !this.hasConfiguredTarget(serviceId)) throw new Error('ROUTE_UNAVAILABLE');
    for (const [key, value] of this.tickets) if (value.expiresAt <= this.now()) this.tickets.delete(key);
    if (this.tickets.size >= 1024) throw new Error('ROUTE_TICKET_LIMIT');
    const routeToken = randomBytes(32).toString('base64url'); const expiresAt = this.now() + 30_000;
    this.tickets.set(digest(routeToken).toString('hex'), { subjectId, serviceId, expiresAt });
    return { routeToken, expiresAt };
  }
  /** Called once before upgrading. A route ticket is consumed even if expired. */
  authenticate(authorization?: string, routeToken?: string | null): RoutePrincipal | null {
    if (authorization && routeToken) return null;
    if (authorization) {
      if (!authorization.startsWith('Bearer ') || authorization.length > 4096) return null;
      const tokenHash = digest(authorization.slice(7));
      const relay = this.relays().find(r => timingSafeEqual(digest(r.token), tokenHash));
      return relay ? { kind: 'relay', id: relay.id, tokenHash: tokenHash.toString('hex') } : null;
    }
    if (!routeToken || routeToken.length > 512) return null;
    const key = digest(routeToken).toString('hex'); const ticket = this.tickets.get(key); this.tickets.delete(key);
    if (!ticket || ticket.expiresAt <= this.now() || !this.canRouteSubject(ticket.subjectId, ticket.serviceId) || !this.hasConfiguredTarget(ticket.serviceId)) return null;
    return { kind: 'client', subjectId: ticket.subjectId, serviceId: ticket.serviceId };
  }
  allowRegister(principal: RoutePrincipal, serviceId: string): boolean {
    return principal.kind === 'relay' && this.relays().some(r => r.id === principal.id && digest(r.token).toString('hex') === principal.tokenHash && r.targets.includes(serviceId));
  }
  allowRoute(principal: RoutePrincipal, serviceId: string): boolean {
    return principal.kind === 'client' && principal.serviceId === serviceId && this.canRouteSubject(principal.subjectId, serviceId) && this.hasConfiguredTarget(serviceId);
  }
  hasConfiguredTarget(serviceId: string): boolean {
    if (!validId(serviceId)) return false;
    const registry = this.registry();
    return registry.relays.some(relay => relay.targets.includes(serviceId)) || registry.directTargets.some(target => target.serviceId === serviceId);
  }
  addDirectTarget(target: DirectTargetConfig): void {
    const url = new URL(target.url);
    if (!validId(target.serviceId) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('INVALID_DIRECT_TARGET');
    let data: { relays?: RelayRecord[]; directTargets?: DirectTargetConfig[] };
    try { data = JSON.parse(readFileSync(this.filePath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; data = {}; }
    const registry = this.registry();
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['relays', 'directTargets'].includes(key))
      || (data.relays !== undefined && (!Array.isArray(data.relays) || data.relays.length !== registry.relays.length))
      || (data.directTargets !== undefined && (!Array.isArray(data.directTargets) || data.directTargets.length !== registry.directTargets.length))) throw new Error('INVALID_ROUTE_REGISTRY');
    if (this.hasConfiguredTarget(target.serviceId)) return;
    if (registry.directTargets.length >= 64) throw new Error('ROUTE_TARGET_LIMIT');
    data.directTargets = [...registry.directTargets, { serviceId: target.serviceId, url: url.origin }];
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(temporary, this.filePath);
  }
  configuredDirectTargets(): DirectTargetConfig[] { return this.registry().directTargets; }
}
