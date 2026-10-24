import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConnectionOptions } from 'node:tls';
import * as tls from 'node:tls';
import WebSocket from 'ws';
import { normalizeServiceAddress } from './connectionModel.js';
import { pinnedServerTlsOptions, readPinnedCertificateAuthority } from './trustedCa.js';
import { RELAY_MAX_FRAME_BYTES } from './streamLimits.js';

export interface ServiceTlsTrust {
  ca?: Buffer;
  caPath?: string;
  caFingerprint256?: string;
  certificateFingerprint256?: string;
}
interface SocketOptions {
  baseDir?: string;
  maxPayload?: number;
  handshakeTimeout?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  relayReady?: boolean;
}

/** One trust decision for probes, direct providers, reverse relays and peer RPC.
 * A pinned leaf, a pinned CA and a CA file are distinct trust modes. */
export async function serviceTlsOptions(address: string, trust: ServiceTlsTrust = {}, baseDir = process.cwd()): Promise<ConnectionOptions> {
  const origin = normalizeServiceAddress(address);
  const modes = [trust.ca, trust.caPath, trust.caFingerprint256, trust.certificateFingerprint256].filter(value => value !== undefined);
  if (modes.length > 1) throw new Error('Conflicting service certificate trust');
  if (trust.certificateFingerprint256 !== undefined) return pinnedServerTlsOptions(origin, trust.certificateFingerprint256);
  if (trust.caFingerprint256 !== undefined) return { ca: await readPinnedCertificateAuthority(origin, trust.caFingerprint256) };
  if (trust.caPath !== undefined && !trust.caPath) throw new Error('Invalid service CA path');
  if (!modes.length) {
    // Match native clients' OS-approved trust without changing process-global
    // TLS defaults. Explicit pins/CA files never inherit these additional roots.
    const getCertificates = (tls as typeof tls & { getCACertificates?: (kind: 'default' | 'system') => string[] }).getCACertificates;
    if (getCertificates) return { ca: [...new Set([...getCertificates('default'), ...getCertificates('system')])] };
  }
  return { ca: trust.caPath ? readFileSync(resolve(baseDir, trust.caPath)) : trust.ca };
}

/** Return a connecting socket, so relay listeners are installed before the
 * entry's ready frame. No business bytes are sent during TLS pin inspection. */
export async function createServiceSocket(address: string, trust: ServiceTlsTrust = {}, options: SocketOptions = {}): Promise<WebSocket> {
  const url = new URL(address);
  const origin = normalizeServiceAddress(url.origin.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'));
  if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash
    || !['/api/federation/secure', '/api/federation/relay', '/api/federation/relay-target'].includes(url.pathname)
    || [...url.searchParams.keys()].length > 1
    || [...url.searchParams.keys()].some(key => url.pathname !== '/api/federation/relay' || !['routeToken', 'selfRelayToken'].includes(key))
    || url.search && Object.keys(options.headers || {}).some(key => key.toLowerCase() === 'authorization')) throw new Error('Invalid service transport endpoint');
  const tls = await serviceTlsOptions(origin, trust, options.baseDir);
  options.signal?.throwIfAborted();
  const socket = new WebSocket(url, { ...tls, rejectUnauthorized: true, followRedirects: false, perMessageDeflate: false,
    maxPayload: options.maxPayload ?? 1024 * 1024, handshakeTimeout: options.handshakeTimeout ?? 5000,
    ...(options.headers ? { headers: options.headers } : {}) });
  const abort = () => socket.terminate();
  options.signal?.addEventListener('abort', abort, { once: true });
  socket.once('close', () => options.signal?.removeEventListener('abort', abort));
  socket.on('error', () => socket.terminate());
  return socket;
}

interface OpeningSocket {
  readyState: number;
  transportFailure?: Error;
  addEventListener(type: string, listener: (...args: any[]) => void): void;
  removeEventListener(type: string, listener: (...args: any[]) => void): void;
}
export function waitForServiceSocket(socket: OpeningSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(socket.transportFailure || new Error('Service transport unavailable')); };
    const aborted = () => { cleanup(); reject(signal?.reason); };
    if (signal?.aborted) { aborted(); return; }
    if (socket.readyState === 1) { opened(); return; }
    if (socket.readyState >= 2) { failed(); return; }
    socket.addEventListener('open', opened); socket.addEventListener('error', failed); socket.addEventListener('close', failed);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export async function openServiceSocket(address: string, trust: ServiceTlsTrust = {}, options: SocketOptions = {}): Promise<WebSocket> {
  const socket = await createServiceSocket(address, trust, options);
  // Subscribe before open: an upgrade response and ready frame can share a packet.
  const ready = options.relayReady ? relayEntryReady(socket, options.signal) : undefined;
  try {
    await waitForServiceSocket(socket, options.signal); if (ready) await ready;
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Service transport closed during handshake');
    return socket;
  }
  catch (error) { socket.terminate(); throw error; }
}

function relayEntryReady(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('message', message); socket.off('close', failed); signal?.removeEventListener('abort', aborted); };
    const failed = () => { cleanup(); reject(new Error('Relay entry handshake failed')); };
    const aborted = () => { cleanup(); reject(signal?.reason); };
    const message = (raw: WebSocket.RawData, binary: boolean) => {
      try {
        if (binary || Buffer.byteLength(Array.isArray(raw) ? Buffer.concat(raw) : raw as Buffer) > RELAY_MAX_FRAME_BYTES || JSON.parse(raw.toString())?.type !== 'ready') throw new Error('Invalid entry handshake');
        cleanup(); resolve();
      } catch { failed(); }
    };
    const timer = setTimeout(failed, 10_000);
    socket.once('message', message); socket.once('close', failed);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
  void ready.catch(() => {}); return ready;
}
