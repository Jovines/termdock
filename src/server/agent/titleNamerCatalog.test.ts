import { describe, expect, it } from 'vitest';
import {
  buildPluginTitleArgs,
  normalizeDiscoveredModelCatalog,
  parseClaudeSupportedModels,
  recommendTitleModel,
  shouldRunPluginTitleCommands,
} from './titleNamerCatalog.js';

describe('title namer catalog', () => {
  it('does not authorize plugin commands merely because the package is installed', () => {
    expect(shouldRunPluginTitleCommands('orbit', 'auto', [])).toBe(false);
    expect(shouldRunPluginTitleCommands('orbit', 'codex', ['orbit'])).toBe(false);
    expect(shouldRunPluginTitleCommands('orbit', 'orbit', [])).toBe(true);
    expect(shouldRunPluginTitleCommands('orbit', 'auto', ['orbit'])).toBe(true);
  });

  it('extracts the current provider model list from Claude CLI validation', () => {
    const models = parseClaudeSupportedModels(
      'The supported API model names are small-fast, balanced.v2, and strong:latest, but you passed invalid.',
    );
    expect(models.map((model) => model.id)).toEqual(['small-fast', 'balanced.v2', 'strong:latest']);
  });

  it('does not invent Claude models when the CLI gives no catalog', () => {
    expect(parseClaudeSupportedModels('Unknown model')).toEqual([]);
  });

  it('uses explicit economical metadata and never guesses price from descriptions', () => {
    expect(recommendTitleModel([
      { id: 'strong', displayName: 'Strong', description: 'Frontier model', isDefault: true },
      { id: 'small', displayName: 'Small', description: 'Fast and affordable model', isDefault: false, isEconomical: true },
    ])).toBe('small');
    expect(recommendTitleModel([
      { id: 'default', displayName: 'Default', description: '', isDefault: true },
      { id: 'marketing', displayName: 'Marketing', description: 'Affordable', isDefault: false },
    ])).toBe('default');
  });

  it('deduplicates and bounds untrusted model metadata', () => {
    const catalog = normalizeDiscoveredModelCatalog({
      models: [
        { name: ' trae-fast ', displayName: 'x'.repeat(300), description: 'y'.repeat(2_000) },
        { id: 'trae-fast', displayName: 'duplicate' },
      ],
    });
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({ id: 'trae-fast' });
    expect(catalog.models[0].displayName).toHaveLength(160);
    expect(catalog.models[0].description).toHaveLength(1_000);
    expect(catalog.ignoredEntries).toBe(1);
  });

  it('normalizes native name fields and an explicit recommendation without hardcoding models', () => {
    const catalog = normalizeDiscoveredModelCatalog({
      models: [
        { name: 'trae-fast', description: 'Fast model', is_economical: true },
        { name: 'trae-pro', display_name: 'Trae Pro', is_default: true },
        { description: 'missing identifier' },
      ],
      recommendedModel: 'trae-fast',
    });
    expect(catalog.models).toEqual([
      expect.objectContaining({ id: 'trae-fast', displayName: 'trae-fast', isEconomical: true }),
      expect.objectContaining({ id: 'trae-pro', displayName: 'Trae Pro', isDefault: true }),
    ]);
    expect(catalog.recommendedModel).toBe('trae-fast');
    expect(catalog.ignoredEntries).toBe(1);
  });

  it('treats modelArgs as an atomic optional group', () => {
    const config = {
      command: 'traecli',
      modelArgs: ['-c', 'model="{model}"'],
      args: ['-p', '{prompt}'],
    };
    expect(buildPluginTitleArgs(config, '/plugin', 'title this')).toEqual(['-p', 'title this']);
    expect(buildPluginTitleArgs(config, '/plugin', 'title this', 'trae-fast')).toEqual([
      '-c', 'model="trae-fast"', '-p', 'title this',
    ]);
  });

  it('heals legacy paired model flags when automatic mode passes no model', () => {
    expect(buildPluginTitleArgs({
      command: 'traecli',
      args: ['-c', 'model="{model}"', '-p', '{prompt}'],
    }, '/plugin', 'title this')).toEqual(['-p', 'title this']);
  });
});
