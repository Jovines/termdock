import type { Packet } from '../../server/federation/packets';

export class DeviceAuthorizationRequired extends Error {
  constructor() { super('Device authorization expired or revoked'); }
}

/** Only an authenticated target's permission response can invalidate a login.
 * Transport failures remain retryable and never become "wrong password". */
export async function readDeviceAuthorization(client: { request(packet: Omit<Packet, 'id'>, options?: { timeoutMs?: number }): Promise<Packet> }) {
  const permissions = await client.request({ type: 'permissions' }, { timeoutMs: 5000 });
  if (permissions.type !== 'result' || typeof permissions.fullService !== 'boolean' || !Array.isArray(permissions.grants)) throw new Error('Invalid permission response');
  const grants = permissions.grants as { actions: string[] }[];
  const fullService = permissions.fullService === true;
  if (!fullService && grants.length === 0) throw new DeviceAuthorizationRequired();
  return { fullService, grants, canManage: (fullService && grants.length > 0) || grants.some(grant => grant.actions.includes('authorization.manage')) };
}
