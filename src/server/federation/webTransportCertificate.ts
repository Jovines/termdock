import { X509Certificate, createPrivateKey, createPublicKey, randomBytes, webcrypto } from 'node:crypto';
import { readFile, writeFile, rename, chmod, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface TransportCertificate { cert: string; key: string; hash: string; expiresAt: number }

function inspect(value: { cert: string; key: string }, now: number): TransportCertificate {
  const cert = new X509Certificate(value.cert);
  const key = createPrivateKey(value.key);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(cert.publicKey.export({ type: 'spki', format: 'der' }))) throw new Error('Invalid QUIC certificate key');
  const expiresAt = Date.parse(cert.validTo), startsAt = Date.parse(cert.validFrom);
  if (!Number.isFinite(expiresAt) || startsAt > now || expiresAt - startsAt > 14 * 86400_000 || expiresAt < now + 2 * 86400_000) throw new Error('QUIC certificate needs renewal');
  return { ...value, hash: cert.fingerprint256.replaceAll(':', '').toLowerCase(), expiresAt };
}

/** Browsers require short-lived ECDSA certificates for hash-pinned QUIC.
 * Their public hash is delivered through the already authenticated Noise link;
 * the normal HTTPS certificate/CA is unchanged. */
export async function transportCertificate(directory: string, now = Date.now()): Promise<TransportCertificate> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'quic-certificate.json');
  try {
    const stored = JSON.parse(await readFile(file, 'utf8'));
    const result = inspect(stored, now); await chmod(file, 0o600); return result;
  } catch { /* Missing, invalid or expiring certificates are replaced atomically. */ }
  await import('reflect-metadata');
  const x509 = await import('@peculiar/x509');
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'), name: 'CN=Termdock QUIC',
    notBefore: new Date(now - 60_000), notAfter: new Date(now + 13 * 86400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, keys: keys as unknown as Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[0]['keys'],
    extensions: [new x509.BasicConstraintsExtension(false), new x509.SubjectAlternativeNameExtension([
      { type: 'dns', value: 'localhost' }, { type: 'ip', value: '127.0.0.1' }, { type: 'ip', value: '::1' },
    ])],
  }, webcrypto as unknown as NonNullable<Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[1]>);
  const exported = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const key = `-----BEGIN PRIVATE KEY-----\n${exported.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  const value = { cert: cert.toString('pem'), key };
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try { await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
  return inspect(value, now);
}
