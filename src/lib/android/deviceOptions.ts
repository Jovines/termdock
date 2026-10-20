import type { AndroidDevice } from './api';

/** One option per verified physical device. Keep the active ADB route selected. */
export function androidDeviceOptions(devices: AndroidDevice[], selectedSerial: string): AndroidDevice[] {
  const groups = new Map<string, AndroidDevice>();
  const rank = (device: AndroidDevice) => device.serial === selectedSerial ? 0
    : device.state !== 'device' ? 5
    : !device.isNetwork ? 1
    : device.serial.startsWith('[') ? 3 : 2;
  for (const device of devices) {
    const key = device.physicalId ? `physical:${device.physicalId}` : `serial:${device.serial}`;
    const current = groups.get(key);
    if (!current || rank(device) < rank(current)) groups.set(key, device);
  }
  return [...groups.values()];
}
