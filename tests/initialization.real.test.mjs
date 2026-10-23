import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { ensureMkcert, setupLocalHttps, inspectLocalCertificate, localCertificateNeedsRefresh } from '../src/server/utils/localHttpsSetup.ts';

test('official mkcert download, isolated CA, real TLS, renewal and stable CA identity', { timeout: 180_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock real initialization '));
  const old = process.env.CAROOT; process.env.CAROOT = path.join(root, 'private CA');
  t.after(() => { if (old === undefined) delete process.env.CAROOT; else process.env.CAROOT = old; fs.rmSync(root, { recursive: true, force: true }); });
  const mkcert = await ensureMkcert({ home: root, find: () => null, log: console.log });
  const options = { directory: path.join(root, 'certs'), names: ['localhost', '127.0.0.1', '::1', '*.termdock.local'], mkcert, installCa: false };
  const first = await setupLocalHttps(options), before = inspectLocalCertificate(first.files, options.names);
  assert.equal(localCertificateNeedsRefresh(options.directory, options.names), false);
  const server = https.createServer({ cert: fs.readFileSync(first.files.cert), key: fs.readFileSync(first.files.key) }, (_req, res) => res.end('INIT_TLS_OK'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = await new Promise((resolve, reject) => https.get(`https://127.0.0.1:${server.address().port}`, { ca: fs.readFileSync(first.files.ca) }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve(data));
    }).on('error', reject));
    assert.equal(body, 'INIT_TLS_OK');
  } finally { await new Promise(resolve => server.close(resolve)); }
  const renewed = await setupLocalHttps({ ...options, allowCaChange: false });
  const after = inspectLocalCertificate(renewed.files, options.names);
  assert.equal(after.ca.fingerprint256, before.ca.fingerprint256);
  assert.notEqual(after.cert.fingerprint256, before.cert.fingerprint256);
  assert.equal(fs.existsSync(path.join(options.directory, 'rootCA-key.pem')), false);
  assert.equal(renewed.trust, 'skipped');
});

let docker = false;
if (process.platform === 'linux') {
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }); docker = true; } catch { /* Optional container coverage. */ }
}
test('minimal Debian generates a CA and leaf without sudo, OpenSSL or certutil', { skip: !docker, timeout: 180_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock minimal Linux '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mkcert = await ensureMkcert({ home: root, find: () => null });
  execFileSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--user', `${process.getuid()}:${process.getgid()}`, '--env', 'CAROOT=/audit/CA', '--workdir', '/audit',
    '--mount', `type=bind,src=${root},dst=/audit`, '--mount', `type=bind,src=${mkcert},dst=/usr/local/bin/mkcert,readonly`,
    'debian:bookworm', '/bin/sh', '-ec',
    'for tool in sudo openssl certutil; do if command -v "$tool" >/dev/null 2>&1; then exit 42; fi; done; mkcert -cert-file /audit/termdock-local.pem -key-file /audit/termdock-local-key.pem localhost 127.0.0.1 ::1; cp /audit/CA/rootCA.pem /audit/rootCA.pem'],
  { stdio: 'pipe', timeout: 150_000 });
  const files = { cert: path.join(root, 'termdock-local.pem'), key: path.join(root, 'termdock-local-key.pem'), ca: path.join(root, 'rootCA.pem') };
  inspectLocalCertificate(files, ['localhost', '127.0.0.1', '::1']);
});
