import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { webcrypto } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/server/cli.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
let material;
before(async () => {
  await import('reflect-metadata');
  const x509 = await import('@peculiar/x509');
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const signingAlgorithm = { name: 'ECDSA', hash: 'SHA-256' }, now = Date.now();
  const validity = { notBefore: new Date(now - 60_000), notAfter: new Date(now + 90 * 86400_000) };
  const ca = await x509.X509CertificateGenerator.createSelfSigned({ name: 'CN=Initialization Test CA', keys, signingAlgorithm, ...validity,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)] }, webcrypto);
  const cert = await x509.X509CertificateGenerator.create({ subject: 'CN=localhost', issuer: ca.subject, publicKey: keys.publicKey, signingKey: keys.privateKey, signingAlgorithm, ...validity,
    extensions: [new x509.BasicConstraintsExtension(false), new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), new x509.SubjectAlternativeNameExtension([
      { type: 'dns', value: 'localhost' }, { type: 'dns', value: '*.termdock.local' }, { type: 'dns', value: 'test.termdock.local' }, { type: 'ip', value: '127.0.0.1' }, { type: 'ip', value: '::1' },
      ...Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => ({ type: 'ip', value: item.address })),
    ])] }, webcrypto);
  const bytes = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  material = { cert: cert.toString('pem'), ca: ca.toString('pem'), key: `-----BEGIN PRIVATE KEY-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n` };
});

function fixture(t, fail = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock init CLI '));
  const children = [];
  t.after(async () => {
    for (const { child, done, timeout } of children) {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await done; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const bin = path.join(root, 'bin'), caroot = path.join(root, 'private CA');
  fs.mkdirSync(bin); fs.mkdirSync(caroot);
  fs.mkdirSync(path.join(root, '.termdock'));
  fs.writeFileSync(path.join(root, '.termdock/settings.json'), JSON.stringify({ localAccess: { name: 'test', source: 'manual' } }));
  for (const [key, value] of Object.entries(material)) fs.writeFileSync(path.join(root, key + '.pem'), value);
  fs.writeFileSync(path.join(caroot, 'rootCA.pem'), material.ca);
  const tool = (name, code) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${code}`, { mode: 0o700 });
  tool('mkcert', `
    const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2), root = process.env.INIT_FIXTURE;
    fs.appendFileSync(path.join(root, 'mkcert-calls'), JSON.stringify(args)+'\\n');
    if (args[0] === '--version') { if(process.env.INIT_FAIL === 'version') process.exit(9); console.log('v1.4.4'); }
    else if (args[0] === '-CAROOT') console.log(process.env.CAROOT);
    else if (args[0] === '-install') {
      if (process.env.INIT_FAIL === 'trust') {
        process.stdin.resume(); process.stdin.on('end', () => { console.error('TRUST_STDIN_EOF'); process.exit(17); });
      }
    } else {
      fs.copyFileSync(path.join(root, 'key.pem'), args[3]);
      if (process.env.INIT_FAIL === 'generation') { console.error('GENERATION_FAILED'); process.exit(19); }
      fs.copyFileSync(path.join(root, 'cert.pem'), args[1]);
    }
  `);
  tool('sudo', "if(process.argv.slice(2).join(' ') !== '-n true') process.exit(23);");
  tool('tmux', "if(process.argv.includes('-V')) console.log('tmux 3.6a');");
  tool('npx', "console.error('UNEXPECTED_REBUILD'); process.exit(29);");
  const env = { PATH: bin + path.delimiter + process.env.PATH, HOME: root, CAROOT: caroot, INIT_FIXTURE: root, INIT_FAIL: fail,
    XDG_CONFIG_HOME: path.join(root, '.config'), XDG_DATA_HOME: path.join(root, '.local/share'), SHELL: '/invalid/login-shell',
    TERM: 'xterm-256color', TERMDOCK_SUPERVISOR: '0' };
  const files = path.join(root, '.termdock/certs');
  const launch = args => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, output })));
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    children.push({ child, done, timeout });
    return { child, done, output: () => output };
  };
  return { root, files, launch };
}
const standard = ['--setup-local-https', '--no-install-ca'];

test('real CLI generates certificates under an isolated HOME without installing trust', async t => {
  const f = fixture(t), result = await f.launch(standard).done;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /generated and validated/);
  assert.match(result.output, /trust has not been installed/);
  assert.equal(fs.readFileSync(path.join(f.files, 'rootCA.pem'), 'utf8'), material.ca);
  assert.equal(fs.existsSync(path.join(f.files, 'rootCA-key.pem')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'mkcert-calls'), 'utf8'), /-install/);
});
test('real CLI preserves existing certificates after a generation failure', async t => {
  const f = fixture(t, 'generation'); fs.mkdirSync(f.files, { recursive: true });
  fs.writeFileSync(path.join(f.files, 'termdock-local.pem'), material.cert);
  fs.writeFileSync(path.join(f.files, 'termdock-local-key.pem'), material.key);
  fs.writeFileSync(path.join(f.files, 'rootCA.pem'), material.ca);
  const result = await f.launch(standard).done;
  assert.equal(result.code, 1); assert.match(result.output, /GENERATION_FAILED/);
  assert.equal(fs.readFileSync(path.join(f.files, 'termdock-local-key.pem'), 'utf8'), material.key);
  assert.deepEqual(fs.readdirSync(f.files).sort(), ['rootCA.pem', 'termdock-local-key.pem', 'termdock-local.pem']);
});
test('existing broken HTTPS fails closed when renewal fails', async t => {
  const f = fixture(t, 'generation'); fs.mkdirSync(f.files, { recursive: true });
  fs.writeFileSync(path.join(f.files, 'termdock-local.pem'), 'damaged');
  const result = await f.launch(['--foreground', '--host', '127.0.0.1', '--port', '19876']).done;
  assert.equal(result.code, 1); assert.match(result.output, /refusing to fall back to HTTP/);
  assert.equal(fs.existsSync(path.join(f.root, '.termdock/server.json')), false);
});
test('a broken installed mkcert is reported before any certificate is changed', async t => {
  const f = fixture(t, 'version'), result = await f.launch(standard).done;
  assert.equal(result.code, 1); assert.match(result.output, /installed mkcert is unusable/);
  assert.equal(fs.existsSync(f.files), false);
});
test('trust failure receives EOF rather than hanging or claiming the machine trusts the CA', async t => {
  const f = fixture(t, 'trust'), result = await f.launch(['--setup-local-https']).done;
  assert.equal(result.code, 0, result.output); assert.match(result.output, /TRUST_STDIN_EOF/);
  assert.match(result.output, /trust has not been installed/);
});

async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function waitHealth(port, tls, process_) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process_.child.exitCode !== null) throw new Error(process_.output());
    try {
      const result = await new Promise((resolve, reject) => {
        const transport = tls ? https : http;
        transport.get({ host: '127.0.0.1', port, path: '/health', ca: material.ca, timeout: 500 }, res => {
          let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('timeout', function () { this.destroy(); }).on('error', reject);
      });
      assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).status, 'ok'); return;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('Server did not become healthy: ' + process_.output());
}
test('a headless first start uses HTTP without unexpected certificate downloads or native rebuilds', async t => {
  const f = fixture(t), port = await freePort();
  const process_ = f.launch(['--foreground', '--host', '127.0.0.1', '--port', String(port)]);
  await waitHealth(port, false, process_);
  assert.equal(fs.existsSync(path.join(f.root, 'mkcert-calls')), false);
  assert.doesNotMatch(process_.output(), /UNEXPECTED_REBUILD/);
});
test('explicit custom TLS starts successfully even with a damaged unused default certificate', async t => {
  const f = fixture(t, 'generation'), port = await freePort(); fs.mkdirSync(f.files, { recursive: true });
  fs.writeFileSync(path.join(f.files, 'termdock-local.pem'), 'damaged default');
  const process_ = f.launch(['--foreground', '--host', '127.0.0.1', '--port', String(port),
    '--https-cert', path.join(f.root, 'cert.pem'), '--https-key', path.join(f.root, 'key.pem'), '--https-ca', path.join(f.root, 'ca.pem')]);
  await waitHealth(port, true, process_);
  assert.equal(fs.existsSync(path.join(f.root, 'mkcert-calls')), false);
});
