import { describe, expect, it } from 'vitest';
import { serviceConnection, serviceConnectionKeys, importServiceConnection, upsertServiceConnection, saveServiceConnection, invitationForService } from './serviceConnections.js';
const peer = '12D3KooW' + '1'.repeat(44), entry = '12D3KooW' + '2'.repeat(44);
describe('desktop service metadata', () => {
  it('does not resurrect a removed service when another old window imports its bookmarks', () => {
    const removed = serviceConnection({ url: 'https://c.example', targetPeerId: peer });
    const stale = { id: 'old-web-id', url: removed.url, targetPeerId: peer, label: 'Old bookmark' };
    expect(importServiceConnection([], serviceConnectionKeys(removed), stale)).toEqual([]);
    expect(upsertServiceConnection([], stale)).toHaveLength(1);
  });
  it('clears local removal markers on explicit re-add without reviving unrelated bookmarks', () => {
    const local = serviceConnection({ id: 'local', url: 'https://localhost:9834', targetPeerId: peer });
    const remote = serviceConnection({ id: 'remote', url: 'https://remote.internal', targetPeerId: entry });
    const removed = serviceConnection({ id: 'removed', url: 'https://removed.internal' });
    const tombstones = [...serviceConnectionKeys(local), ...serviceConnectionKeys(removed)];
    // Repair contradictory records produced by the old client, retaining pins.
    const saved = saveServiceConnection([remote, local], tombstones, { id: local.id, url: local.url, label: '本机' });
    expect(saved.removedServiceKeys).toEqual(serviceConnectionKeys(removed));
    expect(saved.connections).toEqual([remote, { ...local, label: '本机' }]);
    expect(importServiceConnection(saved.connections, saved.removedServiceKeys, removed)).toEqual(saved.connections);
    // Re-adding after deletion can allocate a different local bookmark ID.
    const readded = saveServiceConnection([remote], tombstones, { ...local, id: 'new-local-id' });
    expect(readded.connections).toEqual([remote, { ...local, id: 'new-local-id' }]);
    expect(readded.removedServiceKeys).not.toContain(peer);
    expect(readded.removedServiceKeys).not.toContain(local.url);
  });
  it('clears only the restored service aliases when its address changes', () => {
    const previous = serviceConnection({ id: 'old-id', url: 'https://old.internal', targetPeerId: peer });
    const next = { ...previous, id: 'new-id', url: 'https://new.internal' };
    const saved = saveServiceConnection([previous], [...serviceConnectionKeys(previous), ...serviceConnectionKeys(next), 'unrelated'], next);
    expect(saved.removedServiceKeys).toEqual(['unrelated']);
    expect(saved.connections).toEqual([{ ...next, id: previous.id }]);
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
