// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HTML_EXTENSIONS, buildHtmlPreviewUrl, isPreviewableHtmlPath } from './api';

describe('HTML preview path detection', () => {
  it('covers exactly .html/.htm', () => {
    expect([...HTML_EXTENSIONS].sort()).toEqual(['.htm', '.html']);
  });

  it('accepts .html/.htm regardless of case', () => {
    expect(isPreviewableHtmlPath('/repo/site/index.html')).toBe(true);
    expect(isPreviewableHtmlPath('/repo/site/index.HTML')).toBe(true);
    expect(isPreviewableHtmlPath('/repo/site/page.htm')).toBe(true);
    expect(isPreviewableHtmlPath('/repo/site/page.Htm')).toBe(true);
  });

  it('rejects non-HTML files', () => {
    expect(isPreviewableHtmlPath('/repo/site/style.css')).toBe(false);
    expect(isPreviewableHtmlPath('/repo/site/app.js')).toBe(false);
    expect(isPreviewableHtmlPath('/repo/site/readme.md')).toBe(false);
    expect(isPreviewableHtmlPath('/repo/site/no-extension')).toBe(false);
  });

  it('builds a preview URL mirroring the absolute path', () => {
    expect(buildHtmlPreviewUrl('/home/user/proj/index.html'))
      .toBe('/api/terminal/fs/preview/home/user/proj/index.html');
  });

  it('encodes URL-special characters in path segments', () => {
    expect(buildHtmlPreviewUrl('/home/user/my site/#demo/index.html'))
      .toBe('/api/terminal/fs/preview/home/user/my%20site/%23demo/index.html');
  });

  it('normalizes backslash (Windows) paths', () => {
    expect(buildHtmlPreviewUrl('C:\\repo\\site\\index.html'))
      .toBe('/api/terminal/fs/preview/C%3A/repo/site/index.html');
  });
});
