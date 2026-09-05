// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureReferenceCanvas, formatReviewReference } from './reviewReference';

afterEach(() => vi.restoreAllMocks());
describe('review snapshot capture', () => {
  it('inserts only location, optional comment and snapshot path', () => {
    expect(formatReviewReference('/repo/model.glb\n底壳 · 点 (1,2,3)', '', '2026-09-05T15:14:14Z', '/tmp/view.png'))
      .toBe('/repo/model.glb\n底壳 · 点 (1,2,3)\n截图：/tmp/view.png');
  });
  it('rasterizes small vector previews at readable resolution and marks the selected point', async () => {
    const source = document.createElement('img');
    Object.defineProperties(source, { naturalWidth: { value: 150 }, naturalHeight: { value: 100 } });
    const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const png = new Blob(['snapshot'], { type: 'image/png' });
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) { callback(png); });
    expect(await captureReferenceCanvas(source, { xPercent: 50, yPercent: 50 })).toBe(png);
    expect(ctx.drawImage).toHaveBeenCalledWith(source, 0, 0, 1400, 933);
    expect(ctx.arc.mock.calls[0].slice(0, 2)).toEqual([700, 466.5]);
    expect(encode).toHaveBeenCalledOnce();
  });
  it('degrades safely when image loading or canvas access fails', async () => {
    expect(await captureReferenceCanvas(document.createElement('img'))).toBe(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => { throw new Error('unavailable'); });
    expect(await captureReferenceCanvas(document.createElement('canvas'))).toBe(null);
  });
  it('bakes exploded-state provenance into a wrapped snapshot caption', async () => {
    const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(), measureText: (s: string) => ({ width: s.length * 7 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['png'])));
    const source = document.createElement('canvas'); source.width = 320; source.height = 600;
    const caption = 'Exploded Y 65% (display only; coordinates remain assembled)';
    expect(await captureReferenceCanvas(source, undefined, caption)).toBeInstanceOf(Blob);
    expect(ctx.fillText.mock.calls.map((call) => call[0]).join(' ')).toBe(caption);
    expect(ctx.fillText.mock.calls.length).toBeGreaterThan(1);
  });
});
