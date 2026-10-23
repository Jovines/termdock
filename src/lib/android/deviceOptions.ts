import type { AndroidDevice } from './api';
import { groupAndroidDevices } from '../../shared/androidDevices';
export { groupAndroidDevices, resolveAndroidSelection } from '../../shared/androidDevices';

/** One option per physical device, chosen by the shared route policy. */
export function androidDeviceOptions(devices: AndroidDevice[], selectedSerial: string): AndroidDevice[] {
  return groupAndroidDevices(devices, selectedSerial).map(group => group.device);
}
