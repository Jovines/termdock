import { describe, expect, it } from 'vitest';
import { HYSTERESIS_THRESHOLD, decideFitHysteresis } from './fitHysteresis';

describe('decideFitHysteresis', () => {
  const SIZE = { currentCols: 80, currentRows: 24 };

  describe('non-real-resize reasons (page-flip, visibility, focus, blur, …)', () => {
    const subPixelReasons = ['page-flip', 'visibility', 'bfcache', 'online', 'focus', 'blur', 'clear', 'webgl-context-loss'];

    for (const reason of subPixelReasons) {
      it(`rejects ±0 (no change) for ${reason}`, () => {
        const d = decideFitHysteresis({ ...SIZE, reason, proposedCols: 80, proposedRows: 24 });
        expect(d.accept).toBe(false);
        expect(d.isRealResize).toBe(false);
      });

      it(`rejects cols ±1 for ${reason} (亚像素噪声)`, () => {
        const drop = decideFitHysteresis({ ...SIZE, reason, proposedCols: 79, proposedRows: 24 });
        const grow = decideFitHysteresis({ ...SIZE, reason, proposedCols: 81, proposedRows: 24 });
        expect(drop.accept).toBe(false);
        expect(grow.accept).toBe(false);
      });

      it(`rejects rows ±1 for ${reason}`, () => {
        const drop = decideFitHysteresis({ ...SIZE, reason, proposedCols: 80, proposedRows: 23 });
        const grow = decideFitHysteresis({ ...SIZE, reason, proposedCols: 80, proposedRows: 25 });
        expect(drop.accept).toBe(false);
        expect(grow.accept).toBe(false);
      });

      it(`accepts cols ≥${HYSTERESIS_THRESHOLD} for ${reason}`, () => {
        const d = decideFitHysteresis({ ...SIZE, reason, proposedCols: 80 - HYSTERESIS_THRESHOLD, proposedRows: 24 });
        expect(d.accept).toBe(true);
        expect(d.colsDelta).toBe(HYSTERESIS_THRESHOLD);
      });

      it(`accepts rows ≥${HYSTERESIS_THRESHOLD} for ${reason}`, () => {
        const d = decideFitHysteresis({ ...SIZE, reason, proposedCols: 80, proposedRows: 24 + HYSTERESIS_THRESHOLD });
        expect(d.accept).toBe(true);
        expect(d.rowsDelta).toBe(HYSTERESIS_THRESHOLD);
      });

      it(`accepts even ±1 if both axes drift simultaneously (cols±1 + rows±1) is still suppressed`, () => {
        // 双轴各 ±1 仍被吃掉：两边都没到 threshold，并不能因为"看起来变化更大"就放行
        const d = decideFitHysteresis({ ...SIZE, reason, proposedCols: 79, proposedRows: 23 });
        expect(d.accept).toBe(false);
      });
    }
  });

  describe('real-resize reasons (resize, dpr-change, mount, …)', () => {
    const realReasons = ['mount', 'init-fit', 'resize', 'dpr-change', 'session-key-change', 'session-reset', 'tmux-layout'];

    for (const reason of realReasons) {
      it(`rejects ±0 (no change) for ${reason} (没变就不必动)`, () => {
        const d = decideFitHysteresis({ ...SIZE, reason, proposedCols: 80, proposedRows: 24 });
        expect(d.accept).toBe(false);
        expect(d.isRealResize).toBe(true);
      });

      it(`accepts cols ±1 for ${reason}`, () => {
        const drop = decideFitHysteresis({ ...SIZE, reason, proposedCols: 79, proposedRows: 24 });
        const grow = decideFitHysteresis({ ...SIZE, reason, proposedCols: 81, proposedRows: 24 });
        expect(drop.accept).toBe(true);
        expect(grow.accept).toBe(true);
      });

      it(`accepts rows ±1 for ${reason}`, () => {
        const d = decideFitHysteresis({ ...SIZE, reason, proposedCols: 80, proposedRows: 25 });
        expect(d.accept).toBe(true);
      });

      it(`accepts huge delta for ${reason}`, () => {
        const d = decideFitHysteresis({ ...SIZE, reason, proposedCols: 120, proposedRows: 40 });
        expect(d.accept).toBe(true);
        expect(d.colsDelta).toBe(40);
        expect(d.rowsDelta).toBe(16);
      });
    }
  });

  describe('refresh:<reason> prefix handling', () => {
    it('strips refresh: prefix before whitelist lookup', () => {
      const d = decideFitHysteresis({
        ...SIZE,
        reason: 'refresh:resize',
        proposedCols: 81,
        proposedRows: 24,
      });
      expect(d.accept).toBe(true);
      expect(d.isRealResize).toBe(true);
    });

    it('rejects refresh:page-flip ±1', () => {
      const d = decideFitHysteresis({
        ...SIZE,
        reason: 'refresh:page-flip',
        proposedCols: 81,
        proposedRows: 24,
      });
      expect(d.accept).toBe(false);
      expect(d.isRealResize).toBe(false);
    });
  });

  describe('unknown reasons fall through to hysteresis', () => {
    it('unknown reason ±1 rejected', () => {
      const d = decideFitHysteresis({
        ...SIZE,
        reason: 'something-i-just-invented',
        proposedCols: 81,
        proposedRows: 24,
      });
      expect(d.accept).toBe(false);
      expect(d.isRealResize).toBe(false);
    });

    it('unknown reason ±2 accepted', () => {
      const d = decideFitHysteresis({
        ...SIZE,
        reason: 'something-i-just-invented',
        proposedCols: 82,
        proposedRows: 24,
      });
      expect(d.accept).toBe(true);
    });
  });

  describe('delta math', () => {
    it('reports absolute deltas not signed', () => {
      const a = decideFitHysteresis({ ...SIZE, reason: 'resize', proposedCols: 78, proposedRows: 22 });
      const b = decideFitHysteresis({ ...SIZE, reason: 'resize', proposedCols: 82, proposedRows: 26 });
      expect(a.colsDelta).toBe(2);
      expect(a.rowsDelta).toBe(2);
      expect(b.colsDelta).toBe(2);
      expect(b.rowsDelta).toBe(2);
    });
  });
});
