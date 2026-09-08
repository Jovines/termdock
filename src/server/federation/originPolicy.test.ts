import { describe, expect, it, vi } from 'vitest';
import { secureChannelOriginAllowed } from './originPolicy.js';
describe('Noise endpoint origin policy', () => {
  it('allows native no-Origin clients even when legacy public-origin checks reject them', () => {
    const legacy = vi.fn(() => false);
    expect(secureChannelOriginAllowed(undefined, legacy)).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
  });
  it('allows a different HTTPS PWA origin without inheriting cookie authentication', () => {
    expect(secureChannelOriginAllowed('https://entry-b.example', () => false)).toBe(true);
  });
  it('retains the strict existing policy for HTTP origins and rejects opaque or malformed origins', () => {
    expect(secureChannelOriginAllowed('http://localhost:9834', () => true)).toBe(true);
    expect(secureChannelOriginAllowed('http://elsewhere.example', () => false)).toBe(false);
    for (const origin of ['', 'null', 'file://', 'data:text/html,x', 'https://host/path', 'https://host/', 'https://user:pass@host']) {
      expect(secureChannelOriginAllowed(origin, () => true)).toBe(false);
    }
  });
});
