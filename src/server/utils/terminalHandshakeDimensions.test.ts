// @vitest-environment node
import { expect, it } from 'vitest';
import { readTerminalHandshakeDimensions } from './terminalHandshakeDimensions.js';

it('accepts the full-height phone geometry before the tmux client attaches', () => {
  expect(readTerminalHandshakeDimensions(new URLSearchParams('cols=58&rows=40')))
    .toEqual({ cols: 58, rows: 40 });
});

it.each(['', 'cols=58', 'cols=0&rows=40', 'cols=58&rows=-1',
  'cols=Infinity&rows=40', 'cols=58.5&rows=40', 'cols=58&rows=100000'])
('rejects invalid handshake geometry: %s', query => {
  expect(readTerminalHandshakeDimensions(new URLSearchParams(query))).toBeUndefined();
});
