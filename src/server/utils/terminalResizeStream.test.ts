// @vitest-environment node
import { expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { TerminalOutputDelivery, type OutputFrame } from './terminalOutputDelivery.js';

const write = (term: Terminal, data: string) => new Promise<void>(resolve => term.write(data, resolve));
const lines = (term: Terminal) => Array.from({ length: term.rows }, (_, row) =>
  term.buffer.active.getLine(row)?.translateToString(true));

it('preserves scrolling margins and saved cursor across queued resize redraw and live output', async () => {
  const term = new Terminal({ cols: 20, rows: 4, scrollback: 0, allowProposedApi: true });
  const sent: OutputFrame[] = [];
  const delivery = new TerminalOutputDelivery(frame => sent.push(frame), true, 1, 4096);
  delivery.finishReplay(0);
  term.resize(20, 5);
  const chunks = [
    '\x1b[?2026h\x1b[2J\x1b[HHEADER\x1b[5;1HSTATUS\x1b[2;4r\x1b[2;1Hone\r\ntwo\r\nthree\x1b7',
    '\x1b[5;1HWORKING\x1b8\r\nfour',
    '\r\nfive\x1b[?2026l',
  ];
  chunks.forEach((data, seq) => delivery.enqueue({ type: 'data', data, seq: seq + 1 }));
  expect(sent).toHaveLength(1); // Other writes are genuinely waiting on consumption.
  for (let i = 0; i < chunks.length; i++) {
    // Network boundaries can split CSI and ESC sequences, too.
    for (const char of sent[i].data) await write(term, char);
    delivery.acknowledge(sent[i].flowSeq!);
  }
  expect(lines(term)).toEqual(['HEADER', 'three', 'four', 'five', 'WORKING']);
  expect(term.buffer.active.cursorY).toBe(3);
  expect(delivery.pendingBytes).toBe(0);
  term.dispose();
});
