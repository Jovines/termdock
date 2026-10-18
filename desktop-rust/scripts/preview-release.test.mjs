import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releasePlan, updateManifest, previewEndpoint, outsideSource } from './preview-release.mjs';
// Public-only vector also used by the pinned Rust updater tests.
const key = Buffer.from('untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3').toString('base64');
test('Preview release keeps its own identity, version and updater feed', () => {
  const plan = releasePlan('0.1.1', key);
  assert.equal(plan.tag, 'preview-v0.1.1');
  assert.equal(plan.prerelease, true);
  assert.equal(plan.config.identifier, 'com.jovines.termdock.preview');
  assert.equal(plan.config.productName, 'Termdock Preview');
  assert.equal(plan.config.bundle.createUpdaterArtifacts, true);
  assert.equal(plan.config.plugins.updater.pubkey, key);
  assert.deepEqual(plan.config.plugins.updater.endpoints, []);
  assert.equal(plan.config.plugins.updater.requireSignedVersion, true);
  assert.equal(plan.environment.TERMDOCK_PREVIEW_UPDATE_ENDPOINT, previewEndpoint);
  assert.equal(plan.environment.TERMDOCK_PREVIEW_UPDATE_PUBLIC_KEY, key);
  assert.ok(!previewEndpoint.includes('/latest/'));
  for (const version of ['v0.1.1', '0.1.1-preview.1', '01.1.1', '1.2', '../stable']) assert.throws(() => releasePlan(version, key));
  for (const badKey of ['', 'invalid', Buffer.from('private key').toString('base64')]) assert.throws(() => releasePlan('0.1.1', badKey));
});
test('updater metadata binds assets to the exact independent Preview release', () => {
  const plan = releasePlan('0.1.1', key);
  const manifest = updateManifest(plan, [{platform:'darwin-aarch64',filename:'Termdock-Preview_0.1.1_aarch64.app.tar.gz',signature:'signed archive'}], 'Preview fixes', new Date('2026-10-18T00:00:00Z'));
  assert.equal(manifest.version, '0.1.1');
  assert.equal(manifest.pub_date, '2026-10-18T00:00:00.000Z');
  assert.equal(manifest.platforms['darwin-aarch64'].url, 'https://github.com/Jovines/termdock/releases/download/preview-v0.1.1/Termdock-Preview_0.1.1_aarch64.app.tar.gz');
  for (const filename of ['Termdock_1.4.323_arm64.zip','Termdock-Preview_0.1.2_aarch64.app.tar.gz','../Termdock-Preview_0.1.1_aarch64.app.tar.gz']) assert.throws(() => updateManifest(plan,[{platform:'darwin-aarch64',filename,signature:'sig'}]));
  const artifact = {platform:'darwin-aarch64',filename:'Termdock-Preview_0.1.1_aarch64.app.tar.gz',signature:'sig'};
  assert.throws(() => updateManifest(plan, []));
  assert.throws(() => updateManifest(plan, [artifact,artifact]));
  assert.throws(() => updateManifest(plan, [{...artifact,signature:''}]));
});

test('release output accepts a sibling directory while rejecting source descendants', () => {
  assert.equal(outsideSource('/build/source','/build'), true);
  assert.equal(outsideSource('/build/source','/build/output'), true);
  assert.equal(outsideSource('/build/source','/tmp/release'), true);
  assert.equal(outsideSource('/build/source','/build/source'), false);
  assert.equal(outsideSource('/build/source','/build/source/output'), false);
});
