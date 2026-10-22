import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { FLEXOKI_DARK } from './theme';

// Exercise the actual dependency and GPU pixels, not a mocked successful refresh.
// Regression: https://github.com/xtermjs/xterm.js/issues/6038
// Private access is confined to this test: lower the atlas limits to reproduce
// real page merges/evictions quickly, then draw only the last row of terminal B.
interface Atlas {
  constructor: { maxAtlasPages: number; maxTextureSize: number };
  pages: { canvas: HTMLCanvasElement }[];
}

interface Renderer {
  _charAtlas: Atlas;
  _gl: WebGL2RenderingContext;
  dimensions: { device: { cell: { height: number }; canvas: { width: number; height: number } } };
  renderRows(start: number, end: number): void;
}

interface Fixture {
  terminal: Terminal;
  addon: WebglAddon;
  renderer: Renderer;
}

const fixtures: Fixture[] = [];
const hosts: HTMLElement[] = [];
let restoreLimits: (() => void) | undefined;
const HEADER = 'STATIC Header / 首页头部 - 一键提单';

function createTerminal(): Fixture {
  const host = document.createElement('div');
  host.style.width = '900px';
  document.body.append(host);
  hosts.push(host);
  const terminal = new Terminal({
    cols: 80,
    rows: 12,
    fontSize: 16,
    fontFamily: 'monospace',
    cursorBlink: false,
    allowProposedApi: true,
    theme: FLEXOKI_DARK,
  });
  terminal.open(host);
  const addon = new WebglAddon();
  terminal.loadAddon(addon);
  const renderer = (addon as unknown as { _renderer: Renderer })._renderer;
  expect(renderer._gl.isContextLost()).toBe(false);
  const fixture = { terminal, addon, renderer };
  fixtures.push(fixture);
  return fixture;
}

function write(fixture: Fixture, data: string): Promise<void> {
  return new Promise(resolve => fixture.terminal.write(data, resolve));
}

async function initialize(fixture: Fixture, header = HEADER): Promise<void> {
  await write(fixture, `\x1b[?25l\x1b[H${header}\x1b[12;1Htail`);
  fixture.renderer.renderRows(0, fixture.terminal.rows - 1);
}

function limitAtlas(atlas: Atlas, maxTextureSize = atlas.constructor.maxTextureSize): void {
  const type = atlas.constructor;
  const previousPages = type.maxAtlasPages;
  const previousSize = type.maxTextureSize;
  type.maxAtlasPages = 4;
  type.maxTextureSize = maxTextureSize;
  restoreLimits = () => {
    type.maxAtlasPages = previousPages;
    type.maxTextureSize = previousSize;
  };
}

function headerPixels(fixture: Fixture, partial = false): Uint8Array {
  const { renderer, terminal } = fixture;
  // readPixels must run in the same task as drawing (preserveDrawingBuffer is
  // deliberately left at its production default). A full redraw here would
  // conceal the stale coordinates bug, so the after-image updates one row only.
  renderer.renderRows(partial ? terminal.rows - 1 : 0, terminal.rows - 1);
  const gl = renderer._gl;
  expect(gl.drawingBufferWidth).toBe(renderer.dimensions.device.canvas.width);
  expect(gl.drawingBufferHeight).toBe(renderer.dimensions.device.canvas.height);
  const height = renderer.dimensions.device.cell.height;
  const pixels = new Uint8Array(gl.drawingBufferWidth * height * 4);
  gl.readPixels(0, gl.drawingBufferHeight - height, gl.drawingBufferWidth, height,
    gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  expect(gl.getError()).toBe(gl.NO_ERROR);
  return pixels;
}

function expectUnchangedHeader(fixture: Fixture, before: Uint8Array): void {
  expect(fixture.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(HEADER);
  const after = headerPixels(fixture, true);
  expect(after.length).toBe(before.length);
  // Guard against an empty/blank screenshot passing the equality assertion.
  expect(new Set(before).size).toBeGreaterThan(8);
  const changedBytes = after.reduce((count, value, index) => count + Number(value !== before[index]), 0);
  expect(changedBytes, 'unchanged buffer text must retain identical rendered glyphs').toBe(0);
}

async function churn(fixture: Fixture, batch: number): Promise<void> {
  let data = '';
  for (let row = 2; row < fixture.terminal.rows; row++) {
    data += `\x1b[${row};1H`;
    for (let col = 0; col < fixture.terminal.cols - 1; col++) {
      const index = batch * 1000 + row * 80 + col;
      // Distinct RGB foregrounds force actual atlas allocation. No newline or
      // last-column wrap can scroll the pinned header out of the buffer.
      data += `\x1b[38;2;${index % 256};${Math.floor(index / 256) % 256};127m${String.fromCharCode(33 + index % 90)}`;
    }
  }
  await write(fixture, `${data}\x1b[0m`);
  fixture.renderer.renderRows(1, fixture.terminal.rows - 1);
}

afterEach(() => {
  restoreLimits?.();
  restoreLimits = undefined;
  for (const fixture of fixtures.splice(0)) fixture.terminal.dispose();
  for (const host of hosts.splice(0)) host.remove();
});

describe('WebGL shared glyph atlas', () => {
  it('keeps another terminal intact after one owner clears the shared atlas', async () => {
    const first = createTerminal();
    const second = createTerminal();
    await initialize(first, 'Other terminal: different glyph order');
    await initialize(second);
    expect(first.renderer._charAtlas).toBe(second.renderer._charAtlas);
    const before = headerPixels(second);

    first.addon.clearTextureAtlas();
    first.renderer.renderRows(0, first.terminal.rows - 1);

    expectUnchangedHeader(second, before);
  });

  it('invalidates every owner after page merges during dense TUI output', async () => {
    const first = createTerminal();
    const second = createTerminal();
    await initialize(first);
    await initialize(second);
    const atlas = first.renderer._charAtlas;
    expect(atlas).toBe(second.renderer._charAtlas);
    limitAtlas(atlas);
    const before = headerPixels(second);
    let removedPages = 0;
    const listener = first.addon.onRemoveTextureAtlasCanvas(() => removedPages++);
    try {
      for (let batch = 0; batch < 30 && removedPages === 0; batch++) await churn(first, batch);
      expect(removedPages, 'the workload must actually merge atlas pages').toBeGreaterThan(0);
      expectUnchangedHeader(second, before);
    } finally {
      listener.dispose();
    }
  });

  it('respects texture capacity when full pages cannot be merged', async () => {
    const fixture = createTerminal();
    await initialize(fixture);
    const atlas = fixture.renderer._charAtlas;
    // A 512px hardware limit makes merging 512px pages impossible; the real
    // renderer must evict instead of growing past its allocated texture count.
    limitAtlas(atlas, 512);
    const before = headerPixels(fixture);
    let removedPages = 0;
    const listener = fixture.addon.onRemoveTextureAtlasCanvas(() => removedPages++);
    try {
      for (let batch = 0; batch < 30 && removedPages === 0; batch++) {
        await churn(fixture, batch);
        expect(atlas.pages.length, 'atlas must stay within the sampler capacity').toBeLessThanOrEqual(4);
      }
      expect(removedPages, 'the workload must actually reach atlas capacity').toBeGreaterThan(0);
      expectUnchangedHeader(fixture, before);
    } finally {
      listener.dispose();
    }
  });
});
