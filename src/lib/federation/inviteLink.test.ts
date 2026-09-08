import { describe, expect, it } from 'vitest';
import { createInviteLink, parseInviteLink } from './inviteLink';
const serviceId = '12D3KooWQGDWJi8Zf2xfrgbfrDCYtobhQ9twqH1qz6qTYFcEk9LX';
const code = 'a'.repeat(43);
describe('trusted invitation links', () => {
  it('puts the secret only in the fragment and preserves verified identity', () => {
    const url = createInviteLink({ v: 1, serviceId, code, entryUrl: 'https://entry.example:9834', name: '工作电脑' });
    expect(new URL(url).search).toBe('');
    expect(new URL(url).pathname).toBe('/');
    expect(parseInviteLink(url)).toMatchObject({ url: 'https://entry.example:9834', targetPeerId: serviceId, pairingCode: code, serviceName: '工作电脑' });
  });
  it('rejects substituted entry origins and malformed identities', () => {
    const url = createInviteLink({ v: 1, serviceId, code, entryUrl: 'https://entry.example' });
    expect(() => parseInviteLink(url.replace('https://entry.example/', 'https://attacker.example/'))).toThrow();
    expect(() => parseInviteLink(createInviteLink({ v: 1, serviceId: 'unverified-key', code, entryUrl: 'https://entry.example' }))).toThrow();
  });
  it('carries independent entry identity and a routing-only invitation for relayed targets', () => {
    const url = createInviteLink({ v: 1, serviceId, code, entryUrl: 'https://entry.example', entryServiceId: serviceId, routeCode: 'b'.repeat(43) });
    expect(parseInviteLink(url)).toMatchObject({ entryServiceId: serviceId, routeCode: 'b'.repeat(43) });
  });
});
