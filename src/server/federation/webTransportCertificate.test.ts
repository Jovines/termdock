import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transportCertificate } from './webTransportCertificate.js';
import { abortable, readWebTransportDescriptor, WEBTRANSPORT_PATH } from './webTransportProtocol.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('persists private short-lived certificates and rotates expiring or mismatched keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'td-quic-cert-')); directories.push(directory);
  const now = Date.now(), first = await transportCertificate(directory, now);
  expect((await transportCertificate(directory, now)).hash).toBe(first.hash);
  expect(statSync(join(directory, 'quic-certificate.json')).mode & 0o777).toBe(0o600);
  const renewed = await transportCertificate(directory, now + 12 * 86400_000);
  expect(renewed.hash).not.toBe(first.hash);
  const file = join(directory, 'quic-certificate.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...stored, key: first.key }));
  expect((await transportCertificate(directory, now + 12 * 86400_000)).hash).not.toBe(renewed.hash);
});

it('rejects invalid or expired transport capabilities rather than accepting an arbitrary endpoint', () => {
  const now = Date.now(), descriptor = { version: 1, port: 9834, path: WEBTRANSPORT_PATH, certificateHash: 'ab'.repeat(32), expiresAt: now + 86400_000 };
  expect(readWebTransportDescriptor(descriptor, now)).toEqual(descriptor);
  for (const changed of [{ version: 2 }, { path: '/api/other' }, { port: 0 }, { port: 65536 }, { port: 1.5 },
    { certificateHash: 'xx'.repeat(32) }, { expiresAt: now }, { expiresAt: now + 15 * 86400_000 }]) {
    expect(readWebTransportDescriptor({ ...descriptor, ...changed }, now)).toBeUndefined();
  }
});

it('rejects an aborted transport operation and consumes a late rejection', async () => {
  const controller = new AbortController(); let reject!: (error: Error) => void, cancelled = 0;
  const pending = abortable(new Promise<void>((_resolve, fail) => { reject = fail; }), controller.signal, () => { cancelled++; });
  const error = new Error('cancelled'); controller.abort(error);
  await expect(pending).rejects.toBe(error);
  reject(new Error('late failure'));
  expect(cancelled).toBe(1);
});
