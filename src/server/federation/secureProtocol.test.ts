import { describe, expect, it } from 'vitest'
import { createIdentity, exportIdentity, importIdentity, secureConnection, MAX_SECURE_CONNECTION_AGE_MS, MAX_SECURE_CONNECTION_BYTES_PER_DIRECTION, type ByteDuplex, type Identity, type SecureConnectionOptions } from './secureProtocol.js'

function queue() {
  const chunks: Uint8Array[] = []
  let wake: (() => void) | undefined, done = false, failure: Error | undefined
  return {
    push(bytes: Uint8Array) { chunks.push(bytes.slice()); wake?.() },
    close(error?: Error) { done = true; failure = error; wake?.() },
    async *source() { while (true) { if (failure) throw failure; const item = chunks.shift(); if (item) yield item; else if (done) return; else await new Promise<void>(resolve => { wake = resolve }) } },
  }
}
function pair() {
  const a = queue(), b = queue()
  const captured: Uint8Array[] = []
  let transform = (chunk: Uint8Array) => [chunk]
  const close = (error?: Error) => { a.close(error); b.close(error) }
  const left: ByteDuplex = {
    source: a.source(), close,
    async sink(source) { for await (const chunk of source) { captured.push(chunk.slice()); for (const c of transform(chunk.slice())) b.push(c) } },
  }
  const right: ByteDuplex = { source: b.source(), close, async sink(source) { for await (const chunk of source) a.push(chunk) } }
  return { left, right, captured, close, transform(fn: typeof transform) { transform = fn } }
}
async function connected(existingA?: Identity, existingB?: Identity, limitsA?: SecureConnectionOptions['limits'], limitsB?: SecureConnectionOptions['limits']) {
  const identityA = existingA ?? await createIdentity(), identityB = existingB ?? await createIdentity()
  const wire = pair()
  const [a, b] = await Promise.all([
    secureConnection({ identity: identityA, duplex: wire.left, initiator: true, targetPinnedPeerId: identityB.peerId, signal: AbortSignal.timeout(5000), limits: limitsA }),
    secureConnection({ identity: identityB, duplex: wire.right, initiator: false, signal: AbortSignal.timeout(5000), limits: limitsB }),
  ])
  return { a, b, wire, identityA, identityB }
}
async function* bytes(value: Uint8Array) { yield value }
const text = new TextEncoder()

describe('Noise end-to-end transport', () => {
  it('round trips identities and rejects unsupported encodings', async () => {
    const identity = await createIdentity()
    expect(importIdentity(exportIdentity(identity)).peerId).toBe(identity.peerId)
    expect(() => importIdentity('not a private key')).toThrow()
  })
  it('authenticates both endpoints, encrypts and chunks large payloads', async () => {
    const { a, b, wire, identityA, identityB } = await connected()
    expect(a.authenticatedPeerId).toBe(identityB.peerId)
    expect(b.authenticatedPeerId).toBe(identityA.peerId)
    const payload = text.encode('confidential-terminal-content:'.repeat(5000))
    const iterator = b.duplex.source[Symbol.asyncIterator]()
    const sending = a.duplex.sink(bytes(payload))
    let received = 0
    while (received < payload.length) {
      const next = await iterator.next()
      expect(next.done).toBe(false)
      expect(next.value).toEqual(payload.slice(received, received + next.value!.length))
      received += next.value!.length
    }
    await sending
    expect(wire.captured.every(chunk => !new TextDecoder().decode(chunk).includes('confidential-terminal-content'))).toBe(true)
    wire.close()
  })
  it('rejects missing pins and an impersonated target', async () => {
    const trusted = await createIdentity(), attacker = await createIdentity(), client = await createIdentity(), wire = pair()
    await expect(secureConnection({ identity: client, duplex: wire.left, initiator: true })).rejects.toThrow('pinned')
    const results = await Promise.allSettled([
      secureConnection({ identity: client, duplex: wire.left, initiator: true, targetPinnedPeerId: trusted.peerId }),
      secureConnection({ identity: attacker, duplex: wire.right, initiator: false }),
    ])
    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected'])
  })
  it('fails closed on tampered ciphertext', async () => {
    const { a, b, wire } = await connected()
    wire.transform(chunk => { chunk[chunk.length - 1] ^= 1; return [chunk] })
    const receive = b.duplex.source[Symbol.asyncIterator]().next()
    const rejection = expect(receive).rejects.toThrow()
    await a.duplex.sink(bytes(text.encode('sensitive command'))).catch(() => {})
    await rejection
    wire.close()
  })
  it('rejects replayed records in the same connection', async () => {
    const { a, b, wire } = await connected()
    wire.transform(chunk => [chunk, chunk.slice()])
    const receiving = (async () => { for await (const _ of b.duplex.source) { /* consume until authentication failure */ } })()
    const rejection = expect(receiving).rejects.toThrow()
    await a.duplex.sink(bytes(text.encode('run once'))).catch(() => {})
    await rejection
    wire.close()
  })
  it('rejects old ciphertext after a fresh handshake', async () => {
    const first = await connected()
    await first.a.duplex.sink(bytes(text.encode('old encrypted command')))
    const oldFrame = first.wire.captured.at(-1)!.slice()
    first.wire.close()
    const second = await connected(first.identityA, first.identityB)
    second.wire.transform(() => [oldFrame])
    const rejection = expect(second.b.duplex.source[Symbol.asyncIterator]().next()).rejects.toThrow()
    await second.a.duplex.sink(bytes(text.encode('new command'))).catch(() => {})
    await rejection
    second.wire.close()
  })
  it('treats the caller abort signal as handshake-only after successful establishment', async () => {
    const identityA = await createIdentity(), identityB = await createIdentity(), wire = pair(), controller = new AbortController()
    const [a, b] = await Promise.all([
      secureConnection({ identity: identityA, duplex: wire.left, initiator: true, targetPinnedPeerId: identityB.peerId, signal: controller.signal }),
      secureConnection({ identity: identityB, duplex: wire.right, initiator: false }),
    ])
    controller.abort(new Error('Handshake deadline expired after success'))
    const received = b.duplex.source[Symbol.asyncIterator]().next()
    await a.duplex.sink(bytes(text.encode('still connected')))
    expect((await received).value).toEqual(text.encode('still connected'))
    wire.close()
  })
  it('closes an idle channel at its key lifetime and requires a new handshake', async () => {
    const { a, wire } = await connected(undefined, undefined, { maxAgeMs: 35 })
    await expect(a.duplex.source[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'E2EE_REHANDSHAKE_REQUIRED' })
    await expect(a.duplex.sink(bytes(text.encode('do not replay this input')))).rejects.toMatchObject({ code: 'E2EE_REHANDSHAKE_REQUIRED' })
    wire.close()
  })
  it('counts cumulative outbound bytes and rejects the whole next chunk before the ceiling', async () => {
    const { a, b, wire } = await connected(undefined, undefined, { maxBytesPerDirection: 12 })
    const next = b.duplex.source[Symbol.asyncIterator]().next()
    const sending = a.duplex.sink((async function* () {
      yield text.encode('1234567')
      expect((await next).value).toEqual(text.encode('1234567'))
      yield text.encode('89012') // The whole five-byte command must be rejected, not partially transmitted.
    })())
    await expect(sending).rejects.toMatchObject({ code: 'E2EE_REHANDSHAKE_REQUIRED' })
    wire.close()
  })
  it('enforces its own inbound ceiling even when the other endpoint has a larger budget', async () => {
    const { a, b, wire } = await connected(undefined, undefined, undefined, { maxBytesPerDirection: 12 })
    const rejection = expect(b.duplex.source[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'E2EE_REHANDSHAKE_REQUIRED' })
    await a.duplex.sink(bytes(text.encode('123456789012'))).catch(() => {})
    await rejection
    wire.close()
  })
  it('never allows caller configuration to disable or expand production limits', async () => {
    const identity = await createIdentity()
    for (const limits of [{ maxAgeMs: 0 }, { maxAgeMs: Infinity }, { maxAgeMs: MAX_SECURE_CONNECTION_AGE_MS + 1 },
      { maxBytesPerDirection: MAX_SECURE_CONNECTION_BYTES_PER_DIRECTION + 1 }, { maxBytesPerDirection: -1 }]) {
      const wire = pair()
      await expect(secureConnection({ identity, duplex: wire.left, initiator: true, targetPinnedPeerId: identity.peerId, limits })).rejects.toThrow('production maximum')
      wire.close()
    }
  })
})
