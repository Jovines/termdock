import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DirectTargetConfig } from './directRoutes.js';
import { desktopDirectTargets } from './desktopTargets.js';
import { RelayClient } from './relay.js';
import { openServiceSocket } from './serviceTransport.js';
import { serviceEndpoint, normalizeServiceAddress } from './connectionModel.js';
import type { Identity } from './secureProtocol.js';
import { connectCollaborationRpc } from '../agent/collaborationPeerTransport.js';

interface SelfRelayTarget {
  serviceId: string;
  url: string;
  caFingerprint256?: string;
  certificateFingerprint256?: string;
  caPath?: string;
}

interface SelfRelayState {
  signature: string;
  stopped: boolean;
  lifetime: AbortController;
  upstream?: WebSocket;
  client?: RelayClient;
  wake?: () => void;
}

export interface DesktopSelfRelayOptions {
  desktopFile: string;
  /** Only administrator-configured, pinned destinations; never browser URLs. */
  targets?: () => DirectTargetConfig[];
  baseDir?: string;
  identity: Identity;
  serviceId: string;
  localOrigin: string | (() => string);
  localCa?: Buffer;
}

function relayEndpoint(origin: string, selfRelayToken: string): string {
  const url = serviceEndpoint(origin, 'relay');
  url.searchParams.set('selfRelayToken', selfRelayToken);
  return url.href;
}

/**
 * A local Termdock service may publish only its own stable identity to other
 * administrator-configured peers or services pinned by the same Desktop
 * installation. Configuration supplies addresses and TLS trust only; the service proves itself with its own Noise identity and
 * no browser/device authorization is copied into this process.
 */
export class DesktopSelfRelay {
  private states = new Map<string, SelfRelayState>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private options: DesktopSelfRelayOptions) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 2_000);
    this.timer.unref?.();
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.timer = undefined;
    for (const state of this.states.values()) this.stopState(state);
    this.states.clear();
  }

  private refresh(): void {
    if (this.stopped) return;
    const desired = new Map([...desktopDirectTargets(this.options.desktopFile, this.options.serviceId), ...(this.options.targets?.() || [])]
      .filter(target => target.serviceId !== this.options.serviceId)
      .map(target => [JSON.stringify([target.serviceId, normalizeServiceAddress(target.url)]), { ...target, url: normalizeServiceAddress(target.url) } as SelfRelayTarget]));
    for (const [serviceId, state] of this.states) {
      const target = desired.get(serviceId);
      const signature = target && JSON.stringify([target.url, target.caFingerprint256, target.caPath, target.certificateFingerprint256]);
      if (!target || signature !== state.signature) {
        this.stopState(state); this.states.delete(serviceId);
      }
    }
    for (const [serviceId, target] of desired) if (!this.states.has(serviceId)) {
      const state: SelfRelayState = { signature: JSON.stringify([target.url, target.caFingerprint256, target.caPath, target.certificateFingerprint256]), stopped: false, lifetime: new AbortController() };
      this.states.set(serviceId, state);
      void this.run(state, target);
    }
  }

  private stopState(state: SelfRelayState): void {
    if (state.stopped) return;
    state.stopped = true; state.lifetime.abort(); state.wake?.(); state.wake = undefined;
    state.client?.close(); state.client = undefined;
    state.upstream?.terminate(); state.upstream = undefined;
  }

  private async run(state: SelfRelayState, target: SelfRelayTarget): Promise<void> {
    let delay = 1_000;
    while (!this.stopped && !state.stopped) {
      try {
        await this.connect(state, target);
        delay = 1_000;
      } catch { /* Offline and older entries remain dormant and retry with backoff. */ }
      if (this.stopped || state.stopped) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { state.wake = undefined; resolve(); }, delay); timer.unref?.();
        state.wake = () => { clearTimeout(timer); state.wake = undefined; resolve(); };
      });
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private async connect(state: SelfRelayState, target: SelfRelayTarget): Promise<void> {
    const peer = { serviceId: target.serviceId, origin: target.url, ...(target.caFingerprint256 ? { caFingerprint256: target.caFingerprint256 } : {}) };
    const configuredCa = target.caPath ? readFileSync(resolve(this.options.baseDir || process.cwd(), target.caPath)) : undefined;
    const rpc = await connectCollaborationRpc(this.options.identity, peer, undefined, undefined, configuredCa, target.certificateFingerprint256, state.lifetime.signal);
    let selfRelayToken: string;
    try {
      const result = await rpc.request({ type: 'self-relay-ticket' });
      if (result.serviceId !== this.options.serviceId || typeof result.selfRelayToken !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/.test(result.selfRelayToken)) throw new Error('INVALID_SELF_RELAY_TICKET');
      selfRelayToken = result.selfRelayToken;
    } finally { rpc.close(); }
    if (this.stopped || state.stopped) return;

    const upstream = await openServiceSocket(relayEndpoint(target.url, selfRelayToken), target, { baseDir: this.options.baseDir, maxPayload: 256 * 1024, relayReady: true, signal: state.lifetime.signal });
    state.upstream = upstream;
    try {
      if (this.stopped || state.stopped) return;
      const client = new RelayClient(upstream, { targets: new Map([[this.options.serviceId,
        (signal: AbortSignal) => openServiceSocket(serviceEndpoint(typeof this.options.localOrigin === 'function' ? this.options.localOrigin() : this.options.localOrigin).href,
          { ca: this.options.localCa }, { signal: AbortSignal.any([signal, state.lifetime.signal]) })]]) });
      state.client = client;
      await new Promise<void>(resolve => {
        if (upstream.readyState !== WebSocket.OPEN) resolve();
        else upstream.once('close', () => resolve());
      });
    } finally {
      state.client?.close(); state.client = undefined;
      if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
      if (state.upstream === upstream) state.upstream = undefined;
    }
  }
}
