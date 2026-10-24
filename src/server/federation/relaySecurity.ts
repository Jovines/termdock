import { getPasswordVerifier } from '../utils/authProtection.js';

/** A broken credential must never enable a relay, even if auth is enabled. */
export function relayPasswordConfigured(): boolean {
  return /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(getPasswordVerifier() ?? '');
}
export function requireRelayPassword(): void {
  if (!relayPasswordConfigured()) throw new Error('TARGET_PASSWORD_REQUIRED');
}
