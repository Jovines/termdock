import { expect, it } from 'vitest';
import { VncReadOnlyFilter } from './vncReadOnly';
function connected() {
  const filter = new VncReadOnlyFilter(); filter.serverData(Buffer.from('RFB 003.008\n')); filter.clientData(Buffer.from('RFB 003.008\n')); filter.serverData(Buffer.from([1, 2])); filter.clientData(Buffer.from([2])); filter.clientData(Buffer.alloc(16)); filter.clientData(Buffer.from([1])); return filter;
}
it('drops fragmented keyboard, mouse, resize and clipboard records while retaining framebuffer requests', () => {
  const filter = connected(), key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]), mouse = Buffer.from([5, 1, 0, 20, 0, 20]), update = Buffer.from([3, 0, 0, 0, 0, 0, 0, 20, 0, 20]);
  expect(filter.clientData(key.subarray(0, 3))).toEqual([]);
  expect(Buffer.concat(filter.clientData(Buffer.concat([key.subarray(3), mouse, update])))).toEqual(update);
  const clipboard = Buffer.alloc(11); clipboard[0] = 6; clipboard.writeInt32BE(-3, 4); clipboard.write('abc', 8);
  expect(filter.clientData(clipboard)).toEqual([]);
  expect(() => filter.clientData(Buffer.from([99]))).toThrow();
});
it('bounds authentication and supports fragmented Apple Remote Desktop credentials', () => {
  const f = new VncReadOnlyFilter(); f.serverData(Buffer.from('RFB 003.889\n')); f.clientData(Buffer.from('RFB 003.008\n')); f.serverData(Buffer.from([1, 30])); f.clientData(Buffer.from([30])); f.serverData(Buffer.from([0, 2, 0, 128]));
  expect(f.clientData(Buffer.alloc(64))).toEqual([]);
  expect(Buffer.concat(f.clientData(Buffer.alloc(192)))).toHaveLength(256);
  f.clientData(Buffer.from([1])); expect(f.clientData(Buffer.from([5, 0, 0, 0, 0, 0]))).toEqual([]);
});
it('rejects unsupported security negotiation and non-shared client initialization', () => {
  const f = new VncReadOnlyFilter(); f.serverData(Buffer.from('RFB 003.008\n')); f.clientData(Buffer.from('RFB 003.008\n')); f.serverData(Buffer.from([1, 19])); expect(() => f.clientData(Buffer.from([19]))).toThrow();
});
