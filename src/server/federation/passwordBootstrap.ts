import * as opaque from '@serenity-kit/opaque';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// Existing credentials are password-equivalent here. Never send the stored hash
// over the wire. OPAQUE authenticates both Noise identities before any grant.
const keyStretching = 'memory-constrained' as const;
const userIdentifier = 'termdock-password-bootstrap-v1';
const TTL = 60_000;
function identifiers(clientIdentity: string, serverIdentity: string, origin: string) {
  if (!clientIdentity || clientIdentity.length > 256 || !serverIdentity || serverIdentity.length > 256 ||
      origin.length > 2048 || new URL(origin).origin !== origin) throw new Error('Invalid bootstrap identity');
  return { client: JSON.stringify([userIdentifier, origin, clientIdentity]), server: serverIdentity };
}
function bounded(value: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192) throw new Error('Invalid OPAQUE message');
}
export interface PasswordBootstrapResponse {
  attemptId: string;
  loginResponse: string;
  serverIdentity: string;
}
export async function startPasswordBootstrap(password: string, saltHex: string) {
  if (!/^[0-9a-f]{32}$/.test(saltHex) || !password || password.length > 1024 || new TextEncoder().encode(password).length > 4096) throw new Error('Invalid password parameters');
  await opaque.ready;
  const passwordKey = bytesToHex(await scryptAsync(password, hexToBytes(saltHex), { N: 32768, r: 8, p: 1, dkLen: 64, maxmem: 67108864 }));
  return { ...opaque.client.startLogin({ password: passwordKey }), passwordKey };
}
export async function finishPasswordBootstrap(
  state: Awaited<ReturnType<typeof startPasswordBootstrap>>,
  response: PasswordBootstrapResponse,
  binding: { clientIdentity: string; origin: string },
) {
  await opaque.ready;
  bounded(response.loginResponse);
  const result = opaque.client.finishLogin({ clientLoginState: state.clientLoginState, password: state.passwordKey,
    loginResponse: response.loginResponse, keyStretching,
    identifiers: identifiers(binding.clientIdentity, response.serverIdentity, binding.origin) });
  if (!result) throw new Error('Password authentication failed');
  return { attemptId: response.attemptId, finishLoginRequest: result.finishLoginRequest, serverIdentity: response.serverIdentity };
}

export class PasswordBootstrapServer {
  private setup: string | undefined;
  private pending = new Map<string, { serverLoginState: string; clientIdentity: string; credential: string; expiresAt: number }>();
  constructor(private readonly options: { getPasswordHash: () => string | null; serverIdentity: string; now?: () => number }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private credential() {
    const hash = this.options.getPasswordHash();
    if (!hash || !/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(hash)) throw new Error('Password authentication unavailable');
    return hash;
  }
  parameters() { return { saltHex: this.credential().split('$')[1] }; }
  async start(input: { startLoginRequest: string; clientIdentity: string; origin: string }): Promise<PasswordBootstrapResponse> {
    bounded(input.startLoginRequest);
    const ids = identifiers(input.clientIdentity, this.options.serverIdentity, input.origin);
    for (const [id, entry] of this.pending) if (entry.expiresAt <= this.now()) this.pending.delete(id);
    if (this.pending.size >= 32) throw new Error('Too many password login attempts');
    const credential = this.credential();
    await opaque.ready;
    if (this.pending.size >= 32) throw new Error('Too many password login attempts');
    this.setup ??= opaque.server.createSetup();
    const password = credential.split('$')[2];
    // Registration is local migration from the existing scrypt credential; no
    // unauthenticated network registration endpoint or password reset is needed.
    const registration = opaque.client.startRegistration({ password });
    const { registrationResponse } = opaque.server.createRegistrationResponse({ ...registration, serverSetup: this.setup, userIdentifier });
    const { registrationRecord } = opaque.client.finishRegistration({ ...registration, registrationResponse, password, identifiers: ids, keyStretching });
    const result = opaque.server.startLogin({ serverSetup: this.setup, registrationRecord, userIdentifier,
      startLoginRequest: input.startLoginRequest, identifiers: ids });
    const attemptId = globalThis.crypto.randomUUID();
    this.pending.set(attemptId, { serverLoginState: result.serverLoginState, clientIdentity: input.clientIdentity, credential, expiresAt: this.now() + TTL });
    return { attemptId, loginResponse: result.loginResponse, serverIdentity: this.options.serverIdentity };
  }
  async finish(input: { attemptId: string; finishLoginRequest: string }) {
    bounded(input.finishLoginRequest);
    const entry = this.pending.get(input.attemptId);
    this.pending.delete(input.attemptId);
    if (!entry || entry.expiresAt <= this.now() || entry.credential !== this.credential()) throw new Error('Password login expired');
    await opaque.ready;
    opaque.server.finishLogin({ serverLoginState: entry.serverLoginState, finishLoginRequest: input.finishLoginRequest });
    return { clientIdentity: entry.clientIdentity, serverIdentity: this.options.serverIdentity };
  }
}
