import { X509Certificate } from 'node:crypto';
import { get } from 'node:https';
import { connect, checkServerIdentity, type ConnectionOptions } from 'node:tls';

const cache = new Map<string, { expires: number; value: Promise<Buffer> }>();
const leafCache = new Map<string, { expires: number; value: Promise<Buffer> }>();

/** Inspect TLS only, without sending HTTP or business data. Preview approves
 * the leaf itself, so a downloaded CA cannot substitute for that approval. */
export async function pinnedServerTlsOptions(origin: string, fingerprint: string): Promise<ConnectionOptions> {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || !/^[\da-f]{64}$/i.test(fingerprint)) throw new Error('Invalid pinned server certificate');
  const pin = fingerprint.toUpperCase();
  const key = `${url.origin}:${pin}`;
  let cached = leafCache.get(key);
  if (!cached || cached.expires <= Date.now()) {
    const value = new Promise<Buffer>((resolve, reject) => {
      const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443),
        ...(url.hostname.includes(':') || /^[\d.]+$/.test(url.hostname) ? {} : { servername: url.hostname }),
        rejectUnauthorized: false });
      const timer = setTimeout(() => socket.destroy(new Error('Pinned server certificate inspection timed out')), 5000);
      socket.once('error', reject);
      socket.once('close', () => { clearTimeout(timer); reject(new Error('Pinned server certificate inspection closed')); });
      socket.once('secureConnect', () => {
        try {
          const raw = socket.getPeerCertificate().raw;
          if (!raw) throw new Error('Server did not present a certificate');
          const cert = new X509Certificate(raw);
          const hostError = checkServerIdentity(url.hostname.replace(/^\[|\]$/g, ''), socket.getPeerCertificate());
          if (hostError) throw hostError;
          if (cert.fingerprint256.replaceAll(':', '') !== pin || Date.now() < Date.parse(cert.validFrom)
            || Date.now() > Date.parse(cert.validTo)) throw new Error('Server certificate no longer matches Preview trust');
          resolve(Buffer.from(cert.toString()));
        } catch (error) { reject(error); }
        finally { socket.destroy(); }
      });
    });
    cached = { expires: Date.now() + 120_000, value };
    if (leafCache.size >= 64) leafCache.delete(leafCache.keys().next().value!);
    leafCache.set(key, cached);
    void value.catch(() => { if (leafCache.get(key)?.value === value) leafCache.delete(key); });
  }
  return {
    ca: await cached.value,
    // A CA-issued leaf can be the exact trust anchor without importing its CA.
    allowPartialTrustChain: true,
    checkServerIdentity(host, cert) {
      const error = checkServerIdentity(host, cert);
      if (error) return error;
      if (cert.fingerprint256?.replaceAll(':', '').toUpperCase() !== pin) return new Error('Server certificate no longer matches Preview trust');
    },
  };
}
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
    const signal = AbortSignal.timeout(5000);
    const request = get(url, { agent: false, rejectUnauthorized: false, signal }, response => {
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
    request.on('error', error => {
      if (signal.aborted && signal.reason?.name === 'TimeoutError') {
        reject(new Error(`连接 ${url.origin} 超时（5 秒）：未能读取远端服务证书，请确认远端服务已启动且网络可达`, { cause: error }));
      } else reject(error);
    });
  });
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 120_000, value });
  void value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  return value;
}
