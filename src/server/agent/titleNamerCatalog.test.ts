import { describe, expect, it } from 'vitest';
import { parseClaudeSupportedModels, recommendTitleModel, shouldRunPluginTitleCommands } from './titleNamerCatalog.js';

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

  it('derives the economical default from CLI descriptions', () => {
    expect(recommendTitleModel([
      { id: 'strong', displayName: 'Strong', description: 'Frontier model', isDefault: true },
      { id: 'small', displayName: 'Small', description: 'Fast and affordable model', isDefault: false },
    ])).toBe('small');
  });
});
