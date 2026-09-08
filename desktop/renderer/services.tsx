import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServiceManager } from '../../src/components/services/ServiceManager';
import { normalizeServiceAddress, type ServiceConnection } from '../../src/lib/services/serviceDirectory';
import { parseInviteLink } from '../../src/lib/federation/inviteLink';

async function open(service: ServiceConnection, invitation?: string) {
  const result = await window.termdockDesktop!.openServiceConnection!(service, invitation);
  if (!result.ok) throw new Error(result.error || '暂时无法打开服务，请检查地址和网络。');
}
createRoot(document.getElementById('service-manager')!).render(<ServiceManager onOpen={open} onAdd={async input => {
  if (input.includes('#termdock-invite=')) {
    const connection = parseInviteLink(input);
    await open({ ...connection, id: connection.targetPeerId, label: connection.serviceName || new URL(connection.serviceOrigin || connection.url).host }, input);
  } else {
    const url = normalizeServiceAddress(input);
    await open({ id: url, url, label: new URL(url).host });
  }
}} />);
