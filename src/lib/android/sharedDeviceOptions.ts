import type { AndroidDevice } from './api';
import type { SharedAndroid, SharedAccess } from '../../server/shared/shareResources';
import { androidDeviceOptions } from './deviceOptions';

export interface SharedPhoneOption { device: AndroidDevice; serials: string[]; access?: SharedAccess }
/** Group only server-verified physical identities; names and addresses are not identity. */
export function sharedAndroidDeviceOptions(devices: AndroidDevice[], selected: SharedAndroid[] = []): SharedPhoneOption[] {
  const pool = new Map(devices.map(device => [device.serial, device]));
  for (const item of selected) if (!pool.has(item.serial)) pool.set(item.serial, { serial: item.serial, state: 'unknown' });
  const available = [...pool.values()];
  return androidDeviceOptions(available, '').map(device => {
    const serials = available.filter(candidate => device.physicalId ? candidate.physicalId === device.physicalId : candidate.serial === device.serial).map(candidate => candidate.serial);
    const members = selected.filter(item => serials.includes(item.serial));
    return { device, serials, access: members.some(item => item.access === 'control') ? 'control' : members.length ? 'view' : undefined };
  });
}
/** Keep the exact observed ADB routes in the grant, with one access level per device. */
export function selectSharedAndroidDevice(selected: SharedAndroid[] = [], serials: string[], access?: SharedAccess): SharedAndroid[] {
  return [...selected.filter(item => !serials.includes(item.serial)), ...(access ? serials.map(serial => ({ serial, access })) : [])];
}
