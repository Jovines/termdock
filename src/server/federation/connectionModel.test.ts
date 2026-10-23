import { describe, expect, it } from 'vitest';
import { canonicalConnectionRouting, directConnectionAddresses, relayConnectionRoutes, normalizeServiceAddress, serviceEndpoint } from './connectionModel.js';
import { parseSavedService, mergeServiceConnections } from '../../lib/services/serviceDirectory.js';

const entry = { url: 'https://b.example', targetPeerId: 'B' };
const alternate = { url: 'https://a-alternate.example', targetPeerId: 'A' };
describe('shared service connection contract', () => {
  it.each([
    { url: 'https://a.example', targetPeerId: 'A', routes: [entry, alternate], expected: ['https://a.example', alternate.url] },
    { url: entry.url, targetPeerId: 'A', entryServiceId: 'B', routes: [entry], expected: [] },
    { url: entry.url, serviceOrigin: entry.url, targetPeerId: 'A', routes: [entry, alternate], expected: [alternate.url] },
    { url: entry.url, serviceOrigin: 'https://a.example', entryServiceId: 'B', targetPeerId: 'A', routes: [entry], expected: ['https://a.example'] },
  ])('separates target addresses and entry identity for $url', ({ expected, ...record }) => {
    expect(directConnectionAddresses(record)).toEqual(expected);
    expect(relayConnectionRoutes(record)).toEqual([entry]);
    const saved = parseSavedService({ id: 'A', label: 'A', ...record })!;
    expect(directConnectionAddresses(saved)).toEqual(expected);
    expect(relayConnectionRoutes(saved)).toEqual([entry]);
  });
  it('removes stale direct origins after merging an older record with a relay-only update', () => {
    const old = { id: 'A', label: 'A', url: entry.url, serviceOrigin: entry.url, targetPeerId: 'A' };
    const updated = { id: 'A', label: 'A', url: entry.url, targetPeerId: 'A', routes: [entry] };
    const [merged] = mergeServiceConnections([old, updated]);
    expect(merged.serviceOrigin).toBeUndefined();
    expect(directConnectionAddresses(merged)).toEqual([]);
  });
  it('deduplicates exact identity/address pairs while preserving alternate entry addresses', () => {
    const other = { url: 'https://b-alternate.example', targetPeerId: 'B' };
    expect(relayConnectionRoutes({ url: 'https://a.example', targetPeerId: 'A', routes: [entry, { ...entry, url: entry.url + '/' }, other] })).toEqual([entry, other]);
  });
  it('rejects self entries, credentials, queries and remote plaintext uniformly', () => {
    expect(() => canonicalConnectionRouting({ url: entry.url, targetPeerId: 'B', entryServiceId: 'B' })).toThrow();
    for (const url of ['http://b.example', 'https://user:secret@b.example', 'https://b.example/?token=secret', 'https://b.example/path']) {
      expect(() => normalizeServiceAddress(url)).toThrow(); expect(() => serviceEndpoint(url)).toThrow();
    }
    expect(serviceEndpoint('ws://127.0.0.1:9834').href).toBe('ws://127.0.0.1:9834/api/federation/secure');
  });
});
