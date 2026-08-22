import { describe, expect, it } from 'vitest';
import { parseClaudeSupportedModels, recommendTitleModel } from './titleNamerCatalog.js';

describe('title namer catalog', () => {
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
