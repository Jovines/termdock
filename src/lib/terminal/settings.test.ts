// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultTerminalSettings, normalizeTerminalSettings } from './settings';

function viewport(mobile: boolean, coarse = false) {
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({ matches: query.includes('pointer') ? coarse : mobile }),
  });
}

const legacyDefaults = {
  fontFamily: 'var(--font-mono)', fontSize: 13,
  fontWeight: 'normal', fontWeightBold: 'bold', letterSpacing: 1, lineHeight: 1.05,
};

afterEach(() => vi.unstubAllGlobals());

describe('Maple terminal typography', () => {
  it.each([[false, false, 14], [true, false, 12], [false, true, 12]])(
    'uses the selected reading size for mobile=%s coarse=%s', (mobile, coarse, size) => {
      viewport(mobile as boolean, coarse as boolean);
      expect(getDefaultTerminalSettings()).toMatchObject({
        fontFamily: 'var(--font-terminal)', fontSize: size, letterSpacing: 0, lineHeight: 1.1,
      });
    },
  );

  it('upgrades persisted legacy defaults without changing the chosen renderer', () => {
    viewport(false);
    expect(normalizeTerminalSettings({ ...legacyDefaults, rendererMode: 'webgl' })).toMatchObject({
      typographyVersion: 1, fontFamily: 'var(--font-terminal)', fontSize: 14,
      letterSpacing: 0, lineHeight: 1.1, rendererMode: 'webgl',
    });
  });

  it('upgrades the old mobile defaults to the mobile reading size', () => {
    viewport(true);
    expect(normalizeTerminalSettings({ ...legacyDefaults, fontSize: 10, letterSpacing: 0 }))
      .toMatchObject({ fontSize: 12, letterSpacing: 0, lineHeight: 1.1 });
  });

  it.each([
    { fontFamily: 'Custom Mono' }, { fontSize: 16 }, { letterSpacing: 2 }, { lineHeight: 1.3 },
  ])('preserves customized typography: %j', (customization) => {
    viewport(false);
    const saved = { ...legacyDefaults, ...customization };
    expect(normalizeTerminalSettings(saved)).toMatchObject({
      fontFamily: customization.fontFamily ?? 'var(--font-terminal)',
      fontSize: saved.fontSize, letterSpacing: saved.letterSpacing, lineHeight: saved.lineHeight,
    });
  });

  it('does not reapply the migration when a user subsequently picks the old size', () => {
    viewport(false);
    const upgraded = normalizeTerminalSettings(legacyDefaults);
    const customized = { ...upgraded, fontSize: 13, letterSpacing: 1, lineHeight: 1.05 };
    expect(normalizeTerminalSettings(customized)).toEqual(customized);
    expect(normalizeTerminalSettings(upgraded)).toEqual(upgraded);
  });
});
