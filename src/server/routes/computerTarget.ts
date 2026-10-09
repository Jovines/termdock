import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function privateComputerAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) return privateComputerAddress(value.slice(7));
  return isIP(value) === 6 && (value === '::1' || value.startsWith('fc') || value.startsWith('fd'));
}

/** Resolve once, reject mixed public/private DNS answers, and dial the pinned IP. */
export async function resolveComputerHost(host: string): Promise<{ address: string; family: number }> {
  host = host.trim();
  if (!host || host.length > 253 || (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) {
    throw new Error('COMPUTER_INVALID_HOST');
  }
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => !privateComputerAddress(item.address))) throw new Error('COMPUTER_PRIVATE_HOST_ONLY');
  return addresses[0];
}
