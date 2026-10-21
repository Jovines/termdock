import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { verifyPublication, publicationReport } from '../.github/scripts/verify-npm-publication.mjs';

const bytes = Buffer.from('verified CI package');
const pack = { name: 'termdock', version: '1.4.339', integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` };
const tarball = 'https://registry.npmjs.org/termdock/-/termdock-1.4.339.tgz';
function json(value) { return new Response(JSON.stringify(value)); }
function published(url) {
  if (url === tarball) return new Response(bytes);
  if (url.endsWith('/dist-tags')) return json({ latest: pack.version });
  return json({ ...pack, dist: { integrity: pack.integrity, tarball } });
}
function clock(timeoutMs = 100, retryMs = 10) {
  let elapsed = 0;
  return { timeoutMs, retryMs, now: () => elapsed, sleep: async ms => { elapsed += ms; }, log: () => {} };
}

test('retries a delayed registry then verifies metadata, downloaded bytes and latest', async () => {
  let calls = 0;
  const fetchImpl = async url => ++calls <= 2 ? new Response('', { status: 404 }) : published(url);
  assert.deepEqual(await verifyPublication(pack, { ...clock(), fetchImpl }), { state: 'verified', version: pack.version });
  assert.equal(calls, 5);
});

test('accepted upload remains pending after bounded 404s rather than becoming a failed upload', async () => {
  let calls = 0;
  const result = await verifyPublication(pack, { ...clock(20), fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } });
  assert.equal(result.state, 'pending');
  assert.equal(calls, 2);
  assert.match(publicationReport(result), /public availability is not yet confirmed/);
  assert.match(publicationReport(result), /do not publish it again/);
});

test('waits for a delayed latest tag even after the exact version is visible', async () => {
  let queries = 0;
  const fetchImpl = async url => url.endsWith('/dist-tags') && ++queries === 1 ? json({ latest: '1.4.338' }) : published(url);
  assert.equal((await verifyPublication(pack, { ...clock(), fetchImpl })).state, 'verified');
  assert.equal(queries, 2);
});

test('retries throttling, server failures and temporary network errors', async () => {
  for (const failure of [429, 503, 'network']) {
    let first = true;
    const fetchImpl = async url => {
      if (!first) return published(url);
      first = false;
      if (failure === 'network') throw new Error('connection reset');
      return new Response('', { status: failure });
    };
    assert.equal((await verifyPublication(pack, { ...clock(), fetchImpl })).state, 'verified');
  }
});

test('does not soften authentication or permission failures', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(verifyPublication(pack, { ...clock(), fetchImpl: async () => new Response('', { status }) }), /verification rejected/);
  }
});

test('keeps metadata identity and integrity mismatches fatal', async () => {
  for (const metadata of [
    { ...pack, version: '1.4.338', dist: { integrity: pack.integrity, tarball } },
    { ...pack, dist: { integrity: 'sha512-wrong', tarball } },
  ]) {
    await assert.rejects(verifyPublication(pack, { ...clock(), fetchImpl: async () => json(metadata) }), /identity or integrity mismatch/);
  }
});

test('keeps public tarball corruption fatal', async () => {
  await assert.rejects(verifyPublication(pack, { ...clock(), fetchImpl: async url => url === tarball ? new Response('corrupt') : published(url) }), /tarball integrity mismatch/);
});

test('only the post-upload step can accept pending; publication and build failures stay fatal', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /run: npm publish "\.\/npm-package\/termdock-\$\{EXPECTED_VERSION\}\.tgz" --access public/);
  assert.match(workflow, /run: node \.github\/scripts\/verify-npm-publication\.mjs npm-package\/pack\.json --upload-accepted/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});
