import fs from 'fs';
import path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { fakeHome } = vi.hoisted(() => ({ fakeHome: `/tmp/termdock-android-settings-${process.pid}-${Date.now()}` }));
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome } };
});

import { getAndroidPanelSetting, loadSettingsFile, normalizeAndroidPanel, setAndroidPanelSetting } from './settings';

afterAll(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

describe('per-session Android choices', () => {
  it('merges independent session writes and retains them across file reloads and unrelated settings changes', () => {
    const first = { deviceSerial: '[fd00::2]:5555', devicePhysicalId: 'a'.repeat(64) };
    const second = { deviceSerial: 'other-phone', devicePhysicalId: 'b'.repeat(64) };
    setAndroidPanelSetting({ sessionDevices: { s1: first } });
    setAndroidPanelSetting({ sessionDevices: { s2: second } });
    setAndroidPanelSetting({ enabled: true });
    expect(loadSettingsFile(path.join(fakeHome, '.termdock', 'settings.json')).androidPanel.sessionDevices)
      .toEqual({ s1: first, s2: second });
    setAndroidPanelSetting({ sessionDevices: { s1: { ...first, deviceSerial: '10.0.0.2:5555' } } });
    expect(getAndroidPanelSetting().sessionDevices).toEqual({
      s1: { ...first, deviceSerial: '10.0.0.2:5555' }, s2: second,
    });
    // Old clients may still update the global choice without erasing session choices.
    setAndroidPanelSetting({ deviceSerial: 'legacy-phone' });
    expect(getAndroidPanelSetting().sessionDevices?.s2).toEqual(second);
  });

  it('validates session keys and device identities before persistence', () => {
    expect(normalizeAndroidPanel({ sessionDevices: JSON.parse(JSON.stringify({
      s1: { deviceSerial: '[fd00::2]:5555', devicePhysicalId: 'a'.repeat(64) },
      s2: { deviceSerial: '10.0.0.2:99999', devicePhysicalId: 'bad-id' },
      '../invalid': { deviceSerial: 'other-phone' },
      constructor: { deviceSerial: 'other-phone' },
      malformed: [],
    })) }).sessionDevices).toEqual({
      s1: { deviceSerial: '[fd00::2]:5555', devicePhysicalId: 'a'.repeat(64) },
      s2: { deviceSerial: null, devicePhysicalId: null },
    });
  });
});
