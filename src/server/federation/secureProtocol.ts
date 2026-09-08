/** End-to-end byte transport. Cryptographic handshake and records are owned by noise-libp2p. */
import { noise, pureJsCrypto } from '@chainsafe/libp2p-noise'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id'
import { AbstractMessageStream } from '@libp2p/utils'
import type { Logger, PrivateKey, Upgrader, MessageStream } from '@libp2p/interface'

export const SECURE_PROTOCOL = 'termdock-e2ee-v1'
export const MAX_SECURE_CONNECTION_AGE_MS = 60 * 60 * 1000
export const MAX_SECURE_CONNECTION_BYTES_PER_DIRECTION = 512 * 1024 * 1024
const MAX_BUFFER_BYTES = 4 * 1024 * 1024
const noop = () => {}
const silentLogger: Logger = Object.assign(noop, {
  enabled: false, error: noop, trace: noop, newScope: (): Logger => silentLogger,
})
Object.freeze(silentLogger)

export interface ByteDuplex {
  source: AsyncIterable<Uint8Array>
  /** Called once per connection, consumes bytes in order and honors transport backpressure. */
  sink(source: AsyncIterable<Uint8Array>): Promise<void>
  close?(error?: Error): void
}
export interface Identity { readonly peerId: string; readonly privateKey: PrivateKey }
export async function createIdentity(): Promise<Identity> {
  const privateKey = await generateKeyPair('Ed25519')
  return { privateKey, peerId: peerIdFromPublicKey(privateKey.publicKey).toString() }
}
/** Contains a private key. Store with device-private permissions, never include in pairing URLs. */
export function exportIdentity(identity: Identity): string {
  return btoa(String.fromCharCode(...privateKeyToProtobuf(identity.privateKey)))
}
export function importIdentity(serialized: string): Identity {
  if (serialized.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(serialized)) throw new Error('Invalid identity encoding')
  const privateKey = privateKeyFromProtobuf(Uint8Array.from(atob(serialized), c => c.charCodeAt(0)))
  if (privateKey.type !== 'Ed25519') throw new Error('Only Ed25519 device identities are supported')
  return { privateKey, peerId: peerIdFromPublicKey(privateKey.publicKey).toString() }
}

/** Bounded bridge, not a cryptographic record layer. */
class ByteQueue implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = []
  private size = 0
  private ended = false
  private error?: Error
  private wake?: () => void
  constructor(private consumed: () => void = noop) {}
  push(bytes: Uint8Array): void {
    if (this.ended) throw this.error ?? new Error('Byte stream closed')
    if (this.size + bytes.byteLength > MAX_BUFFER_BYTES) throw new Error('Secure stream buffer limit exceeded')
    this.chunks.push(bytes.slice())
    this.size += bytes.byteLength
    this.wake?.()
  }
  end(error?: Error): void { this.ended = true; this.error ??= error; this.wake?.() }
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    while (true) {
      if (this.error) throw this.error
      const chunk = this.chunks.shift()
      if (chunk) {
        this.size -= chunk.byteLength
        yield chunk
        this.consumed()
      } else if (this.ended) return
      else await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}

class TransportStream extends AbstractMessageStream {
  private readonly outgoing = new ByteQueue(() => this.onMuxerDrain())
  private readonly finished: Promise<void>
  constructor(private readonly duplex: ByteDuplex, initiator: boolean) {
    super({ log: silentLogger, direction: initiator ? 'outbound' : 'inbound', maxReadBufferLength: MAX_BUFFER_BYTES, maxWriteBufferLength: MAX_BUFFER_BYTES })
    this.finished = duplex.sink(this.outgoing).catch(error => { this.abort(asError(error)) })
    void this.readTransport()
  }
  private async readTransport(): Promise<void> {
    try {
      for await (const bytes of this.duplex.source) this.onData(bytes.slice())
      this.onTransportClosed()
    } catch (error) { this.onTransportClosed(asError(error)) }
  }
  sendData(data: Parameters<AbstractMessageStream['sendData']>[0]) {
    this.outgoing.push(data.subarray())
    return { sentBytes: data.byteLength, canSendMore: false }
  }
  sendReset(error: Error): void { this.outgoing.end(error); this.duplex.close?.(error) }
  sendPause(): void {}
  sendResume(): void {}
  async close(): Promise<void> {
    this.outgoing.end()
    this.duplex.close?.()
    this.onTransportClosed()
    await this.finished
  }
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error('Secure transport failed') }

export interface SecureConnectionOptions {
  identity: Identity
  duplex: ByteDuplex
  initiator: boolean
  /** Mandatory for initiators. Obtain independently of the untrusted relay/HTTPS path. */
  targetPinnedPeerId?: string
  /** Cancels the handshake; close the returned duplex to terminate an established channel. */
  signal?: AbortSignal
  /** Optional stricter limits (e.g. tests); cannot increase the production ceiling. */
  limits?: { maxAgeMs?: number; maxBytesPerDirection?: number }
}
export interface SecureConnection {
  authenticatedPeerId: string
  duplex: ByteDuplex
}
export class SecureConnectionExpiredError extends Error {
  readonly code = 'E2EE_REHANDSHAKE_REQUIRED'
  constructor() { super('Encrypted connection lifetime reached; establish a new handshake without replaying pending input') }
}
function connectionLimits(limits: SecureConnectionOptions['limits']) {
  const maxAgeMs = limits?.maxAgeMs ?? MAX_SECURE_CONNECTION_AGE_MS
  const maxBytesPerDirection = limits?.maxBytesPerDirection ?? MAX_SECURE_CONNECTION_BYTES_PER_DIRECTION
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > MAX_SECURE_CONNECTION_AGE_MS
    || !Number.isSafeInteger(maxBytesPerDirection) || maxBytesPerDirection <= 0 || maxBytesPerDirection > MAX_SECURE_CONNECTION_BYTES_PER_DIRECTION) {
    throw new Error('Encrypted connection limits cannot exceed the production maximum')
  }
  return { maxAgeMs, maxBytesPerDirection }
}
export async function secureConnection(options: SecureConnectionOptions): Promise<SecureConnection> {
  const { identity, duplex, initiator, targetPinnedPeerId, signal } = options
  const limits = connectionLimits(options.limits)
  if (typeof Reflect.get(Promise, 'withResolvers') !== 'function' || typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('End-to-end encryption requires Node.js 22+ or a modern browser with Promise.withResolvers and secure random support')
  }
  if (initiator && !targetPinnedPeerId) throw new Error('A pinned target identity is required')
  const remotePeer = targetPinnedPeerId ? peerIdFromString(targetPinnedPeerId) : undefined
  if (remotePeer && remotePeer.type !== 'Ed25519') throw new Error('Only Ed25519 target identities are supported')
  if (identity.peerId !== peerIdFromPublicKey(identity.privateKey.publicKey).toString()) throw new Error('Local identity mismatch')
  if (signal?.aborted) throw signal.reason ?? new Error('Connection aborted')
  const transport = new TransportStream(duplex, initiator)
  const handshake = new AbortController()
  const timeout = setTimeout(() => {
    const error = new Error('Encrypted handshake timed out')
    handshake.abort(error)
    transport.abort(error)
  }, 15_000)
  const abort = () => { handshake.abort(signal?.reason); transport.abort(asError(signal?.reason)) }
  signal?.addEventListener('abort', abort, { once: true })
  transport.addEventListener('close', () => signal?.removeEventListener('abort', abort), { once: true })
  const encrypter = noise({ crypto: pureJsCrypto, prologueBytes: new TextEncoder().encode(SECURE_PROTOCOL) })({
    privateKey: identity.privateKey,
    peerId: peerIdFromPublicKey(identity.privateKey.publicKey),
    logger: { forComponent: () => silentLogger },
    // Only getStreamMuxers is needed, and negotiation is explicitly disabled.
    upgrader: { getStreamMuxers: () => new Map() } as Upgrader,
  })
  try {
    const secured = await (initiator ? encrypter.secureOutbound(transport, { remotePeer, signal: handshake.signal, skipStreamMuxerNegotiation: true })
      : encrypter.secureInbound(transport, { remotePeer, signal: handshake.signal, skipStreamMuxerNegotiation: true }))
    if (secured.remotePeer.type !== 'Ed25519') throw new Error('Unsupported remote identity')
    return { authenticatedPeerId: secured.remotePeer.toString(), duplex: plaintextDuplex(secured.connection, limits) }
  } catch (error) { transport.abort(asError(error)); throw error }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}
function plaintextDuplex(stream: MessageStream, limits: ReturnType<typeof connectionLimits>): ByteDuplex {
  const incoming = new ByteQueue()
  const establishedAt = performance.now(), establishedWallTime = Date.now()
  let sentBytes = 0, receivedBytes = 0, expiredError: SecureConnectionExpiredError | undefined
  const expire = () => {
    expiredError ??= new SecureConnectionExpiredError()
    incoming.end(expiredError)
    stream.abort(expiredError)
    return expiredError
  }
  const lifetime = setTimeout(expire, limits.maxAgeMs)
  if (typeof lifetime === 'object') lifetime.unref?.()
  const checkLimit = (alreadyTransferred: number, nextBytes: number) => {
    if (expiredError) throw expiredError
    // Check on traffic as well as the timer: a suspended PWA must not resume
    // using an expired session key before its delayed timer gets a turn.
    const age = Math.max(performance.now() - establishedAt, Date.now() - establishedWallTime)
    if (age >= limits.maxAgeMs || alreadyTransferred + nextBytes >= limits.maxBytesPerDirection) throw expire()
  }
  stream.addEventListener('message', event => {
    try {
      checkLimit(receivedBytes, event.data.byteLength)
      receivedBytes += event.data.byteLength
      incoming.push(event.data.subarray())
    } catch (error) { stream.abort(asError(error)) }
  })
  stream.addEventListener('close', event => { clearTimeout(lifetime); incoming.end(event.error) }, { once: true })
  let writing = false
  return {
    source: incoming,
    async sink(source) {
      if (writing) throw new Error('Secure sink already consumed')
      writing = true
      try {
        for await (const chunk of source) {
          checkLimit(sentBytes, chunk.byteLength)
          sentBytes += chunk.byteLength
          if (!stream.send(chunk)) await stream.onDrain()
        }
      } catch (error) { stream.abort(asError(error)); throw error }
    },
    close(error) { if (error) stream.abort(error); else void stream.close() },
  }
}
