import { expect, it } from 'vitest';
import { sharedAndroidDeviceOptions, selectSharedAndroidDevice } from './sharedDeviceOptions';
import type { AndroidDevice } from './api';
const ipv4: AndroidDevice = { serial: '10.0.0.2:5555', state: 'device', physicalId: 'phone-a', model: 'Pixel', isNetwork: true };
const ipv6: AndroidDevice = { ...ipv4, serial: '[fd00::2]:5555' };
it('shares verified IPv4, IPv6 and USB routes as one physical device with one access level', () => {
  const usb = { ...ipv4, serial: 'usb-phone', isNetwork: false };
  const options = sharedAndroidDeviceOptions([ipv6, ipv4, usb], [{ serial: ipv6.serial, access: 'view' }]);
  expect(options).toHaveLength(1); expect(options[0].device.serial).toBe(usb.serial); expect(options[0].access).toBe('view');
  const selected = selectSharedAndroidDevice([], options[0].serials, 'control');
  expect(selected).toEqual(expect.arrayContaining([ipv4, ipv6, usb].map(device => ({ serial: device.serial, access: 'control' }))));
  expect(selected).toHaveLength(3); expect(selectSharedAndroidDevice(selected, options[0].serials)).toEqual([]);
});
it('never merges matching model names without verified identity, and preserves unavailable selections for removal', () => {
  const other = { ...ipv4, serial: '10.0.0.3:5555', physicalId: 'phone-b' };
  expect(sharedAndroidDeviceOptions([ipv4, ipv6, other])).toHaveLength(2);
  expect(sharedAndroidDeviceOptions([{ ...ipv4, physicalId: undefined }, { ...ipv6, physicalId: undefined }])).toHaveLength(2);
  const options = sharedAndroidDeviceOptions([ipv4], [{ serial: 'old-address:5555', access: 'view' }]);
  expect(options.find(option => option.device.serial === 'old-address:5555')).toMatchObject({ access: 'view', serials: ['old-address:5555'] });
});
