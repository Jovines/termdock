import { describe, expect, it } from 'vitest';
import { serviceConnection, serviceConnectionKeys, importServiceConnection, upsertServiceConnection, invitationForService } from './serviceConnections.js';
const peer = '12D3KooW' + '1'.repeat(44), entry = '12D3KooW' + '2'.repeat(44);
describe('desktop service metadata', () => {
  it('does not resurrect a removed service when another old window imports its bookmarks', () => {
    const removed = serviceConnection({ url: 'https://c.example', targetPeerId: peer });
    const stale = { id: 'old-web-id', url: removed.url, targetPeerId: peer, label: 'Old bookmark' };
    expect(importServiceConnection([], serviceConnectionKeys(removed), stale)).toEqual([]);
    expect(upsertServiceConnection([], stale)).toHaveLength(1);
  });
  it('preserves explicit routes and pins while excluding every credential', () => {
    const result = serviceConnection({ url: 'https://c.example', targetPeerId: peer, routes: [{ url: 'https://b.example', targetPeerId: entry, routeToken: 'secret' }], password: 'secret', pairingCode: 'secret' });
    expect(result.routes).toEqual([{ url: 'https://b.example', targetPeerId: entry }]);
    expect(JSON.stringify(result)).not.toContain('secret');
    const renamed = upsertServiceConnection([result], { id: result.id, url: result.url, label: 'Office' });
    expect(renamed).toHaveLength(1); expect(renamed[0]).toMatchObject({ targetPeerId: peer, routes: result.routes, label: 'Office' });
  });
  it('keeps explicit removal of every backup and rejects credential-bearing addresses', () => {
    const current = serviceConnection({ url: 'https://c.example', routes: [{ url: 'https://b.example', targetPeerId: entry }] });
    expect(upsertServiceConnection([current], { ...current, routes: [] })[0].routes).toEqual([]);
    expect(() => serviceConnection({ url: 'https://user:password@c.example' })).toThrow();
    expect(() => serviceConnection({ url: 'https://c.example/#secret' })).toThrow();
  });
  it('accepts a route-only invitation only for its exact pinned entry and target', () => {
    const connection = serviceConnection({ url: 'https://b.example', targetPeerId: peer, entryServiceId: entry });
    const descriptor = { v: 1, routeOnly: true, serviceId: peer, entryServiceId: entry, entryUrl: connection.url, routeCode: 'x'.repeat(43) };
    const url = connection.url + '/#termdock-invite=' + Buffer.from(JSON.stringify(descriptor)).toString('base64url');
    expect(invitationForService(url, connection)).toBe(url);
    expect(() => invitationForService(url, { ...connection, targetPeerId: entry })).toThrow();
  });
});
