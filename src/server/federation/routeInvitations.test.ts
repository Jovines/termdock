import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RouteInvitationStore } from './routeInvitations.js';
import { RouteAccess } from './routeAccess.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'termdock-route-invite-')); directories.push(directory);
  const filePath = join(directory, 'route-invitations.json');
  let now = 1000, issuerAllowed = true, targetAvailable = true;
  const options = { filePath, serviceId: 'B', now: () => now,
    issuerAllowed: (issuer: string) => issuer === 'owner-B' && issuerAllowed,
    targetAvailable: (target: string) => target === 'C' && targetAvailable };
  const store = new RouteInvitationStore(options);
  return { store, filePath, options, directory, now: (value: number) => { now = value; }, revoke: () => { issuerAllowed = false; }, withdraw: () => { targetAvailable = false; } };
}
describe('minimal entry route invitations', () => {
  it('grants and revokes one explicit route without changing the owner or another device', () => {
    const f = fixture();
    const first = f.store.grant('owner-B', 'C', 'phone');
    f.store.grant('owner-B', 'C', 'tablet');
    expect(f.store.allows('phone', 'C')).toBe(true);
    expect(f.store.allows('phone', 'D')).toBe(false);
    expect(f.store.list().filter(item => item.active)).toHaveLength(2);
    expect(f.store.revoke(first.id)).toBe(true);
    expect(f.store.allows('phone', 'C')).toBe(false);
    expect(f.store.allows('tablet', 'C')).toBe(true);
    expect(new RouteInvitationStore(f.options).allows('phone', 'C')).toBe(false);
    expect(f.options.issuerAllowed('owner-B')).toBe(true);
  });
  it('stores only hashed codes, consumes once, and persists a device-bound target-only grant', () => {
    const f = fixture(), invitation = f.store.create('owner-B', 'C');
    expect(invitation.routeCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation.expiresAt).toBe(601000);
    expect(readFileSync(f.filePath, 'utf8')).not.toContain(invitation.routeCode);
    expect(statSync(f.filePath).mode & 0o777).toBe(0o600);
    expect(f.store.consume(invitation.routeCode, 'phone')).toEqual({ serviceId: 'C' });
    const restarted = new RouteInvitationStore(f.options);
    expect(restarted.allows('phone', 'C')).toBe(true);
    expect(restarted.allows('phone', 'B')).toBe(false);
    expect(restarted.allows('other-phone', 'C')).toBe(false);
    expect(() => restarted.consume(invitation.routeCode, 'other-phone')).toThrow('ROUTE_PAIRING_DENIED');
    f.now(invitation.expiresAt + 1);
    expect(restarted.allows('phone', 'C')).toBe(true); // Only the invitation expires, not the redeemed device grant.
  });
  it('requires actual issuer service authority and a currently registered target', () => {
    const f = fixture();
    expect(() => f.store.create('unknown', 'C')).toThrow('ROUTE_INVITATION_DENIED');
    expect(() => f.store.create('owner-B', 'D')).toThrow('ROUTE_INVITATION_DENIED');
    const invitation = f.store.create('owner-B', 'C'); f.store.consume(invitation.routeCode, 'phone');
    expect(() => f.store.create('phone', 'C')).toThrow('ROUTE_INVITATION_DENIED');
    f.withdraw(); expect(f.store.allows('phone', 'C')).toBe(false);
    expect(() => f.store.create('owner-B', 'C')).toThrow('ROUTE_INVITATION_DENIED');
  });
  it('rejects expired codes and revokes redeemed and outstanding descendants with the issuer', () => {
    const f = fixture(), expired = f.store.create('owner-B', 'C'); f.now(expired.expiresAt);
    expect(() => f.store.consume(expired.routeCode, 'phone')).toThrow('ROUTE_PAIRING_DENIED');
    const pending = f.store.create('owner-B', 'C'), consumed = f.store.create('owner-B', 'C');
    f.store.consume(consumed.routeCode, 'phone'); f.revoke();
    expect(f.store.allows('phone', 'C')).toBe(false);
    expect(() => f.store.consume(pending.routeCode, 'new-phone')).toThrow('ROUTE_PAIRING_DENIED');
  });
  it('binds records to the entry identity and fails closed on corrupt or overprivileged records', () => {
    const f = fixture(), invitation = f.store.create('owner-B', 'C'); f.store.consume(invitation.routeCode, 'phone');
    expect(() => new RouteInvitationStore({ ...f.options, serviceId: 'OTHER' })).toThrow();
    const data = JSON.parse(readFileSync(f.filePath, 'utf8')); data.invitations[0].actions = ['service:*'];
    writeFileSync(f.filePath, JSON.stringify(data)); expect(f.store.allows('phone', 'C')).toBe(false);
    expect(() => f.store.consume('x'.repeat(43), 'phone')).toThrow();
  });
  it('authorizes route-only tickets for one target and revokes pending and active tickets with the issuer', () => {
    const f = fixture();
    const routes = join(f.directory, 'routes.json');
    writeFileSync(routes, JSON.stringify({ relays: [{ id: 'A', token: 'secret'.repeat(8), targets: ['C', 'D'] }] }));
    const access = new RouteAccess(routes, f.options.now, (subject, target) => f.options.issuerAllowed(subject) || f.store.allows(subject, target));
    const invitation = f.store.create('owner-B', 'C'); f.store.consume(invitation.routeCode, 'phone');
    const live = access.authenticate(undefined, access.issueRouteTicket('phone', 'C').routeToken)!;
    const pending = access.issueRouteTicket('phone', 'C');
    expect(access.allowRoute(live, 'C')).toBe(true);
    expect(() => access.issueRouteTicket('phone', 'D')).toThrow('ROUTE_UNAVAILABLE');
    expect(access.allowRegister(live, 'C')).toBe(false);
    f.revoke();
    expect(access.allowRoute(live, 'C')).toBe(false);
    expect(access.authenticate(undefined, pending.routeToken)).toBeNull();
    expect(() => access.issueRouteTicket('phone', 'C')).toThrow('ROUTE_UNAVAILABLE');
  });
});
