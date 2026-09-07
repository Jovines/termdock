import crypto from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import {
  CertificateTrustRequests,
  resolveServiceCertificateTrust,
  type DownloadedCertificateAuthority,
  canOfferCertificateTrust,
  isCertificateTrustError,
  isLocalNetworkHostname,
  matchManagedLocalCertificate,
} from './certificateTrust.js';

describe('macOS certificate trust eligibility', () => {
  it('refreshes a cached managed certificate fingerprint after leaf rotation', () => {
    const readCurrent = vi.fn(() => 'NEW');
    expect(matchManagedLocalCertificate('NEW', 'OLD', readCurrent)).toEqual({
      matches: true,
      currentFingerprint: 'NEW',
    });
    expect(readCurrent).toHaveBeenCalledOnce();
  });

  it('does not reread the managed certificate while the cached leaf still matches', () => {
    const readCurrent = vi.fn(() => 'OTHER');
    expect(matchManagedLocalCertificate('CURRENT', 'CURRENT', readCurrent)).toEqual({
      matches: true,
      currentFingerprint: 'CURRENT',
    });
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it.each([
    'localhost',
    'studio-mac.local',
    'studio-mac',
    '10.0.0.8',
    '172.16.2.4',
    '172.31.255.2',
    '192.168.1.20',
    '169.254.10.2',
    'fd00::20',
    'fe80::1',
  ])('recognizes local hostname %s', (hostname) => {
    expect(isLocalNetworkHostname(hostname)).toBe(true);
  });

  it.each(['example.com', '172.15.0.1', '172.32.0.1', '8.8.8.8', '2001:4860:4860::8888'])(
    'rejects public hostname %s',
    (hostname) => {
      expect(isLocalNetworkHostname(hostname)).toBe(false);
    },
  );

  it('offers application trust for any HTTPS URL on macOS', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      expect(canOfferCertificateTrust('https://studio.local:9834')).toBe(true);
      expect(canOfferCertificateTrust('https://example.com')).toBe(true);
      expect(canOfferCertificateTrust('https://100.64.0.8:9834')).toBe(true);
      expect(canOfferCertificateTrust('http://studio.local:9834')).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it.each([
    'net::ERR_CERT_AUTHORITY_INVALID',
    'CERT_AUTHORITY_INVALID',
    'CERT_INVALID',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'self signed certificate in certificate chain',
    'unable to verify the first certificate',
  ])('recognizes trust failure %s', (message) => {
    expect(isCertificateTrustError(new Error(message))).toBe(true);
  });

  it('does not classify unrelated network failures as trust failures', () => {
    expect(isCertificateTrustError(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(false);
  });
});

describe('certificate trust recovery', () => {
  const pem = rootCertificates[0];
  const certificate = { leafFingerprint256: new crypto.X509Certificate(pem).fingerprint256 } as DownloadedCertificateAuthority;

  it('coalesces concurrent requests and permits explicit retry after cancellation', async () => {
    const requests = new CertificateTrustRequests();
    const prompt = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(certificate);
    const first = requests.request('https://localhost:9834', prompt);
    const second = requests.request('https://localhost:9834', prompt);
    expect(first).toBe(second);
    await expect(first).resolves.toBeNull();
    await expect(requests.request('https://localhost:9834', prompt)).resolves.toBeNull();
    expect(prompt).toHaveBeenCalledTimes(1);
    requests.retry('https://localhost:9834');
    await expect(requests.request('https://localhost:9834', prompt)).resolves.toBe(certificate);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('does not share a cancellation with a different origin', async () => {
    const requests = new CertificateTrustRequests();
    await requests.request('https://localhost:9834', async () => null);
    await expect(requests.request('https://localhost:9835', async () => certificate)).resolves.toBe(certificate);
  });

  it('accepts only the actual certificate approved for the service hostname', async () => {
    await expect(resolveServiceCertificateTrust('https://localhost:9834', 'localhost', pem,
      async () => certificate)).resolves.toBe(true);
    await expect(resolveServiceCertificateTrust('https://localhost:9834', 'localhost', pem,
      async () => null)).resolves.toBe(false);
    await expect(resolveServiceCertificateTrust('https://localhost:9834', 'localhost', pem,
      async () => ({ ...certificate, leafFingerprint256: 'rotated-again' }))).resolves.toBe(false);
    const prompt = vi.fn(async () => certificate);
    await expect(resolveServiceCertificateTrust('https://localhost:9834', 'other.local', pem, prompt)).resolves.toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('quietly gates failed downloads until explicit retry', async () => {
    const requests = new CertificateTrustRequests();
    const prompt = vi.fn().mockRejectedValue(new Error('download failed'));
    await expect(requests.request('https://localhost:9834', prompt)).rejects.toThrow('download failed');
    await expect(requests.request('https://localhost:9834', prompt)).resolves.toBeNull();
    expect(prompt).toHaveBeenCalledOnce();
  });
});
