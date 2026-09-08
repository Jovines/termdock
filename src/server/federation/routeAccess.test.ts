import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RouteAccess } from './routeAccess.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'td-route-')); dirs.push(dir); const file = join(dir, 'routes.json');
  const token = 'secret'.repeat(8); let now = 1000; let authorized = true;
  const config = { relays: [{ id: 'A', token, targets: ['C'] }] }; writeFileSync(file, JSON.stringify(config));
  return { access: new RouteAccess(file, () => now, () => authorized), file, config, token, revokeSubject: () => { authorized = false; }, time: (value: number) => { now = value; } };
}
describe('route authentication', () => {
  it('separates relay advertisement from target access', () => {
    const { access, token } = setup(); const relay = access.authenticate(`Bearer ${token}`)!;
    expect(access.allowRegister(relay, 'C')).toBe(true); expect(access.allowRegister(relay, 'D')).toBe(false);
    expect(access.allowRoute(relay, 'C')).toBe(false);
    const ticket = access.issueRouteTicket('phone', 'C'); const client = access.authenticate(undefined, ticket.routeToken)!;
    expect(access.allowRoute(client, 'C')).toBe(true); expect(access.allowRoute(client, 'D')).toBe(false);
    expect(access.allowRegister(client, 'C')).toBe(false);
  });
  it('consumes tickets once and rejects expiration', () => {
    const { access, time } = setup(); const ticket = access.issueRouteTicket('phone', 'C');
    expect(access.authenticate(undefined, ticket.routeToken)).not.toBeNull();
    expect(access.authenticate(undefined, ticket.routeToken)).toBeNull();
    const expired = access.issueRouteTicket('phone', 'C'); time(expired.expiresAt);
    expect(access.authenticate(undefined, expired.routeToken)).toBeNull();
    expect(() => access.issueRouteTicket('phone', 'D')).toThrow();
  });
  it('revokes pending tickets and established routing when entrance access is withdrawn', () => {
    const { access, revokeSubject } = setup();
    const pending = access.issueRouteTicket('phone', 'C');
    const established = access.authenticate(undefined, access.issueRouteTicket('phone', 'C').routeToken)!;
    expect(access.allowRoute(established, 'C')).toBe(true);
    revokeSubject();
    expect(access.allowRoute(established, 'C')).toBe(false);
    expect(access.authenticate(undefined, pending.routeToken)).toBeNull();
    expect(() => access.issueRouteTicket('phone', 'C')).toThrow();
  });
  it('reloads revocation and fails closed on malformed config', () => {
    const { access, token, config, file } = setup(); const relay = access.authenticate(`Bearer ${token}`)!;
    config.relays[0].token = 'replacement'.repeat(8); writeFileSync(file, JSON.stringify(config));
    expect(access.allowRegister(relay, 'C')).toBe(false); expect(access.authenticate(`Bearer ${token}`)).toBeNull();
    writeFileSync(file, 'broken'); expect(access.allowRegister(relay, 'C')).toBe(false);
    expect(access.authenticate()).toBeNull();
  });
});
