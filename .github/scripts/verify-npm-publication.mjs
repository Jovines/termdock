import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

class RegistryPending extends Error {}

async function readRegistry(url, fetchImpl, binary = false) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { 'Cache-Control': 'no-cache' } });
  } catch (error) {
    throw new RegistryPending(`Registry request unavailable: ${error.message}`);
  }
  if (!response.ok) {
    if ([404, 408, 429].includes(response.status) || response.status >= 500) {
      throw new RegistryPending(`Registry returned HTTP ${response.status}`);
    }
    throw new Error(`Registry verification rejected: HTTP ${response.status}`);
  }
  try {
    return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
  } catch (error) {
    throw new RegistryPending(`Registry response incomplete: ${error.message}`);
  }
}

export async function verifyPublication(pack, {
  fetchImpl = fetch, sleep = pause, now = Date.now, timeoutMs = 10 * 60_000,
  retryMs = 15_000, log = console.log,
} = {}) {
  if (pack.name !== 'termdock' || !/^\d+\.\d+\.\d+$/.test(pack.version) || !pack.integrity?.startsWith('sha512-')) {
    throw new Error('Invalid expected release identity');
  }
  const deadline = now() + timeoutMs;
  let reason;
  do {
    try {
      const metadata = await readRegistry(`https://registry.npmjs.org/termdock/${pack.version}`, fetchImpl);
      if (metadata.name !== pack.name || metadata.version !== pack.version || metadata.dist?.integrity !== pack.integrity) {
        throw new Error('Published package identity or integrity mismatch');
      }
      const tags = await readRegistry('https://registry.npmjs.org/-/package/termdock/dist-tags', fetchImpl);
      if (tags.latest !== pack.version) throw new RegistryPending(`latest is ${tags.latest ?? 'not available'}`);
      const tarball = new URL(metadata.dist.tarball);
      if (tarball.protocol !== 'https:' || tarball.hostname !== 'registry.npmjs.org') throw new Error('Unexpected registry tarball URL');
      const bytes = await readRegistry(tarball.href, fetchImpl, true);
      const integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
      if (integrity !== pack.integrity) throw new Error('Downloaded tarball integrity mismatch');
      return { state: 'verified', version: pack.version };
    } catch (error) {
      if (!(error instanceof RegistryPending)) throw error;
      reason = error.message;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    log(`Waiting for npm registry visibility: ${reason}`);
    await sleep(Math.min(retryMs, remaining));
  } while (now() < deadline);
  return { state: 'pending', version: pack.version, reason };
}

export function publicationReport(result) {
  if (result.state === 'verified') return `npm ${result.version}: public tarball, SHA-512 and latest tag verified.`;
  return `npm accepted ${result.version}; registry visibility verification is pending (${result.reason}). Upload succeeded; public availability is not yet confirmed. Verify this exact version later; do not publish it again.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pack] = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const result = await verifyPublication(pack);
  const report = publicationReport(result);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `registry_state=${result.state}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  if (result.state === 'pending') {
    // Only the workflow step after a successful npm publish may accept pending visibility.
    if (!process.argv.includes('--upload-accepted')) throw new Error(report);
    console.log(`::warning title=npm upload accepted; registry verification pending::${report}`);
  } else console.log(report);
}
