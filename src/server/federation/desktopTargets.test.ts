import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { desktopDirectTargets, desktopServiceTargets } from './desktopTargets.js';
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
  function previewFixture() {
    const { root, file: old, data } = fixture();
    rmSync(old);
    mkdirSync(join(root, '.termdock'));
    const stable = join(root, '.termdock', 'desktop.json');
    const saveStable = (value: unknown = data) => writeFileSync(stable, JSON.stringify(value));
    const dir = join(root, 'Library', 'Application Support', 'com.jovines.termdock.preview');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'connections.json');
    const preview = { version: 1, connections: data.connections, removedKeys: [] as string[], certificatePins: { 'https://c.internal:9834': 'ab'.repeat(32) } };
    const save = (value: unknown = preview) => writeFileSync(file, JSON.stringify(value)); save();
    return { root, file, stable, preview, save, saveStable, data };
  }
  it('discovers Preview-only installations without an Electron directory and keeps leaf pins separate from CA approvals', () => {
    const { root, preview, save } = previewFixture();
    expect(desktopServiceTargets(root, 'B', 'darwin')).toEqual([{ serviceId: 'C', url: 'https://c.internal:9834', label: '内网电脑', certificateFingerprint256: 'AB'.repeat(32) }]);
    expect(desktopServiceTargets(root, 'unrelated-service', 'darwin')).toEqual([]);
    save({ ...preview, certificatePins: { 'https://other.internal': 'ab'.repeat(32) } });
    expect(desktopServiceTargets(root, 'B', 'darwin')[0]).not.toHaveProperty('certificateFingerprint256');
    save({ ...preview, certificatePins: { 'https://c.internal:9834': 'invalid-pin' } });
    expect(desktopServiceTargets(root, 'B', 'darwin')).toEqual([]);
  });
  it('retains alternate addresses of one service and never promotes a stale entry origin into a direct address', () => {
    const { root, preview, save } = previewFixture();
    save({ ...preview, connections: [preview.connections[0], { id: 'remote', targetPeerId: 'C', url: 'https://entry.internal', serviceOrigin: 'https://entry.internal', entryServiceId: 'E', routes: [
      { url: 'https://c-home.internal', targetPeerId: 'C' },
      { url: 'https://c-office.internal', targetPeerId: 'C' },
    ] }] });
    expect(desktopServiceTargets(root, 'B', 'darwin').map(target => [target.serviceId, target.url])).toEqual([
      ['C', 'https://c-home.internal'], ['C', 'https://c-office.internal'],
    ]);
  });
  it('honors Preview removal records and never imports auth or an entry-only bookmark', () => {
    const { root, preview, save } = previewFixture();
    for (const key of ['remote', 'C', 'https://c.internal:9834', 'B']) {
      save({ ...preview, removedKeys: [key] });
      expect(desktopServiceTargets(root, 'B', 'darwin')).toEqual([]);
    }
    save({ ...preview, password: 'secret', connections: [preview.connections[0], { id: 'remote', targetPeerId: 'C', entryServiceId: 'E', url: 'https://entry.internal', token: 'secret' }] });
    expect(desktopServiceTargets(root, 'B', 'darwin')).toEqual([]);
  });
  it('reads both installations independently and refreshes Preview address, trust, and removal without writing either file', () => {
    const { root, file, stable, preview, save, saveStable, data } = previewFixture();
    saveStable({ ...data, connections: [data.connections[0], { ...data.connections[1], targetPeerId: 'D' }] });
    expect(desktopServiceTargets(root, 'B', 'darwin').map(target => target.serviceId)).toEqual(['D', 'C']);
    preview.connections[1].url = 'https://new.internal'; save();
    expect(desktopServiceTargets(root, 'B', 'darwin').find(target => target.serviceId === 'C')).toEqual({ serviceId: 'C', url: 'https://new.internal', label: '内网电脑' });
    save({ ...preview, connections: [preview.connections[0]] });
    expect(desktopServiceTargets(root, 'B', 'darwin').map(target => target.serviceId)).toEqual(['D']);
    writeFileSync(file, 'broken');
    expect(desktopServiceTargets(root, 'B', 'darwin').map(target => target.serviceId)).toEqual(['D']);
    rmSync(stable);
    expect(desktopServiceTargets(root, 'B', 'darwin')).toEqual([]);
  });
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
