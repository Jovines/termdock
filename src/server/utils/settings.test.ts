import { describe, expect, it } from 'vitest';
import { normalizeNewSessionAgentSlug } from './settings.js';

describe('normalizeNewSessionAgentSlug', () => {
  it('normalizes a valid persisted agent slug', () => {
    expect(normalizeNewSessionAgentSlug('  Claude-Code  ')).toBe('claude-code');
  });

  it('rejects invalid or absent values', () => {
    expect(normalizeNewSessionAgentSlug(null)).toBeNull();
    expect(normalizeNewSessionAgentSlug('../codex')).toBeNull();
    expect(normalizeNewSessionAgentSlug('')).toBeNull();
  });
});
