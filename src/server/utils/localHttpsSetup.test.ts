// @vitest-environment node
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createHash, webcrypto } from 'node:crypto';
import { downloadVerifiedExecutable, ensureMkcert, inspectLocalCertificate, localCertificateNeedsRefresh, localHttpsPaths, MKCERT_SHA256, setupLocalHttps, type RunTool } from './localHttpsSetup.js';

let material: { cert: string; key: string; ca: string }, other: typeof material;
const directories: string[] = [];
const names = ['localhost', '127.0.0.1', '::1', '*.termdock.local'];
async function certificates() {
  await import('reflect-metadata');
  const x509 = await import('@peculiar/x509');
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = keys.publicKey as unknown as CryptoKey, signingKey = keys.privateKey as unknown as CryptoKey;
  const now = Date.now(), signingAlgorithm = { name: 'ECDSA', hash: 'SHA-256' };
  const extensions = [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)];
  const ca = await x509.X509CertificateGenerator.createSelfSigned({ name: 'CN=Test Local CA', keys: { publicKey, privateKey: signingKey }, signingAlgorithm,
    notBefore: new Date(now - 60_000), notAfter: new Date(now + 365 * 86400_000), extensions }, webcrypto as unknown as Crypto);
  const cert = await x509.X509CertificateGenerator.create({ subject: 'CN=localhost', issuer: ca.subject, publicKey, signingKey, signingAlgorithm,
    notBefore: new Date(now - 60_000), notAfter: new Date(now + 90 * 86400_000), extensions: [new x509.BasicConstraintsExtension(false),
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']),
      new x509.SubjectAlternativeNameExtension(names.map(value => ({ type: value.includes(':') || /^[0-9]/.test(value) ? 'ip' as const : 'dns' as const, value })))],
  }, webcrypto as unknown as Crypto);
  const exported = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const key = `-----BEGIN PRIVATE KEY-----\n${exported.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { cert: cert.toString('pem'), ca: ca.toString('pem'), key };
}
beforeAll(async () => { material = await certificates(); other = await certificates(); });
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function directory() { const result = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock https ')); directories.push(result); return result; }
function fixture(value = material) {
  const root = directory(), directory_ = path.join(root, 'certs'), caRoot = path.join(root, 'CA with spaces');
  fs.mkdirSync(caRoot); fs.writeFileSync(path.join(caRoot, 'rootCA.pem'), value.ca);
  const calls: string[][] = [];
  const run: RunTool = async (_file, args) => {
    calls.push(args);
    if (args[0] === '-CAROOT') return { stdout: caRoot + '\n', stderr: '' };
    if (args[0] === '-cert-file') {
      fs.writeFileSync(args[1], value.cert); fs.writeFileSync(args[3], value.key);
    }
    return { stdout: '', stderr: '' };
  };
  return { root, directory: directory_, caRoot, calls, run };
}

for (const asset of Object.keys(MKCERT_SHA256)) it(`selects the pinned official ${asset} binary without needing a package manager`, async () => {
  const [platform, arch] = asset.split('-'), home = directory();
  const download = vi.fn(async (_url: string, _hash: string, target: string) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture'); });
  const result = await ensureMkcert({ platform, arch: arch === 'amd64' ? 'x64' : arch, home, find: () => null, run: async () => ({ stdout: 'v1.4.4', stderr: '' }), download });
  expect(result).toBe(path.join(home, '.termdock/bin/mkcert'));
  expect(download).toHaveBeenCalledWith(`https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-${asset}`, MKCERT_SHA256[asset], result);
});
it('uses an existing mkcert without downloading it', async () => {
  const download = vi.fn();
  expect(await ensureMkcert({ find: () => '/existing/mkcert', run: async () => ({ stdout: 'v1.4.4', stderr: '' }), download })).toBe('/existing/mkcert');
  expect(download).not.toHaveBeenCalled();
});
it('reports unsupported architectures before attempting a download', async () => {
  const download = vi.fn();
  await expect(ensureMkcert({ platform: 'linux', arch: 's390x', home: directory(), find: () => null, download })).rejects.toThrow('linux/s390x');
  expect(download).not.toHaveBeenCalled();
});
it('rejects a damaged download without replacing a previous executable', async () => {
  const target = path.join(directory(), 'mkcert'); fs.writeFileSync(target, 'previous');
  await expect(downloadVerifiedExecutable('https://example.invalid/tool', '0'.repeat(64), target, async () => new Response('bad') as never)).rejects.toThrow('SHA-256');
  expect(fs.readFileSync(target, 'utf8')).toBe('previous');
});
it('installs a verified executable with owner-only permissions', async () => {
  const target = path.join(directory(), 'bin/mkcert'), bytes = Buffer.from('verified fixture');
  await downloadVerifiedExecutable('https://example.invalid/tool', createHash('sha256').update(bytes).digest('hex'), target, async () => new Response(bytes) as never);
  expect(fs.statSync(target).mode & 0o777).toBe(0o700);
});
it('keeps network/download failures actionable', async () => {
  await expect(ensureMkcert({ platform: 'linux', arch: 'x64', home: directory(), find: () => null,
    download: async () => { throw new Error('network unavailable'); } })).rejects.toThrow('Install mkcert manually');
});
it('rejects oversized and unavailable downloads without writing an executable', async () => {
  const target = path.join(directory(), 'mkcert');
  for (const response of [new Response('', { status: 503 }), new Response('large', { headers: { 'Content-Length': String(21 * 1024 * 1024) } })]) {
    await expect(downloadVerifiedExecutable('https://example.invalid/tool', '0'.repeat(64), target, async () => response as never)).rejects.toThrow();
  }
  expect(fs.existsSync(target)).toBe(false);
});

it('generates a valid chain with matching private key/SANs and performs a real HTTPS handshake', async () => {
  const f = fixture();
  const result = await setupLocalHttps({ ...f, names, installCa: false, mkcert: '/mock/mkcert' });
  expect(result.trust).toBe('skipped'); expect(f.calls.some(args => args[0] === '-install')).toBe(false);
  expect(localCertificateNeedsRefresh(f.directory, names)).toBe(false);
  for (const file of Object.values(result.files)) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const server = https.createServer({ cert: fs.readFileSync(result.files.cert), key: fs.readFileSync(result.files.key) }, (_req, res) => res.end('TLS_OK'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const body = await new Promise<string>((resolve, reject) => https.get(`https://127.0.0.1:${port}`, { ca: material.ca }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve(data));
    }).on('error', reject));
    expect(body).toBe('TLS_OK');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const fault of ['generation', 'missing-ca', 'bad-key', 'bad-ca', 'missing-san']) it(`keeps the previous working files on ${fault} failure`, async () => {
  const f = fixture(), files = localHttpsPaths(f.directory);
  fs.mkdirSync(f.directory);
  for (const key of ['cert', 'key', 'ca'] as const) fs.writeFileSync(files[key], material[key]);
  if (fault === 'missing-ca') fs.rmSync(path.join(f.caRoot, 'rootCA.pem'));
  const run: RunTool = async (file, args, options) => {
    const result = await f.run(file, args, options);
    if (args[0] === '-cert-file') {
      if (fault === 'generation') throw new Error('compiler/tool failed');
      if (fault === 'bad-key') fs.writeFileSync(args[3], other.key);
      if (fault === 'bad-ca') fs.writeFileSync(path.join(f.caRoot, 'rootCA.pem'), other.ca);
    }
    return result;
  };
  await expect(setupLocalHttps({ ...f, names: fault === 'missing-san' ? [...names, 'missing.example'] : names, run, mkcert: '/mock/mkcert', installCa: false })).rejects.toThrow();
  for (const key of ['cert', 'key', 'ca'] as const) expect(fs.readFileSync(files[key], 'utf8')).toBe(material[key]);
  expect(fs.readdirSync(f.directory).sort()).toEqual(['rootCA.pem', 'termdock-local-key.pem', 'termdock-local.pem']);
});

it('renews an expiring certificate and detects a mismatched key or SAN change', async () => {
  const f = fixture(); const { files } = await setupLocalHttps({ ...f, names, mkcert: '/mock/mkcert', installCa: false });
  expect(localCertificateNeedsRefresh(f.directory, names, Date.now() + 70 * 86400_000)).toBe(true);
  expect(localCertificateNeedsRefresh(f.directory, [...names, 'new.example'])).toBe(true);
  fs.writeFileSync(files.key, other.key);
  expect(localCertificateNeedsRefresh(f.directory, names)).toBe(true);
});
it('refuses silent CA rotation during automatic renewal but allows an explicit replacement', async () => {
  const f = fixture(other), files = localHttpsPaths(f.directory); fs.mkdirSync(f.directory);
  for (const key of ['cert', 'key', 'ca'] as const) fs.writeFileSync(files[key], material[key]);
  await expect(setupLocalHttps({ ...f, names, mkcert: '/mock/mkcert', installCa: false, allowCaChange: false })).rejects.toThrow('replace the trusted CA');
  expect(fs.readFileSync(files.ca, 'utf8')).toBe(material.ca);
  const result = await setupLocalHttps({ ...f, names, mkcert: '/mock/mkcert', installCa: false });
  expect(result.caChanged).toBe(true); expect(result.warnings.join(' ')).toContain('every device');
});
it('repairs a corrupt CA only through an explicit setup', async () => {
  const f = fixture(), files = localHttpsPaths(f.directory); fs.mkdirSync(f.directory);
  fs.writeFileSync(files.ca, 'damaged CA');
  await expect(setupLocalHttps({ ...f, names, mkcert: '/mock/mkcert', installCa: false, allowCaChange: false })).rejects.toThrow('replace the trusted CA');
  await setupLocalHttps({ ...f, names, mkcert: '/mock/mkcert', installCa: false });
  expect(localCertificateNeedsRefresh(f.directory, names)).toBe(false);
});
it('rolls the complete certificate set back when publishing one staged file fails', async () => {
  const f = fixture(other), files = localHttpsPaths(f.directory); fs.mkdirSync(f.directory);
  for (const key of ['cert', 'key', 'ca'] as const) fs.writeFileSync(files[key], material[key]);
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === files.key) throw new Error('rename denied');
    return rename(from, to);
  });
  await expect(setupLocalHttps({ ...f, names, mkcert: '/mock/mkcert', installCa: false })).rejects.toThrow('rename denied');
  for (const key of ['cert', 'key', 'ca'] as const) expect(fs.readFileSync(files[key], 'utf8')).toBe(material[key]);
});
it('skips privilege prompts in a headless unprivileged setup, while keeping generated certificates usable', async () => {
  const f = fixture();
  const result = await setupLocalHttps({ ...f, names, mkcert: '/mock/mkcert', uid: 1000, interactive: false, platform: 'linux', find: () => null });
  expect(result.trust).toBe('skipped'); expect(result.warnings.join(' ')).toContain('libnss3-tools');
  expect(result.warnings.join(' ')).toContain('cannot elevate'); expect(f.calls.some(args => args[0] === '-install')).toBe(false);
  inspectLocalCertificate(result.files, names);
});
it('does not describe failed trust installation as trusted', async () => {
  const f = fixture();
  const run: RunTool = async (file, args, options) => { if (args[0] === '-install') throw new Error('trust store read-only'); return f.run(file, args, options); };
  const result = await setupLocalHttps({ ...f, names, mkcert: '/mock/mkcert', run, uid: 0, interactive: false, find: () => null });
  expect(result.trust).toBe('failed'); expect(result.warnings.join(' ')).toContain('trust store read-only');
  expect(localCertificateNeedsRefresh(f.directory, names)).toBe(false);
});
it('rejects concurrent setup, recovers a dead lock and always cleans its own lock', async () => {
  const f = fixture(); fs.mkdirSync(f.directory); const lock = path.join(f.directory, '.setup.lock');
  fs.writeFileSync(lock, String(process.pid));
  await expect(setupLocalHttps({ ...f, names, mkcert: '/mock/mkcert', installCa: false })).rejects.toThrow('already running');
  expect(fs.existsSync(lock)).toBe(true); fs.writeFileSync(lock, '2147483647');
  await setupLocalHttps({ ...f, names, mkcert: '/mock/mkcert', installCa: false });
  expect(fs.existsSync(lock)).toBe(false);
});
