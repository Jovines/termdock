import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

// Use Node's certificate parser: the system openssl (notably LibreSSL on
// macOS) may not support `x509 -ext`. Propagate read/parse errors so callers
// cannot mistake an inspection failure for an empty SAN extension.
export async function getMissingCertificateNames(certPath: string, required: string[]): Promise<string[]> {
  const cert = new X509Certificate(await readFile(certPath));
  return required.filter((name) => isIP(name)
    ? cert.checkIP(name) === undefined
    : cert.checkHost(name, { subject: 'never', wildcards: false }) === undefined);
}
