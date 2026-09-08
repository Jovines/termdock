import { X509Certificate } from 'node:crypto';
import { get } from 'node:https';

const cache = new Map<string, { expires: number; value: Promise<Buffer> }>();
/** Only the CA download is unauthenticated. Its exact SHA-256 fingerprint was
 * already approved locally for this origin; the subsequent WSS connection must
 * still pass normal TLS chain, hostname and expiry checks using this CA.
 */
export function readPinnedCertificateAuthority(origin: string, fingerprint: string): Promise<Buffer> {
  const url = new URL('/onboarding/ca.crt', origin);
  if (url.protocol !== 'https:' || url.username || url.password || !/^(?:[\da-f]{2}:){31}[\da-f]{2}$/i.test(fingerprint)) return Promise.reject(new Error('Invalid pinned certificate authority'));
  const key = `${url.origin}:${fingerprint.toUpperCase()}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = new Promise<Buffer>((resolve, reject) => {
    const request = get(url, { agent: false, rejectUnauthorized: false, signal: AbortSignal.timeout(5000) }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Pinned certificate authority unavailable')); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) { request.destroy(new Error('Certificate authority is too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const pem = Buffer.concat(chunks), certificate = new X509Certificate(pem);
          if (!certificate.ca || certificate.fingerprint256 !== fingerprint.toUpperCase()
            || Date.now() < Date.parse(certificate.validFrom) || Date.now() > Date.parse(certificate.validTo)) throw new Error('Certificate authority no longer matches Desktop trust');
          resolve(pem);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 120_000, value });
  void value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  return value;
}
