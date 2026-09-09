import type { Packet } from '../../server/federation/packets';

export class DeviceAuthorizationRequired extends Error {
  constructor() { super('Device authorization expired or revoked'); }
}

/** Only an authenticated target's permission response can invalidate a login.
 * Transport failures remain retryable and never become "wrong password". */
type PermissionClient = { closed?: boolean; request(packet: Omit<Packet, 'id'>, options?: { timeoutMs?: number }): Promise<Packet> };
type Permissions = { fullService: boolean; grants: { actions: string[] }[]; canManage: boolean };
const permissionsCache = new WeakMap<PermissionClient, { at: number; settled: boolean; pending: Promise<Permissions> }>();

export function readDeviceAuthorization(client: PermissionClient, options: { timeoutMs?: number; maxAgeMs?: number } = {}): Promise<Permissions> {
  const cached = permissionsCache.get(client);
  if (!client.closed && cached && (!cached.settled || Date.now() - cached.at < (options.maxAgeMs ?? 1000))) return cached.pending;
  const record = { at: Date.now(), settled: false, pending: undefined as unknown as Promise<Permissions> };
  const pending = readPermissions(client, options.timeoutMs ?? 5000).then(result => {
    record.at = Date.now(); record.settled = true; return result;
  }, error => { if (permissionsCache.get(client) === record) permissionsCache.delete(client); throw error; });
  record.pending = pending; permissionsCache.set(client, record);
  return pending;
}
async function readPermissions(client: PermissionClient, timeoutMs: number): Promise<Permissions> {
  const permissions = await client.request({ type: 'permissions' }, { timeoutMs });
  if (permissions.type !== 'result' || typeof permissions.fullService !== 'boolean' || !Array.isArray(permissions.grants)) throw new Error('Invalid permission response');
  const grants = permissions.grants as { actions: string[] }[];
  const fullService = permissions.fullService === true;
  if (!fullService && grants.length === 0) throw new DeviceAuthorizationRequired();
  return { fullService, grants, canManage: (fullService && grants.length > 0) || grants.some(grant => grant.actions.includes('authorization.manage')) };
}
