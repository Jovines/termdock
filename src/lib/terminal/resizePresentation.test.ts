// @vitest-environment jsdom
import type { Terminal } from '@xterm/xterm';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { createResizePresentation } from './resizePresentation';

function setup() {
  const model = new HeadlessTerminal({ cols: 20, rows: 4, allowProposedApi: true });
  const events: string[] = [];
  const renderer = {
    handleResize: vi.fn((cols: number, rows: number) => {
      events.push(`size:${cols}x${rows}`);
      renderer.renderRows(0, rows - 1);
    }),
    renderRows: vi.fn((_start: number, _end: number) => {
      events.push(`paint:${model.buffer.active.getLine(0)?.translateToString(true)}`);
    }),
    clear: vi.fn(() => { events.push('clear'); }),
  };
  const terminal = {
    parser: model.parser,
    get modes() { return model.modes; },
    get rows() { return model.rows; },
    _core: { _renderService: { _renderer: { value: renderer } } },
    refresh: () => renderer.renderRows(0, model.rows - 1),
  } as unknown as Terminal;
  const gate = createResizePresentation(terminal);
  const write = (data: string, generation = gate.generation) => new Promise<void>(resolve => {
    model.write(data, () => { gate.written(generation); resolve(); });
  });
  return { model, renderer, events, gate, write };
}

describe('resize presentation', () => {
  it('keeps geometry and pixels until a complete frame has been parsed across chunks', async () => {
    const { model, renderer, events, gate, write } = setup();
    await write('OLD');
    gate.begin();
    model.resize(20, 2);
    renderer.handleResize(20, 2);
    renderer.clear();
    renderer.renderRows(0, 1);
    expect(model.rows).toBe(2);
    expect(events).toEqual([]);
    await write('\x1b[?2026h\x1b[H\x1b[JNEW\x1b[?202');
    expect(events).toEqual([]);
    await write('6l');
    expect(events).toEqual(['size:20x2', 'paint:NEW', 'paint:NEW', 'paint:NEW']);
    gate.dispose(); model.dispose();
  });

  it('does not release for an in-flight write from before a newer resize', async () => {
    const { model, renderer, events, gate, write } = setup();
    gate.begin();
    const old = gate.generation;
    gate.begin();
    renderer.handleResize(30, 3);
    await write('\x1b[?2026hOLD\x1b[?2026l', old);
    expect(events).toEqual([]);
    await write('\x1b[?2026h\x1b[HNEW\x1b[?2026l');
    expect(events[0]).toBe('size:30x3');
    expect(events[1]).toBe('paint:NEW');
    gate.dispose(); model.dispose();
  });

  it('respects another synchronized frame opened in the same write', async () => {
    const { model, renderer, events, gate, write } = setup();
    gate.begin(); renderer.handleResize(20, 2);
    await write('\x1b[?2026hFIRST\x1b[?2026l\x1b[?2026h\x1b[HFINAL');
    expect(events).toEqual([]);
    await write('\x1b[?2026l');
    expect(events[1]).toBe('paint:FINAL');
    gate.dispose(); model.dispose();
  });

  it('cancels on connection or resize failure and restores the renderer methods', () => {
    const { model, renderer, events, gate } = setup();
    const original = renderer.handleResize;
    gate.begin(); renderer.handleResize(20, 2);
    gate.cancel();
    expect(renderer.handleResize).toBe(original);
    expect(events[0]).toBe('size:20x2');
    gate.begin(); renderer.handleResize(20, 3);
    const before = events.length;
    gate.dispose();
    expect(events).toHaveLength(before);
    expect(renderer.handleResize).toBe(original);
    model.dispose();
  });

  it('fails open if xterm no longer exposes the supported renderer interface', async () => {
    const model = new HeadlessTerminal({ allowProposedApi: true });
    const gate = createResizePresentation(model as unknown as Terminal);
    gate.begin();
    await new Promise<void>(resolve => model.write('\x1b[?2026l', resolve));
    expect(() => gate.written(gate.generation)).not.toThrow();
    gate.dispose(); model.dispose();
  });
});
