import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import type tls from 'node:tls';

const MAX_CA_BYTES = 256 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5_000;

export interface DownloadedCertificateAuthority {
  certificatePem: string;
  subject: string;
  issuer: string;
  fingerprint256: string;
  validFrom: string;
  validTo: string;
  leafSubject: string;
  leafFingerprint256: string;
}

export function isCertificateTrustError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_CERT_AUTHORITY_INVALID|ERR_CERT_INVALID|SELF[_ ]SIGNED[_ ]CERT(?:[_ ]IN[_ ]CHAIN)?|UNABLE[_ ]TO[_ ]VERIFY[_ ](?:THE[_ ]FIRST[_ ]CERTIFICATE|LEAF[_ ]SIGNATURE)|UNABLE[_ ]TO[_ ]GET[_ ]ISSUER[_ ]CERT/i.test(message);
}

export function canOfferCertificateTrust(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return process.platform === 'darwin' && url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isLocalNetworkHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
  if (net.isIP(hostname) === 0 && !hostname.includes('.')) return true;
  if (/^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname)) return true;
  const ipv4 = hostname.match(/^172\.(\d{1,3})\./);
  if (ipv4) {
    const secondOctet = Number(ipv4[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return hostname === '::1'
    || hostname.startsWith('fe80:')
    || hostname.startsWith('fc')
    || hostname.startsWith('fd');
}

function assertCertificateIsCurrent(certificate: crypto.X509Certificate, label: string): void {
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new Error(`${label}不在有效期内`);
  }
}

function assertCertificateMatchesHost(certificate: crypto.X509Certificate, hostname: string): void {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, '');
  const match = net.isIP(normalizedHostname)
    ? certificate.checkIP(normalizedHostname)
    : certificate.checkHost(normalizedHostname);
  if (!match) throw new Error('服务端证书与连接主机名不匹配');
}

export function validateDownloadedCertificateAuthority(
  certificatePem: string,
  leafDer: Buffer,
  hostname: string,
): DownloadedCertificateAuthority {
  let authority: crypto.X509Certificate;
  let leaf: crypto.X509Certificate;
  try {
    authority = new crypto.X509Certificate(certificatePem);
    leaf = new crypto.X509Certificate(leafDer);
  } catch {
    throw new Error('服务返回的证书无法解析');
  }

  if (!authority.ca) throw new Error('服务返回的不是 CA 根证书');
  if (!authority.verify(authority.publicKey)) throw new Error('服务返回的 CA 不是自签名根证书');
  if (!leaf.verify(authority.publicKey)) throw new Error('下载的 CA 无法验证当前服务端证书');
  assertCertificateIsCurrent(authority, 'CA 根证书');
  assertCertificateIsCurrent(leaf, '服务端证书');
  assertCertificateMatchesHost(leaf, hostname);

  return {
    certificatePem,
    subject: authority.subject,
    issuer: authority.issuer,
    fingerprint256: authority.fingerprint256,
    validFrom: authority.validFrom,
    validTo: authority.validTo,
    leafSubject: leaf.subject,
    leafFingerprint256: leaf.fingerprint256,
  };
}

export async function downloadCertificateAuthority(rawUrl: string): Promise<DownloadedCertificateAuthority> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') {
    throw new Error('只允许从 HTTPS 服务获取 CA 证书');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  return await new Promise((resolve, reject) => {
    let leafDer: Buffer | null = null;
    const request = https.get({
      protocol: 'https:',
      hostname,
      port: url.port || 443,
      path: '/onboarding/ca.crt',
      method: 'GET',
      agent: false,
      rejectUnauthorized: false,
      servername: net.isIP(hostname) ? undefined : hostname,
      headers: { Accept: 'application/x-x509-ca-cert, application/pem-certificate-chain' },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`证书下载接口 /onboarding/ca.crt 返回 HTTP ${response.statusCode ?? '未知状态'}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_CA_BYTES) {
          request.destroy(new Error('服务返回的 CA 证书过大'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (!leafDer) {
          reject(new Error('无法读取服务端 TLS 证书'));
          return;
        }
        try {
          resolve(validateDownloadedCertificateAuthority(
            Buffer.concat(chunks).toString('utf8'),
            leafDer,
            hostname,
          ));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error('下载 CA 证书超时')));
    request.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const peer = (socket as tls.TLSSocket).getPeerCertificate();
        if (peer.raw) leafDer = Buffer.from(peer.raw);
      });
    });
    request.on('error', reject);
  });
}
