import { afterEach, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { createBrowserTerminal, TerminalGeometry } from './geometry';

const fixtures: Array<{ terminal: Terminal; host: HTMLElement }> = [];
afterEach(() => { for (const { terminal, host } of fixtures.splice(0)) { terminal.dispose(); host.remove(); } });

it.each(['dom', 'webgl'])('uses the measured %s grid on the first visible browser frame after hidden initialization', async renderer => {
  await document.fonts.ready;
  const host = document.createElement('div');
  Object.assign(host.style, { width: '900px', height: '450px', visibility: 'hidden' });
  document.body.append(host);
  const terminal = (await createBrowserTerminal({ cols: 80, rows: 24, allowProposedApi: true, fontSize: 14, fontFamily: 'monospace' }))!;
  fixtures.push({ terminal, host });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host);
  if (renderer === 'webgl') terminal.loadAddon(new WebglAddon());
  const geometry = new TerminalGeometry(terminal, fit, host, { authority: 'viewport' });
  expect(geometry.dimensions).toBeNull();
  geometry.fit('initialize', false);
  const first = geometry.dimensions!;
  expect(first.cols).toBeGreaterThan(80);
  await new Promise<void>(resolve => terminal.write('FIRST SCREEN', resolve));
  host.style.width = '1100px';
  host.style.visibility = 'visible';
  geometry.fit('reveal', true);
  const visible = geometry.dimensions!;
  expect(visible.cols).toBeGreaterThan(first.cols);
  const screen = host.querySelector<HTMLElement>('.xterm-screen')!;
  const width = screen.offsetWidth;
  const samples: Array<{ cols: number; width: number }> = [];
  for (let n = 0; n < 3; n++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => { samples.push({ cols: terminal.cols, width: screen.offsetWidth }); resolve(); }));
  }
  expect(samples).toEqual(Array.from({ length: 3 }, () => ({ cols: visible.cols, width })));
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('FIRST SCREEN');
  expect(host.querySelector<HTMLElement>('.xterm-screen')!.offsetWidth).toBeLessThanOrEqual(1100);
});
