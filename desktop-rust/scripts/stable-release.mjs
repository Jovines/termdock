import { buildRelease, releasePlan as previewPlan, stableEndpoint } from './preview-release.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';

async function legacyBridge() {
  if (process.env.TERMDOCK_LEGACY_BRIDGE_ZIP) return process.env.TERMDOCK_LEGACY_BRIDGE_ZIP;
  const response=await fetch('https://api.github.com/repos/Jovines/termdock/releases/tags/v1.4.358', { headers:{Accept:'application/vnd.github+json'}, signal:AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error('The first Rust release requires TERMDOCK_LEGACY_BRIDGE_ZIP; subsequent releases reuse its verified public bridge');
  const release=await response.json();
  const asset=release.assets?.find(a=>a.name==='Termdock-darwin-arm64-1.4.358.zip');
  const url='https://github.com/Jovines/termdock/releases/download/v1.4.358/Termdock-darwin-arm64-1.4.358.zip';
  if (asset?.browser_download_url!==url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') || !Number.isSafeInteger(asset.size) || asset.size<=0) throw Error('Invalid public legacy bridge asset');
  const cache=path.join(os.homedir(),'.cache/termdock-publish');fs.mkdirSync(cache,{recursive:true,mode:0o700});
  const destination=path.join(cache,'bridge-1.4.357.zip');
  const valid=bytes=>bytes.length===asset.size && 'sha256:'+createHash('sha256').update(bytes).digest('hex')===asset.digest;
  if (fs.existsSync(destination) && valid(fs.readFileSync(destination))) return destination;
  const download=await fetch(url,{signal:AbortSignal.timeout(180_000)});
  if (!download.ok) throw Error(`Bridge download failed: ${download.status}`);
  const bytes=Buffer.from(await download.arrayBuffer());if(!valid(bytes))throw Error('Bridge digest mismatch');
  fs.writeFileSync(destination,bytes,{mode:0o600});return destination;
}

export function releasePlan(version, publicKey) {
  const plan = previewPlan(version, publicKey);
  return { ...plan, tag: `v${version}`, prerelease: false, endpoint: stableEndpoint,
    environment: { TERMDOCK_DESKTOP_CHANNEL: 'stable', TERMDOCK_STABLE_UPDATE_ENDPOINT: stableEndpoint, TERMDOCK_STABLE_UPDATE_PUBLIC_KEY: publicKey },
    config: { ...plan.config, productName: 'Termdock', mainBinaryName: 'Termdock', identifier: 'com.jovines.termdock' },
  };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [version, destination] = process.argv.slice(2);
    if (!version || !destination) throw Error('Usage: node scripts/stable-release.mjs VERSION NEW_OUTPUT_DIRECTORY');
    // Retain the existing updater trust key; migration does not rotate keys.
    const bridge=await legacyBridge();
    buildRelease(version, destination, { ...process.env, TERMDOCK_LEGACY_BRIDGE_ZIP:bridge }, releasePlan(version, process.env.TERMDOCK_PREVIEW_UPDATE_PUBLIC_KEY));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
