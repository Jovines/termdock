import { expect, it } from 'vitest';
import { RelayTransport } from './relayTransport.js';
import { RelaySocket } from '../../lib/federation/relaySocket.js';
import { RELAY_MAX_BUFFERED_BYTES, RELAY_MAX_FRAME_BYTES } from './streamLimits.js';

class Wire extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }
  receive(frame: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
}

it.each([RelayTransport, RelaySocket])('%s applies the same relay state, access failures and byte budgets', Transport => {
  const wire = new Wire();
  const socket = new Transport('wss://b.example/api/federation/relay', 'A', () => wire, { entryServiceId: 'B', entryUrl: 'https://b.example' });
  const states: string[] = [], output: ArrayBuffer[] = [];
  socket.addEventListener('open', () => states.push('open'));
  socket.addEventListener('message', event => output.push((event as MessageEvent).data));
  wire.receive({ type: 'ready' });
  expect(wire.sent).toMatchObject([{ type: 'open', serviceId: 'A' }]);
  const streamId = wire.sent[0].streamId;
  wire.receive({ type: 'opened', streamId });
  wire.receive({ type: 'data', streamId, encoding: 'base64', payload: 'cHJpdmF0ZQ==' });
  expect(states).toEqual(['open']); expect(new TextDecoder().decode(output[0])).toBe('private');
  socket.send(new TextEncoder().encode('ciphertext'));
  expect(wire.sent.at(-1)).toMatchObject({ type: 'data', streamId, encoding: 'base64' });
  const sends = wire.sent.length;
  wire.receive({ type: 'close', streamId, code: 'RELAY_AUTHORIZATION_REQUIRED' });
  expect(socket.transportFailure).toMatchObject({ code: 'RELAY_AUTHORIZATION_REQUIRED', context: { targetServiceId: 'A', entryServiceId: 'B' } });
  expect(socket.readyState).toBe(3);
  wire.receive({ type: 'opened', streamId });
  expect(() => socket.send(new Uint8Array(1))).toThrow(); expect(wire.sent).toHaveLength(sends);

  for (const frame of [{ type: 'ready' }, { type: 'data', encoding: 'base64', payload: '*invalid*' }]) {
    const bad = new Wire(), client = new Transport('wss://b.example/api/federation/relay', 'A', () => bad);
    bad.receive({ type: 'ready' });
    bad.receive({ ...frame, streamId: bad.sent[0].streamId });
    expect(client.readyState).toBe(3);
  }
  const congested = new Wire(), limited = new Transport('wss://b.example/api/federation/relay', 'A', () => congested);
  congested.receive({ type: 'ready' }); congested.receive({ type: 'opened', streamId: congested.sent[0].streamId });
  congested.bufferedAmount = RELAY_MAX_BUFFERED_BYTES;
  expect(() => limited.send(new Uint8Array(1))).toThrow(); expect(limited.readyState).toBe(3);
  const oversized = new Wire(), bounded = new Transport('wss://b.example/api/federation/relay', 'A', () => oversized);
  oversized.receive({ type: 'ready' }); oversized.receive({ type: 'opened', streamId: oversized.sent[0].streamId });
  expect(() => bounded.send(new Uint8Array(RELAY_MAX_FRAME_BYTES))).toThrow(); expect(bounded.readyState).toBe(3);
  expect(() => new Transport('wss://b.example/api/federation/relay', 'B', () => new Wire(), { entryServiceId: 'B' })).toThrow();
});
