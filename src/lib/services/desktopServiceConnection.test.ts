// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInviteLink } from '../federation/inviteLink';
import type { TermdockDesktopBridge } from '../desktop/nativeBridge';
import { desktopCertificateTrust, desktopConnectionIntent, openDesktopService, serviceConnectionInput } from './desktopServiceConnection';
import { parseInviteLink } from '../federation/inviteLink';

afterEach(() => vi.restoreAllMocks());
const target = '12D3KooW' + 'a'.repeat(44), entry = '12D3KooW' + 'b'.repeat(44);
const service = { id: target, targetPeerId: target, url: 'https://entry.example', serviceOrigin: 'https://target.internal', label: 'Target', routes: [{ url: 'https://backup.example', targetPeerId: entry }] };
function bridge() {
  return { openServiceConnection: vi.fn().mockResolvedValue({ ok: true }), reviewServiceConnection: vi.fn().mockResolvedValue(undefined) } as unknown as TermdockDesktopBridge;
}
describe('shared desktop connection actions', () => {
  it.each([true, false])('bootstraps a relay target through the entry with direct address known=%s', known => {
    const request = desktopConnectionIntent({ targetPeerId: target, url: known ? 'https://target.internal' : 'https://entry.example',
      ...(known ? { serviceOrigin: 'https://target.internal' } : { entryServiceId: entry }),
      serviceName: 'Target', routes: [{ url: 'https://entry.example', targetPeerId: entry }, { url: 'https://alternate.example', targetPeerId: target }] });
    expect(request.connection).toMatchObject({ id: target, targetPeerId: target, label: 'Target', url: 'https://entry.example', entryServiceId: entry,
      routes: [{ url: 'https://entry.example', targetPeerId: entry }, { url: 'https://alternate.example', targetPeerId: target }] });
    expect(request.connection.serviceOrigin).toBe(known ? 'https://target.internal' : undefined);
    expect(request.invitation).toBeUndefined();
  });
  it.each([false, true])('hands off invitation credentials without saving them (route only=%s)', routeOnly => {
    const intent = { url: 'https://entry.example', serviceOrigin: 'https://target.internal', targetPeerId: target, entryServiceId: entry,
      routeCode: 'd'.repeat(32), ...(routeOnly ? { routeOnly: true } : { pairingCode: 'c'.repeat(32) }), viewMode: 'chat' as const };
    const request = desktopConnectionIntent(intent);
    expect(parseInviteLink(request.invitation!)).toMatchObject(intent);
    expect(JSON.stringify(request.connection)).not.toMatch(/pairingCode|routeCode|routeOnly|termdock-invite/);
  });
  it.each(['computer.example:9834', 'wss://computer.example:9834/api/federation/secure'])('normalizes %s identically for both entry points', input => {
    expect(serviceConnectionInput(input)).toEqual({ connection: { id: 'https://computer.example:9834', url: 'https://computer.example:9834', label: 'computer.example:9834' } });
  });
  it('keeps relay identity and invitation secrets in the original link only', () => {
    const invitation = createInviteLink({ v: 1, serviceId: target, entryServiceId: entry, entryUrl: service.url, serviceUrl: service.serviceOrigin, code: 'c'.repeat(32), routeCode: 'd'.repeat(32), viewMode: 'chat' });
    const request = serviceConnectionInput(invitation);
    expect(request.invitation).toBe(invitation);
    expect(request.connection).toMatchObject({ targetPeerId: target, entryServiceId: entry, url: service.url, serviceOrigin: service.serviceOrigin });
    expect(JSON.stringify(request.connection)).not.toMatch(/pairingCode|routeCode|termdock-invite/);
  });
  it.each(['PREVIEW_DISCOVERY_FAILED', 'PREVIEW_CERTIFICATE_REJECTED'])('hands %s to the trusted center with all original connection metadata', async code => {
    const native = bridge();
    vi.mocked(native.openServiceConnection!).mockRejectedValue(Object.assign(new Error('TLS rejected'), { code }));
    await openDesktopService(native, service, 'original-invitation');
    expect(native.reviewServiceConnection).toHaveBeenCalledExactlyOnceWith(service, 'original-invitation');
    expect(native.openServiceConnection).toHaveBeenCalledOnce();
  });
  it('does not move trusted opens or authorization/identity failures to the certificate review', async () => {
    const native = bridge();
    await openDesktopService(native, service);
    vi.mocked(native.openServiceConnection!).mockRejectedValue(Object.assign(new Error('Denied'), { code: 'PREVIEW_AUTHORIZATION_REJECTED' }));
    await expect(openDesktopService(native, service)).rejects.toThrow('Denied');
    expect(native.reviewServiceConnection).not.toHaveBeenCalled();
  });
  it('retains errors for legacy clients and a failed handoff instead of reporting success', async () => {
    const native = bridge();
    vi.mocked(native.openServiceConnection!).mockRejectedValue(Object.assign(new Error('TLS rejected'), { code: 'PREVIEW_DISCOVERY_FAILED' }));
    vi.mocked(native.reviewServiceConnection!).mockRejectedValue(new Error('Center unavailable'));
    await expect(openDesktopService(native, service)).rejects.toThrow('Center unavailable');
    delete native.reviewServiceConnection;
    await expect(openDesktopService(native, service)).rejects.toThrow('TLS rejected');
    expect(desktopCertificateTrust(native)).toBeUndefined();
  });
});
