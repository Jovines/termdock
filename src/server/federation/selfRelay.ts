import WebSocket from 'ws';
import { desktopDirectTargets } from './desktopTargets.js';
import { RelayClient } from './relay.js';
import { readPinnedCertificateAuthority } from './trustedCa.js';
import type { Identity } from './secureProtocol.js';
import { connectCollaborationRpc } from '../agent/collaborationPeerTransport.js';

interface SelfRelayTarget {
  serviceId: string;
  url: string;
  caFingerprint256?: string;
}

interface SelfRelayState {
  signature: string;
  stopped: boolean;
  upstream?: WebSocket;
  client?: RelayClient;
  wake?: () => void;
}

export interface DesktopSelfRelayOptions {
  desktopFile: string;
  identity: Identity;
  serviceId: string;
  localOrigin: string;
  localCa?: Buffer;
}

function relayEndpoint(origin: string, selfRelayToken: string): string {
  const url = new URL('/api/federation/relay', origin);
  url.protocol = 'wss:';
  url.searchParams.set('selfRelayToken', selfRelayToken);
  return url.href;
}

function secureEndpoint(origin: string): string {
  const url = new URL('/api/federation/secure', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function openSocket(url: string, ca?: Buffer, maxPayload = 256 * 1024): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const secure = new URL(url).protocol === 'wss:';
    const socket = new WebSocket(url, {
      ...(secure ? { ...(ca ? { ca } : {}), rejectUnauthorized: true } : {}),
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload,
    });
    const failed = () => { cleanup(); socket.terminate(); reject(new Error('SELF_RELAY_CONNECTION_FAILED')); };
    const opened = () => { cleanup(); socket.on('error', () => socket.terminate()); resolve(socket); };
    const cleanup = () => { socket.off('open', opened); socket.off('error', failed); socket.off('close', failed); };
    socket.once('open', opened); socket.once('error', failed); socket.once('close', failed);
  });
}

function waitForReady(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(), 10_000); timer.unref?.();
    const cleanup = () => { clearTimeout(timer); socket.off('message', ready); socket.off('close', fail); };
    const fail = () => { cleanup(); socket.terminate(); reject(new Error('SELF_RELAY_AUTHENTICATION_FAILED')); };
    const ready = (raw: WebSocket.RawData, binary: boolean) => {
      try {
        const frame = binary ? null : JSON.parse(raw.toString());
        if (frame?.type !== 'ready') { fail(); return; }
        cleanup(); resolve();
      } catch { fail(); }
    };
    socket.once('message', ready); socket.once('close', fail);
  });
}

/**
 * A local Termdock service may publish only its own stable identity to other
 * services pinned by the same Desktop installation. Desktop supplies addresses
 * and CA pins only; the service proves itself with its own Noise identity and
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
    const desired = new Map(desktopDirectTargets(this.options.desktopFile, this.options.serviceId)
      .map(target => [target.serviceId, target as SelfRelayTarget]));
    for (const [serviceId, state] of this.states) {
      const target = desired.get(serviceId);
      const signature = target && JSON.stringify([target.url, target.caFingerprint256]);
      if (!target || signature !== state.signature) {
        this.stopState(state); this.states.delete(serviceId);
      }
    }
    for (const [serviceId, target] of desired) if (!this.states.has(serviceId)) {
      const state: SelfRelayState = { signature: JSON.stringify([target.url, target.caFingerprint256]), stopped: false };
      this.states.set(serviceId, state);
      void this.run(state, target);
    }
  }

  private stopState(state: SelfRelayState): void {
    if (state.stopped) return;
    state.stopped = true; state.wake?.(); state.wake = undefined;
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
    const rpc = await connectCollaborationRpc(this.options.identity, peer);
    let selfRelayToken: string;
    try {
      const result = await rpc.request({ type: 'self-relay-ticket' });
      if (result.serviceId !== this.options.serviceId || typeof result.selfRelayToken !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/.test(result.selfRelayToken)) throw new Error('INVALID_SELF_RELAY_TICKET');
      selfRelayToken = result.selfRelayToken;
    } finally { rpc.close(); }
    if (this.stopped || state.stopped) return;

    const ca = target.caFingerprint256 ? await readPinnedCertificateAuthority(target.url, target.caFingerprint256) : undefined;
    const upstream = await openSocket(relayEndpoint(target.url, selfRelayToken), ca);
    state.upstream = upstream;
    try {
      if (this.stopped || state.stopped) return;
      await waitForReady(upstream);
      if (this.stopped || state.stopped) return;
      const client = new RelayClient(upstream, { targets: new Map([[this.options.serviceId,
        () => openSocket(secureEndpoint(this.options.localOrigin), this.options.localCa, 1024 * 1024)]]) });
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
