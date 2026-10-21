import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { compressRecord, expandRecord } from './recordCompression.js';

function frame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const result = new Uint8Array(body.length + 4);
  new DataView(result.buffer).setUint32(0, body.length); result.set(body, 4);
  return result;
}
describe('compression before encryption', () => {
  it('compresses independent Unicode/ANSI terminal records losslessly', async () => {
    const value = { type: 'ws-data', id: 'terminal', data: JSON.stringify({ type: 'data', data: '\u001b[32m构建完成 ✓\u001b[0m\r\n'.repeat(4000) }) };
    const original = frame(value);
    const compressed = await compressRecord(original, value.id);
    const envelope = JSON.parse(new TextDecoder().decode(compressed.subarray(4)));
    expect(envelope).toMatchObject({ type: 'compressed', id: value.id, encoding: 'gzip' });
    expect(await expandRecord(envelope.data)).toEqual(value);
    expect(compressed.length).toBeLessThan(original.length / 10);
    console.info(`terminal record bytes before Noise: ${original.length} -> ${compressed.length}`);
  });
  it('does not delay small frames with compression or expand incompressible content', async () => {
    const small = frame({ type: 'ws-data', id: 'term', data: 'a' });
    expect(await compressRecord(small, 'term')).toBe(small);
    const entropy = frame({ type: 'ws-data', id: 'term', data: randomBytes(16 * 1024).toString('base64') });
    expect(await compressRecord(entropy, 'term')).toBe(entropy);
  });
  it('rejects corrupt gzip and stops expansion above the record budget', async () => {
    await expect(expandRecord('not base64!')).rejects.toThrow();
    await expect(expandRecord(Buffer.from('invalid gzip').toString('base64'))).rejects.toThrow();
    const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(expandRecord(bomb.toString('base64'))).rejects.toThrow('exceeds budget');
  });
});
