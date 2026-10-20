import { describe, expect, it } from 'vitest';
import { androidDeviceOptions } from './deviceOptions';
import type { AndroidDevice } from './api';
const ipv4: AndroidDevice = { serial: '10.0.0.2:5555', state: 'device', isNetwork: true, model: 'PTP-AN00', physicalId: 'phone-a' };
const ipv6: AndroidDevice = { ...ipv4, serial: '[fd00::2]:5555' };
const usb: AndroidDevice = { ...ipv4, serial: 'usb-serial', isNetwork: false };
describe('physical Android device options', () => {
  it('merges verified IPv4/IPv6 aliases and prefers USB when no route is selected', () => {
    expect(androidDeviceOptions([ipv6, ipv4], '')).toEqual([ipv4]);
    expect(androidDeviceOptions([ipv6, ipv4, usb], '')).toEqual([usb]);
  });
  it('preserves a selected IPv6 route even when IPv4 or USB is discovered', () => {
    expect(androidDeviceOptions([usb, ipv4, ipv6], ipv6.serial)).toEqual([ipv6]);
  });
  it('does not merge two phones with the same model or unverified identities', () => {
    const other = { ...ipv4, serial: '10.0.0.3:5555', physicalId: 'phone-b' };
    expect(androidDeviceOptions([ipv4, ipv6, other], '')).toEqual([ipv4, other]);
    const a = { ...ipv4, physicalId: undefined }, b = { ...ipv6, physicalId: undefined };
    expect(androidDeviceOptions([a, b], '')).toEqual([a, b]);
  });
  it('prefers a reachable alias while keeping offline devices visible', () => {
    const offline = { ...ipv6, state: 'offline' as const };
    expect(androidDeviceOptions([offline, ipv4], '')).toEqual([ipv4]);
    expect(androidDeviceOptions([offline], '')).toEqual([offline]);
  });
});
