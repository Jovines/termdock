import { describe, it, expect } from 'vitest';
import { scryptSync } from 'node:crypto';
import { PasswordBootstrapServer, startPasswordBootstrap, finishPasswordBootstrap } from './passwordBootstrap.js';
const saltHex = '000102030405060708090a0b0c0d0e0f';
const password = 'correct horse 测试';
const hash = `scrypt$${saltHex}$${scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 67108864 }).toString('hex')}`;
const binding = { clientIdentity: 'client-noise-key', origin: 'https://terminal.example' };
function server(getPasswordHash = () => hash, now = () => Date.now()) { return new PasswordBootstrapServer({ getPasswordHash, serverIdentity: 'server-noise-key', now }); }
async function begin(instance: PasswordBootstrapServer, pass = password) {
  const client = await startPasswordBootstrap(pass, instance.parameters().saltHex);
  const response = await instance.start({ startLoginRequest: client.startLoginRequest, ...binding });
  return { client, response };
}
describe('password authenticated Noise identity bootstrap', () => {
  it('authenticates existing scrypt credentials and both identities; consumes proof once', async () => {
    const instance = server(); const { client, response } = await begin(instance);
    const proof = await finishPasswordBootstrap(client, response, binding);
    expect(await instance.finish(proof)).toEqual({ clientIdentity: binding.clientIdentity, serverIdentity: 'server-noise-key' });
    await expect(instance.finish(proof)).rejects.toThrow();
  });
  it('rejects wrong password and substitution of either identity or origin', async () => {
    const instance = server(); const wrong = await begin(instance, 'wrong');
    await expect(finishPasswordBootstrap(wrong.client, wrong.response, binding)).rejects.toThrow();
    const { client, response } = await begin(instance);
    await expect(finishPasswordBootstrap(client, { ...response, serverIdentity: 'attacker' }, binding)).rejects.toThrow();
    await expect(finishPasswordBootstrap(client, response, { ...binding, clientIdentity: 'attacker' })).rejects.toThrow();
    await expect(finishPasswordBootstrap(client, response, { ...binding, origin: 'https://attacker.example' })).rejects.toThrow();
  });
  it('rejects expired proofs and proofs from credentials changed mid-login', async () => {
    let time = 100; let credential = hash;
    const instance = server(() => credential, () => time);
    const first = await begin(instance); const proof = await finishPasswordBootstrap(first.client, first.response, binding);
    time += 60001; await expect(instance.finish(proof)).rejects.toThrow();
    const second = await begin(instance); const next = await finishPasswordBootstrap(second.client, second.response, binding);
    credential = hash.slice(0, -1) + (hash.endsWith('0') ? '1' : '0');
    await expect(instance.finish(next)).rejects.toThrow();
  });
  it('rejects invalid parameters before expensive work', async () => {
    await expect(startPasswordBootstrap(password, 'invalid')).rejects.toThrow();
    await expect(server().start({ startLoginRequest: 'x'.repeat(8193), ...binding })).rejects.toThrow();
  });
});
