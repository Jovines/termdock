// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { TmuxDisplayGeometry } from './tmuxDisplayGeometry.js';
import type { TerminalClientAttachment } from './terminalClientAttachment.js';

function fixture(measured = true) {
  let clients = '1 /dev/observer ignore-size\n';
  const order: string[] = [];
  const observer = { cols: 80, rows: 24, ptyProcess: { pid: 1, resize: vi.fn(() => { order.push('observer'); }) } };
  const display = { pid: 2, attached: true, resize: vi.fn(() => { order.push('display'); return true; }) };
  let externalSize: { cols: number; rows: number } | undefined;
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'list-clients') return clients;
    if (args[0] === 'display-message') { const size = externalSize ?? observer; return `${size.cols} ${size.rows} off`; }
    order.push('ownership'); return '';
  });
  const geometry = new TmuxDisplayGeometry(observer, run, 'work', () => new Set([2]), measured ? { cols: 120, rows: 40 } : undefined);
  return { geometry, observer, display: display as unknown as TerminalClientAttachment, run, order,
    clients: (value: string) => { clients = value; }, serverSize: (value: typeof externalSize) => { externalSize = value; } };
}

it('prepares a replacement display at measured size before any output is attached', async () => {
  const f = fixture();
  await f.geometry.prepareAttach({ cols: 120, rows: 40 }, true);
  expect(f.observer).toMatchObject({ cols: 120, rows: 40 });
  expect(f.observer.ptyProcess.resize).toHaveBeenCalledExactlyOnceWith(120, 40);
});

it('cannot overwrite another display owner or elect an unmeasured background viewer', async () => {
  const owned = fixture(); owned.clients('1 /dev/observer ignore-size\n2 /dev/display attached\n');
  await owned.geometry.prepareAttach({ cols: 120, rows: 40 }, true);
  expect(owned.observer.cols).toBe(80);
  const passive = fixture(false);
  await passive.geometry.prepareAttach({ cols: 120, rows: 40 }, true);
  expect(passive.observer.cols).toBe(80);
});

it('resizes display and fallback together but never redraws an unchanged grid', async () => {
  const f = fixture(); f.clients('1 /dev/observer ignore-size\n2 /dev/display ignore-size\n');
  expect(await f.geometry.resize(f.display, { cols: 120, rows: 40 }, true)).toMatchObject({ ok: true, redraw: false });
  f.order.length = 0;
  expect(await f.geometry.resize(f.display, { cols: 140, rows: 45 }, true)).toEqual({ ok: true, cols: 140, rows: 45, redraw: false, changed: true });
  expect(f.order).toEqual(['ownership', 'display', 'observer']);
  expect(f.observer).toMatchObject({ cols: 140, rows: 45 });
  f.order.length = 0;
  expect(await f.geometry.resize(f.display, { cols: 140, rows: 45 }, true)).toMatchObject({ redraw: false, changed: false });
  expect(f.order).toEqual([]);
});

it('checks the live tmux window before suppressing a same-display resize after another client took over', async () => {
  const f = fixture();
  f.clients('1 /dev/observer ignore-size\n2 /dev/display ignore-size\n');
  f.serverSize({ cols: 60, rows: 20 });
  expect(await f.geometry.readServerSize()).toEqual({ cols: 60, rows: 20 });
  expect(await f.geometry.resize(f.display, { cols: 120, rows: 40 }, true)).toMatchObject({ ok: true, changed: true });
  expect(f.order).toContain('ownership');
  expect(f.display.resize).not.toHaveBeenCalled();
});

it('does not retain failed or invalid display resizes as real geometry', async () => {
  const f = fixture();
  vi.mocked(f.display.resize).mockReturnValue(false);
  expect(await f.geometry.resize(f.display, { cols: 140, rows: 45 }, false)).toMatchObject({ ok: false, cols: 120, rows: 40 });
  expect(await f.geometry.resize(f.display, { cols: NaN, rows: 45 }, false)).toMatchObject({ ok: false });
  expect(f.observer.ptyProcess.resize).not.toHaveBeenCalled();
});
