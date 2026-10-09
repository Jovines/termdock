import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultComputerPreferences } from '../shared/computerPreferences.js';
import { ComputerCredentialStore } from './computerCredentials.js';
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const directory = mkdtempSync(join(tmpdir(), 'termdock-login-')); directories.push(directory); return new ComputerCredentialStore(directory); }
it('restores encrypted credentials after a new process and binds them to computer, protocol, port and account', () => {
  const store = fixture(), profile = { ...defaultComputerPreferences().local, username: 'private-account' }, secret = 'unique-password-登录';
  store.save(profile, secret);
  const saved = readFileSync(store.file, 'utf8');
  expect(saved).not.toContain(secret); expect(saved).not.toContain(profile.username); expect(saved).not.toContain(profile.host);
  expect(statSync(store.file).mode & 0o777).toBe(0o600); expect(statSync(store.keyFile).mode & 0o777).toBe(0o600);
  const restarted = new ComputerCredentialStore(join(store.file, '..'));
  expect(restarted.get(profile)).toBe(secret);
  expect(restarted.get({ ...profile, ignoreCert: true })).toBe(secret);
  for (const patch of [{ host: '192.168.1.20' }, { username: 'other' }, { domain: 'domain' }, { port: '3390' }, { protocol: 'vnc' as const }]) expect(restarted.get({ ...profile, ...patch })).toBeNull();
  restarted.forget(profile); expect(store.get(profile)).toBeNull();
});
it('rejects ciphertext tampering and refuses to replace a lost encryption key', () => {
  const store = fixture(), profile = defaultComputerPreferences().local; store.save(profile, 'private-secret');
  const records = JSON.parse(readFileSync(store.file, 'utf8'));
  records[Object.keys(records)[0]].ciphertext = Buffer.from('tampered').toString('base64');
  writeFileSync(store.file, JSON.stringify(records)); expect(() => store.get(profile)).toThrow();
  unlinkSync(store.keyFile); expect(() => store.save(profile, 'another-secret')).toThrow('KEY_MISSING');
});
