import { describe, expect, it } from 'vitest';
import {
  buildDesktopToolbarPresetOptions,
  createDefaultToolbarPresets,
  sanitizeToolbarPresets,
  type ToolbarPresetDefinition,
} from './mobileKeyboardPresets';

describe('toolbar preset desktop visibility', () => {
  it('keeps built-in AI presets desktop-visible and base hidden', () => {
    const defaults = createDefaultToolbarPresets();

    expect(defaults.find((preset) => preset.id === 'default')?.showOnDesktop).toBe(false);
    expect(defaults.find((preset) => preset.id === 'claude')?.showOnDesktop).toBe(true);
    expect(defaults.find((preset) => preset.id === 'opencode')?.showOnDesktop).toBe(true);
    expect(defaults.find((preset) => preset.id === 'coco')?.showOnDesktop).toBe(true);
    expect(defaults.find((preset) => preset.id === 'traex')?.showOnDesktop).toBe(true);
  });

  it('defaults legacy custom presets to hidden on desktop', () => {
    const sanitized = sanitizeToolbarPresets([
      {
        id: 'custom-ai',
        label: 'Custom AI',
        programs: ['custom-ai'],
        includeAlt: false,
        rowLayout: [3],
        actions: [{ id: 'custom-undo', label: '/undo', sequence: '/undo' }],
      },
    ]);
    const legacyPreset = sanitized.find((preset) => preset.id === 'custom-ai');

    expect(legacyPreset?.showOnDesktop).toBe(false);
  });

  it('preserves explicit desktop visibility flags', () => {
    const sanitized = sanitizeToolbarPresets([
      {
        id: 'custom-ai',
        label: 'Custom AI',
        programs: ['custom-ai'],
        includeAlt: false,
        rowLayout: [3],
        actions: [],
        showOnDesktop: true,
      },
    ]);
    const desktopPreset = sanitized.find((preset) => preset.id === 'custom-ai');

    expect(desktopPreset?.showOnDesktop).toBe(true);
  });

  it('filters desktop preset menu options to desktop-visible presets', () => {
    const presets: ToolbarPresetDefinition[] = [
      {
        id: 'default',
        label: 'Base',
        programs: [],
        includeAlt: true,
        rowLayout: [3],
        actions: [],
        showOnDesktop: false,
      },
      {
        id: 'claude',
        label: 'Claude',
        programs: ['claude'],
        includeAlt: false,
        rowLayout: [4],
        actions: [{ id: 'undo', label: '/undo', sequence: '/undo' }],
        showOnDesktop: true,
      },
    ];

    expect(buildDesktopToolbarPresetOptions(presets)).toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'claude', label: 'Claude' },
    ]);
  });
});
