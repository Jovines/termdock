/** ADB identities group display/routes only; permissions remain exact-serial grants. */
export interface AndroidDevice {
  serial: string;
  state: 'device' | 'offline' | 'unauthorized' | 'connecting' | 'unknown';
  model?: string; product?: string; device?: string; transport?: string;
  isNetwork?: boolean; androidVersion?: string; sdk?: number; physicalId?: string;
}
export function isValidAndroidSerial(serial: string): boolean {
  if (!serial || serial.length > 128 || !/^(?:[0-9a-zA-Z_.:\-]+|\[[0-9a-fA-F:.]+\]:\d{1,5})$/.test(serial)) return false;
  return serial.startsWith('[') || /^[^:]+:\d+$/.test(serial) ? normalizeAndroidAddress(serial) !== null : true;
}
export function normalizeAndroidAddress(raw: string): string | null {
  let value = raw.trim();
  const pasted = /^[a-z]+:\/\/([^/]+)/i.exec(value);
  if (pasted) value = pasted[1];
  value = value.replace(/^\/+|\/+$/g, '');
  const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(value);
  if (v6) {
    try { new URL(`http://[${v6[1]}]`); } catch { return null; }
    const port = v6[2] ?? '5555';
    return Number(port) >= 1 && Number(port) <= 65535 ? `[${v6[1]}]:${port}` : null;
  }
  if (!/^[0-9a-zA-Z_.\-]+(?::\d{1,5})?$/.test(value)) return null;
  const [host, port = '5555'] = value.split(':');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.split('.').some(part => Number(part) > 255)) return null;
  return Number(port) >= 1 && Number(port) <= 65535 ? `${host}:${port}` : null;
}
export function androidDeviceKey(device: AndroidDevice): string {
  return device.physicalId ? `physical:${device.physicalId}` : `serial:${device.serial}`;
}
export interface AndroidDeviceGroup { key: string; device: AndroidDevice; routes: AndroidDevice[] }
export function groupAndroidDevices(devices: AndroidDevice[], selectedSerial = ''): AndroidDeviceGroup[] {
  const groups = new Map<string, AndroidDeviceGroup>();
  const rank = (device: AndroidDevice) => (device.state === 'device' ? 0 : 10)
    + (device.serial === selectedSerial ? 0 : !device.isNetwork ? 1 : device.serial.startsWith('[') ? 3 : 2);
  for (const device of devices) {
    const key = androidDeviceKey(device), group = groups.get(key);
    if (!group) groups.set(key, { key, device, routes: [device] });
    else {
      group.routes.push(device);
      if (rank(device) < rank(group.device)) group.device = device;
    }
  }
  return [...groups.values()];
}
/** Never switch an explicit selection to an unrelated phone. */
export function resolveAndroidSelection(devices: AndroidDevice[], serial: string, physicalId?: string | null): AndroidDevice | undefined {
  const groups = groupAndroidDevices(devices, serial);
  const exact = devices.find(device => device.serial === serial);
  const identity = physicalId || exact?.physicalId;
  if (identity) return groups.find(group => group.device.physicalId === identity)?.device;
  if (serial) return exact;
  const ready = groups.filter(group => group.device.state === 'device');
  return ready.length === 1 ? ready[0].device : undefined;
}

export function androidRouteAccess(grants: readonly { serial: string; access: 'view' | 'control' }[] | undefined, serial: string): 'view' | 'control' | undefined {
  const matching = grants?.filter(grant => grant.serial === serial) || [];
  return matching.some(grant => grant.access === 'control') ? 'control' : matching.length ? 'view' : undefined;
}
