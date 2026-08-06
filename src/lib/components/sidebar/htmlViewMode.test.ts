// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { getHtmlViewModeFileKey, readHtmlViewMode, writeHtmlViewMode } from './htmlViewMode';

describe('per-file HTML view mode cache', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to source when no choice was saved', () => {
    expect(readHtmlViewMode('/repo', 'site/index.html')).toBe('source');
    expect(readHtmlViewMode(null, null)).toBe('source');
  });

  it('derives a stable key from root + relative path', () => {
    expect(getHtmlViewModeFileKey('/repo', 'site/index.html')).toBe('/repo::/repo/site/index.html');
    expect(getHtmlViewModeFileKey('/repo', '/other/index.html')).toBe('/repo::/other/index.html');
    expect(getHtmlViewModeFileKey(null, '/repo/site/index.html')).toBe('/repo/site/index.html');
    expect(getHtmlViewModeFileKey('/repo', null)).toBeNull();
  });

  it('remembers the choice per file across reads', () => {
    writeHtmlViewMode('/repo', 'site/a.html', 'preview');
    writeHtmlViewMode('/repo', 'site/b.html', 'source');

    expect(readHtmlViewMode('/repo', 'site/a.html')).toBe('preview');
    expect(readHtmlViewMode('/repo', 'site/b.html')).toBe('source');
  });

  it('treats the same absolute path under different roots as different files', () => {
    writeHtmlViewMode('/repo-a', 'shared.html', 'preview');
    expect(readHtmlViewMode('/repo-b', 'shared.html')).toBe('source');
  });

  it('falls back to source when the cache is corrupted', () => {
    window.localStorage.setItem('termdock:right-sidebar:html-view-mode-by-file:v1', 'not-json');
    expect(readHtmlViewMode('/repo', 'site/index.html')).toBe('source');

    window.localStorage.setItem(
      'termdock:right-sidebar:html-view-mode-by-file:v1',
      JSON.stringify({ '/repo::/repo/site/index.html': 'sideways' }),
    );
    expect(readHtmlViewMode('/repo', 'site/index.html')).toBe('source');
  });
});
