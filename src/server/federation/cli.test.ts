import { describe, expect, it } from 'vitest';
import { parseRelayConfig, pairingInviteUrl } from './cli.js';
const valid = { entryUrl: 'https://b.example', relayToken: 'x'.repeat(40), targets: [{ serviceId: 'C', url: 'wss://c.example' }] };
describe('relay CLI configuration', () => {
  it('accepts pinned service targets with optional explicit CA files', () => {
    expect(parseRelayConfig({ ...valid, caPath: './root.pem', targets: [{ ...valid.targets[0], caPath: './c.pem' }] }).targets[0].serviceId).toBe('C');
  });
  it('rejects plaintext URLs, redirect-like paths and credentials', () => {
    for (const entryUrl of ['http://b.example', 'ws://b.example', 'https://user:secret@b.example', 'https://b.example/other', 'https://b.example?token=secret']) expect(() => parseRelayConfig({ ...valid, entryUrl })).toThrow();
    expect(() => parseRelayConfig({ ...valid, targets: [{ serviceId: 'C', url: 'http://c.example' }] })).toThrow();
  });
  it('rejects weak or injectable tokens and ambiguous target registration', () => {
    for (const relayToken of ['short', 'x'.repeat(32) + '\r\nX: value']) expect(() => parseRelayConfig({ ...valid, relayToken })).toThrow();
    expect(() => parseRelayConfig({ ...valid, targets: [valid.targets[0], valid.targets[0]] })).toThrow();
    expect(() => parseRelayConfig({ ...valid, rejectUnauthorized: false })).toThrow();
    expect(() => parseRelayConfig({ ...valid, targets: [{ ...valid.targets[0], serviceId: '../C' }] })).toThrow();
  });
});

describe('CLI pairing invitation links', () => {
  it('keeps the secret in the fragment using the shared invitation format', () => {
    const link = new URL(pairingInviteUrl('service-C', 'x'.repeat(43), 'https://c.example:9834'));
    expect(link.search).toBe('');
    expect(link.pathname).toBe('/');
    expect(JSON.parse(Buffer.from(link.hash.slice('#termdock-invite='.length), 'base64url').toString())).toEqual({ v: 1, serviceId: 'service-C', code: 'x'.repeat(43), entryUrl: 'https://c.example:9834', serviceUrl: 'https://c.example:9834' });
  });
  it('rejects embedded credentials, queries, and non-TLS remote invitations', () => {
    for (const url of ['https://user:secret@c.example', 'https://c.example?code=x', 'http://c.example', 'https://c.example/other']) expect(() => pairingInviteUrl('C', 'x'.repeat(43), url)).toThrow();
  });
});
