import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServiceManager } from '../../src/components/services/ServiceManager';
import { normalizeServiceAddress, type ServiceConnection } from '../../src/lib/services/serviceDirectory';
import { parseInviteLink } from '../../src/lib/federation/inviteLink';

async function open(service: ServiceConnection, invitation?: string) {
  const result = await window.termdockDesktop!.openServiceConnection!(service, invitation);
  if (!result.ok) throw new Error(result.error || '暂时无法打开服务，请检查地址和网络。');
}
const preview = window.termdockDesktop as typeof window.termdockDesktop & {
  certificatePins?: () => Promise<Record<string, string>>;
  inspectCertificate?: (origin: string) => Promise<{ origin: string; fingerprint: string; trustedFingerprint?: string; receipt: string }>;
  trustCertificate?: (origin: string, fingerprint: string, receipt: string) => Promise<void>;
  discardCertificateInspection?: (receipt: string) => Promise<void>;
  revokeCertificate?: (origin: string) => Promise<void>;
};
const certificateTrust = preview.certificatePins && preview.inspectCertificate && preview.trustCertificate && preview.discardCertificateInspection && preview.revokeCertificate ? {
  listPins: () => preview.certificatePins!(),
  inspect: (origin: string) => preview.inspectCertificate!(origin),
  trust: (origin: string, fingerprint: string, receipt: string) => preview.trustCertificate!(origin, fingerprint, receipt),
  discard: (receipt: string) => preview.discardCertificateInspection!(receipt),
  revoke: (origin: string) => preview.revokeCertificate!(origin),
} : undefined;
createRoot(document.getElementById('service-manager')!).render(<ServiceManager certificateTrust={certificateTrust} onOpen={open} onAdd={async input => {
  if (input.includes('#termdock-invite=')) {
    const connection = parseInviteLink(input);
    await open({ ...connection, id: connection.targetPeerId, label: connection.serviceName || new URL(connection.serviceOrigin || connection.url).host }, input);
  } else {
    const url = normalizeServiceAddress(input);
    await open({ id: url, url, label: new URL(url).host });
  }
}} />);
