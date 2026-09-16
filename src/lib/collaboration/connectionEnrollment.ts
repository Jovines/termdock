import { currentSecureClient, openAuthorizedServiceClient, readPinnedCollaborationDescriptor, savedConnection, SECURE_STATE_EVENT } from '../federation/browserIntegration';
import type { SecureClient } from '../federation/secureClient';
import { listServiceConnections, observeServiceConnections, type ServiceConnection } from '../services/serviceDirectory';

type Node = { serviceId: string; origin: string; caFingerprint256?: string };
/** Connection setup only: enroll public identities through already authorized
 * encrypted page connections. No message relay, peer polling or private-key transfer.
 * Old macOS preload is used only to read its saved public service directory. */
export function installCollaborationEnrollment(): void {
  let running = false, stopped = false, dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = new Map<string, string>();
  const descriptors = new Map<string, Node>();
  const enroll = async (client: SecureClient, node: Node, nodes: Node[]) => {
    const signature = JSON.stringify(nodes);
    if (completed.get(node.serviceId) === signature) return;
    const signal = AbortSignal.timeout(10_000);
    const csrf = await client.fetch('/api/csrf-token', { signal });
    if (!csrf.ok) throw new Error('CONNECTION_AUTHORIZATION_REQUIRED');
    const token = await csrf.json();
    if (typeof token.csrfToken !== 'string') throw new Error('INVALID_CSRF_TOKEN');
    const response = await client.fetch('/api/terminal/operations/collaboration-connections', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': token.csrfToken }, body: JSON.stringify({ origin: node.origin, nodes }) });
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `HTTP_${response.status}`); }
    completed.set(node.serviceId, signature);
  };
  const run = async () => {
    if (running) { dirty = true; return; }
    const selected = savedConnection(), active = currentSecureClient();
    if (stopped || !selected || !active || active.closed) return;
    running = true; dirty = false;
    try {
      let directoryTimeout: ReturnType<typeof setTimeout> | undefined;
      const services = await Promise.race([listServiceConnections(), new Promise<never>((_, reject) => { directoryTimeout = setTimeout(() => reject(new Error('SERVICE_DIRECTORY_TIMEOUT')), 8000); })]).finally(() => clearTimeout(directoryTimeout));
      if (!services.some(service => service.targetPeerId === selected.targetPeerId)) services.push({ ...selected, id: selected.targetPeerId, label: selected.serviceName || selected.url });
      const unique = [...new Map(services.filter(service => !!service.targetPeerId).map(service => [service.targetPeerId!, service])).values()].slice(0, 64);
      if (unique.length < 2) return;
      const verified: Array<{ service: ServiceConnection; node: Node }> = [];
      // Bounded sequential setup; saved bookmarks never authorize business access
      // to peers, and every descriptor is checked against its pinned service id.
      for (const service of unique) {
        try {
          const key = `${service.targetPeerId}:${service.serviceOrigin || service.url}`;
          let node = descriptors.get(key);
          if (!node) {
            const descriptor = service.targetPeerId === selected.targetPeerId
              ? (await active.request({ type: 'collaboration-descriptor' }, { timeoutMs: 5000 })).node as Node
              : await readPinnedCollaborationDescriptor({ ...service, targetPeerId: service.targetPeerId! }, AbortSignal.timeout(8000));
            if (descriptor?.serviceId !== service.targetPeerId) throw new Error('PEER_IDENTITY_MISMATCH');
            const origin = descriptor.origin || service.serviceOrigin || service.url;
            const url = new URL(origin);
            if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('INVALID_SERVICE_ORIGIN');
            node = { serviceId: descriptor.serviceId, origin, ...(descriptor.caFingerprint256 ? { caFingerprint256: descriptor.caFingerprint256 } : {}) };
            descriptors.set(key, node);
          }
          verified.push({ service, node });
        } catch { /* Another service may be offline or not yet upgraded; retry setup later. */ }
      }
      if (stopped || currentSecureClient() !== active || savedConnection()?.targetPeerId !== selected.targetPeerId) return;
      const own = verified.find(item => item.node.serviceId === selected.targetPeerId);
      if (!own || verified.length < 2) { schedule(30_000); return; }
      const nodes = verified.map(item => item.node).sort((a, b) => a.serviceId.localeCompare(b.serviceId));
      await enroll(active, own.node, nodes);
      let pending = verified.length < unique.length;
      for (const item of verified) {
        if (item === own || completed.get(item.node.serviceId) === JSON.stringify(nodes)) continue;
        let client: SecureClient | undefined;
        try { client = await openAuthorizedServiceClient({ ...item.service, targetPeerId: item.node.serviceId }, AbortSignal.timeout(8000)); await enroll(client, item.node, nodes); }
        catch { pending = true; /* Per-origin macOS identities: the peer's own authorized page enrolls it. */ }
        finally { client?.close(); }
      }
      window.dispatchEvent(new CustomEvent('termdock:collaboration-enrollment', { detail: { ok: true } }));
      if (pending) schedule(30_000);
    } catch (error) {
      window.dispatchEvent(new CustomEvent('termdock:collaboration-enrollment', { detail: { ok: false, error: error instanceof Error ? error.message : 'CONNECTION_ENROLLMENT_FAILED' } }));
      schedule(30_000);
    } finally { running = false; if (dirty) schedule(100); }
  };
  function schedule(delay = 100) { if (stopped) return; clearTimeout(timer); timer = setTimeout(() => { void run(); }, delay); }
  const changed = () => { schedule(); };
  const unobserve = observeServiceConnections(changed);
  window.addEventListener(SECURE_STATE_EVENT, changed);
  window.addEventListener('termdock:collaboration-enroll', changed);
  window.addEventListener('online', changed);
  window.addEventListener('pageshow', changed);
  window.addEventListener('pagehide', event => { if (event.persisted) return; stopped = true; clearTimeout(timer); unobserve(); window.removeEventListener('termdock:collaboration-enroll', changed); window.removeEventListener(SECURE_STATE_EVENT, changed); window.removeEventListener('online', changed); window.removeEventListener('pageshow', changed); });
  schedule();
}
