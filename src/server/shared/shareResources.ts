/** Explicit resources carried by one invitation and revoked with its grant. */
export type SharedAccess = 'view' | 'control';
export interface SharedAndroid { serial: string; access: SharedAccess }
export interface SharedComputer { host: string; protocol: 'vnc' | 'rdp'; port: number; access: SharedAccess }
export interface SharedDirectory { path: string; access: 'read' | 'write' }
export interface ShareResources { android?: SharedAndroid[]; computers?: SharedComputer[]; directories?: SharedDirectory[] }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export function validShareResources(value: unknown): value is ShareResources {
  if (!record(value) || Object.keys(value).some(key => !['android', 'computers', 'directories'].includes(key))) return false;
  return Object.entries(value).every(([key, items]) => Array.isArray(items) && items.length <= 64 && items.every(item => {
    if (!record(item)) return false;
    if (key === 'android') return Object.keys(item).every(k => ['serial', 'access'].includes(k)) && text(item.serial, 128) && /^(?:[0-9a-zA-Z_.:\-]+|\[[0-9a-fA-F:.]+\]:\d{1,5})$/.test(item.serial) && ['view', 'control'].includes(String(item.access));
    if (key === 'computers') return Object.keys(item).every(k => ['host', 'protocol', 'port', 'access'].includes(k)) && text(item.host, 253) && /^[a-zA-Z0-9:.\-]+$/.test(item.host) && ['vnc', 'rdp'].includes(String(item.protocol)) && Number.isInteger(item.port) && Number(item.port) > 0 && Number(item.port) <= 65535 && (item.protocol !== 'vnc' || item.port === 5900) && ['view', 'control'].includes(String(item.access));
    return Object.keys(item).every(k => ['path', 'access'].includes(k)) && text(item.path, 4096) && (item.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(item.path)) && ['read', 'write'].includes(String(item.access));
  }));
}
export function resourceSubset(child: ShareResources | undefined, parent: ShareResources | undefined): boolean {
  return (!child?.android?.length || child.android.every(c => parent?.android?.some(p => p.serial === c.serial && (p.access === 'control' || c.access === 'view'))))
    && (!child?.computers?.length || child.computers.every(c => parent?.computers?.some(p => p.host === c.host && p.protocol === c.protocol && p.port === c.port && (p.access === 'control' || c.access === 'view'))))
    && (!child?.directories?.length || child.directories.every(c => parent?.directories?.some(p => p.path === c.path && (p.access === 'write' || c.access === 'read'))));
}
export function mergeShareResources(resources: Array<ShareResources | undefined>): ShareResources {
  const android = new Map<string, SharedAndroid>(), computers = new Map<string, SharedComputer>(), directories = new Map<string, SharedDirectory>();
  for (const r of resources) {
    for (const item of r?.android ?? []) if (android.get(item.serial)?.access !== 'control') android.set(item.serial, item);
    for (const item of r?.computers ?? []) { const key = JSON.stringify([item.host.toLowerCase(), item.protocol, item.port]); if (computers.get(key)?.access !== 'control') computers.set(key, item); }
    for (const item of r?.directories ?? []) if (directories.get(item.path)?.access !== 'write') directories.set(item.path, item);
  }
  return { android: [...android.values()], computers: [...computers.values()], directories: [...directories.values()] };
}
