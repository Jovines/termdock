import { describe, expect, it } from 'vitest';
import { androidRouteAccess, groupAndroidDevices, isValidAndroidSerial, normalizeAndroidAddress, resolveAndroidSelection, type AndroidDevice } from './androidDevices';
const v4: AndroidDevice = { serial: '10.0.0.2:5555', physicalId: 'phone-a', state: 'device', isNetwork: true };
const v6: AndroidDevice = { ...v4, serial: '[fd00::2]:5555' };
describe('shared Android selection contract', () => {
  it('fails over an offline selected route but preserves a working explicit IPv6 route', () => {
    expect(groupAndroidDevices([{ ...v4, state: 'offline' }, v6], v4.serial)[0].device).toBe(v6);
    expect(groupAndroidDevices([v4, v6], v6.serial)[0].device).toBe(v6);
  });
  it('restores a physical selection after its old address disappears without choosing a different phone', () => {
    expect(resolveAndroidSelection([v6], v4.serial, v4.physicalId)).toBe(v6);
    expect(resolveAndroidSelection([{ ...v4, physicalId: 'different-phone' }], v4.serial, 'phone-a')).toBeUndefined();
    expect(resolveAndroidSelection([v6], 'unknown-old-route')).toBeUndefined();
  });
  it('auto-selects one physical device across USB/IPv4/IPv6 while retaining every route', () => {
    const usb = { ...v4, serial: 'usb', isNetwork: false };
    expect(groupAndroidDevices([v4, v6, usb])[0].routes).toHaveLength(3);
    expect(resolveAndroidSelection([v4, v6, usb], '')).toBe(usb);
    expect(resolveAndroidSelection([v4, { ...v6, physicalId: 'other' }], '')).toBeUndefined();
  });
  it.each(['10.0.0.1:0', '10.0.0.1:65536', '[::1]:0', '[::1]:65536', '[bad]:5555'])('rejects an invalid endpoint consistently: %s', address => {
    expect(normalizeAndroidAddress(address)).toBeNull(); expect(isValidAndroidSerial(address)).toBe(false);
  });
  it('keeps grants exact even when two routes belong to the same physical device', () => {
    const grants = [{ serial: v4.serial, access: 'view' as const }];
    expect(androidRouteAccess(grants, v4.serial)).toBe('view');
    expect(androidRouteAccess(grants, v6.serial)).toBeUndefined();
  });
});

it('uses the same Android serial contract for invitations and API access', async () => {
  const { validShareResources, resourceSubset } = await import('../server/shared/shareResources');
  expect(validShareResources({ android: [{ serial: '[fd00::2]:5555', access: 'view' }] })).toBe(true);
  expect(validShareResources({ android: [{ serial: '10.0.0.1:65536', access: 'view' }] })).toBe(false);
  expect(resourceSubset({ android: [{ serial: v6.serial, access: 'view' }] }, { android: [{ serial: v4.serial, access: 'control' }] })).toBe(false);
});
