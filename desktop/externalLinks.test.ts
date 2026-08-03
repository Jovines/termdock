import { describe, expect, it } from 'vitest';
import { isExternalLinkStagingUrl, isSafeExternalUrl } from './externalLinks.js';

describe('desktop external links', () => {
  it('recognizes the blank staging window used by xterm WebLinksAddon', () => {
    expect(isExternalLinkStagingUrl('about:blank')).toBe(true);
    expect(isExternalLinkStagingUrl('https://example.com')).toBe(false);
  });

  it('allows browser and mail links while rejecting unsafe protocols', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:9834')).toBe(true);
    expect(isSafeExternalUrl('mailto:hello@example.com')).toBe(true);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });
});
