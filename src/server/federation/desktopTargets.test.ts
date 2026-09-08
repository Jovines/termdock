import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { desktopDirectTargets } from './desktopTargets.js';
import { RouteAccess } from './routeAccess.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'td-desktop-routes-')); roots.push(root);
  const file = join(root, 'desktop.json');
  const fingerprint256 = Array(32).fill('AB').join(':');
  const data = { version: 1, connections: [{ id: 'local', targetPeerId: 'B', url: 'https://localhost:9834', label: 'Local npm' }, { id: 'remote', targetPeerId: 'C', url: 'https://c.internal:9834', label: '内网电脑' }], trustedCertificateAuthorities: [{ origin: 'https://c.internal:9834', fingerprint256, subject: 'Trusted', trustedAt: 1 }] };
  const save = (value: unknown = data) => writeFileSync(file, JSON.stringify(value)); save();
  return { root, file, data, save, fingerprint256 };
}
describe('local Desktop relay directory', () => {
  it('discovers only other pinned services when the local service itself belongs to this Desktop directory', () => {
    const { file, data, save, fingerprint256 } = fixture();
    expect(desktopDirectTargets(file, 'B')).toEqual([{ serviceId: 'C', url: 'https://c.internal:9834', label: '内网电脑', caFingerprint256: fingerprint256 }]);
    expect(desktopDirectTargets(file, 'unknown-local-service')).toEqual([]);
    save({ ...data, connections: data.connections.map(({ targetPeerId: _pin, ...connection }) => connection) });
    expect(desktopDirectTargets(file, 'B')).toEqual([]);
  });
  it('keeps local credentials and arbitrary paths out of targets, and binds CA approval to the exact origin', () => {
    const { file, data, save } = fixture();
    save({ ...data, connections: [...data.connections, { id: 'evil', targetPeerId: 'D', url: 'https://user:secret@private.internal', label: 'invalid' }].map(item => ({ ...item, caPath: '/private/credential', password: 'secret' })), trustedCertificateAuthorities: [{ ...data.trustedCertificateAuthorities[0], origin: 'https://c.internal:9999' }] });
    expect(desktopDirectTargets(file, 'B')).toEqual([{ serviceId: 'C', url: 'https://c.internal:9834', label: '内网电脑' }]);
  });
  it('withdraws discovery and pending tickets when a target is removed without overwriting explicit routes', () => {
    const { file, root, data, save } = fixture();
    const routes = join(root, 'routes.json'); writeFileSync(routes, JSON.stringify({ directTargets: [{ serviceId: 'D', url: 'https://d.internal' }] }));
    const access = new RouteAccess(routes, Date.now, () => true, () => desktopDirectTargets(file, 'B'));
    const ticket = access.issueRouteTicket('phone', 'C');
    save({ ...data, connections: data.connections.slice(0, 1) });
    expect(access.hasConfiguredTarget('C')).toBe(false);
    expect(access.hasConfiguredTarget('D')).toBe(true);
    expect(access.authenticate(undefined, ticket.routeToken)).toBeNull();
    expect(access.allowRoute({ kind: 'client', subjectId: 'phone', serviceId: 'C' }, 'C')).toBe(false);
    save(); expect(access.hasConfiguredTarget('C')).toBe(true);
    save({ ...data, removedServiceKeys: ['C'] }); expect(access.hasConfiguredTarget('C')).toBe(false);
  });
  it('does not mistake a relay-only bookmark for the direct target address', () => {
    const { file, data, save } = fixture();
    save({ ...data, connections: [data.connections[0], { id: 'remote', targetPeerId: 'C', entryServiceId: 'E', url: 'https://entry.internal' }] });
    expect(desktopDirectTargets(file, 'B')).toEqual([]);
  });
  it('reflects address and name changes and fails closed on malformed Desktop data', () => {
    const { file, data, save } = fixture();
    data.connections[1].url = 'https://office.internal'; data.connections[1].label = '办公室'; save();
    expect(desktopDirectTargets(file, 'B')).toEqual([{ serviceId: 'C', url: 'https://office.internal', label: '办公室' }]);
    writeFileSync(file, 'broken'); expect(desktopDirectTargets(file, 'B')).toEqual([]);
  });
});
