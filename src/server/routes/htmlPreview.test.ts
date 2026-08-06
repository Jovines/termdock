import { describe, expect, it } from 'vitest';
import { buildHtmlPreviewDirectoryUrl, injectHtmlPreviewBase } from './filesystem.js';

describe('HTML preview base injection', () => {
  it('builds a preview directory URL mirroring the absolute path', () => {
    expect(buildHtmlPreviewDirectoryUrl('/home/user/proj/site/index.html'))
      .toBe('/api/terminal/fs/preview/home/user/proj/site/');
    expect(buildHtmlPreviewDirectoryUrl('/index.html'))
      .toBe('/api/terminal/fs/preview/');
  });

  it('encodes URL-special characters in directory segments', () => {
    expect(buildHtmlPreviewDirectoryUrl('/home/user/my site/#demo/index.html'))
      .toBe('/api/terminal/fs/preview/home/user/my%20site/%23demo/');
  });

  it('normalizes backslash (Windows) paths', () => {
    expect(buildHtmlPreviewDirectoryUrl('C:\\repo\\site\\index.html'))
      .toBe('/api/terminal/fs/preview/C%3A/repo/site/');
  });

  it('injects <base> right after <head>', () => {
    const html = '<!doctype html>\n<html><head><meta charset="utf-8"></head><body><img src="img/a.png"></body></html>';
    const result = injectHtmlPreviewBase(html, '/api/terminal/fs/preview/site/');
    expect(result).toBe('<!doctype html>\n<html><head><base href="/api/terminal/fs/preview/site/"><meta charset="utf-8"></head><body><img src="img/a.png"></body></html>');
  });

  it('injects <base> after the doctype when there is no <head>', () => {
    const html = '<!doctype html><html><body><img src="img/a.png"></body></html>';
    expect(injectHtmlPreviewBase(html, '/api/terminal/fs/preview/site/'))
      .toBe('<!doctype html><base href="/api/terminal/fs/preview/site/"><html><body><img src="img/a.png"></body></html>');
  });

  it('prepends <base> to headless documents', () => {
    expect(injectHtmlPreviewBase('<html><body>bare</body></html>', '/api/terminal/fs/preview/'))
      .toBe('<base href="/api/terminal/fs/preview/"><html><body>bare</body></html>');
  });

  it('does not override an author-declared <base>', () => {
    const html = '<html><head><base href="https://cdn.example.com/"></head><body></body></html>';
    expect(injectHtmlPreviewBase(html, '/api/terminal/fs/preview/site/')).toBe(html);
  });

  it('is case-insensitive for <head>', () => {
    const html = '<HTML><HEAD><TITLE>x</TITLE></HEAD></HTML>';
    expect(injectHtmlPreviewBase(html, '/api/terminal/fs/preview/site/'))
      .toBe('<HTML><HEAD><base href="/api/terminal/fs/preview/site/"><TITLE>x</TITLE></HEAD></HTML>');
  });
});
