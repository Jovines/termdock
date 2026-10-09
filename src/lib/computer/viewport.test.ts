import { expect, it } from 'vitest';
import { computerDesktopSize } from './viewport';
it('uses a portrait remote desktop from the first mobile handshake and bounds large desktops', () => {
  expect(computerDesktopSize(390, 744)).toEqual({ width: 640, height: 1221 });
  expect(computerDesktopSize(1920, 980)).toEqual({ width: 1920, height: 980 });
  expect(computerDesktopSize(4000, 2200)).toEqual({ width: 2560, height: 1600 });
});
