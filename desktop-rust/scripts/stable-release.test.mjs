import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releasePlan } from './stable-release.mjs';
import { releasePlan as previewPlan, stableEndpoint } from './preview-release.mjs';
const key = Buffer.from('untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3').toString('base64');
test('stable and final Preview pin one stable trust chain while retaining distinct install identities', () => {
  const stable=releasePlan('1.4.358',key), preview=previewPlan('0.1.14',key);
  assert.equal(stable.tag,'v1.4.358');assert.equal(stable.prerelease,false);
  assert.equal(stable.config.productName,'Termdock');assert.equal(stable.config.identifier,'com.jovines.termdock');
  assert.equal(stable.config.mainBinaryName,'Termdock');assert.equal(preview.config.mainBinaryName,'termdock-preview');
  assert.equal(stable.environment.TERMDOCK_STABLE_UPDATE_ENDPOINT,stableEndpoint);
  assert.equal(preview.environment.TERMDOCK_STABLE_UPDATE_ENDPOINT,stableEndpoint);
  assert.equal(stable.environment.TERMDOCK_STABLE_UPDATE_PUBLIC_KEY,preview.environment.TERMDOCK_STABLE_UPDATE_PUBLIC_KEY);
  assert.equal(preview.config.identifier,'com.jovines.termdock.preview');
  assert.equal(preview.environment.TERMDOCK_DESKTOP_CHANNEL,'preview');
  assert.equal(stable.environment.TERMDOCK_DESKTOP_CHANNEL,'stable');
  assert.throws(()=>releasePlan('1.4.358','invalid'));
});
