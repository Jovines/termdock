import { describe, expect, it } from 'vitest';
import {
  supportsDesktopServiceActivity,
  type TermdockDesktopBridge,
} from './nativeBridge';

describe('desktop bridge capability compatibility', () => {
  it('keeps older desktop shells valid while disabling newer service activity UI', () => {
    const legacyBridge = {
      platform: 'darwin',
      snapshot: async () => ({}),
      installCli: async () => ({}),
      showConnectionCenter: async () => undefined,
      revealDataDirectory: async () => undefined,
      showNotification: async () => true,
      onNativeFileDrop: () => undefined,
    } as unknown as TermdockDesktopBridge;

    expect(supportsDesktopServiceActivity(legacyBridge)).toBe(false);
  });

  it('enables service activity only when the complete capability is present', () => {
    const currentBridge = {
      reportServiceActivity: () => undefined,
      focusService: async () => true,
      onServiceActivity: () => () => undefined,
    } as unknown as TermdockDesktopBridge;

    expect(supportsDesktopServiceActivity(currentBridge)).toBe(true);
    expect(supportsDesktopServiceActivity({
      ...currentBridge,
      focusService: undefined,
    })).toBe(false);
  });
});
