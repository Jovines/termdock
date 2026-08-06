import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findDirectoryIndexFile, injectHtmlPreviewBase } from './filesystem.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-html-preview-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('HTML preview base injection', () => {
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

describe('HTML preview directory index resolution', () => {
  it('serves index.html when present', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dir, 'other.html'), '<html></html>');
    expect(await findDirectoryIndexFile(dir)).toBe(path.join(dir, 'index.html'));
  });

  it('falls back to index.htm', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'index.htm'), '<html></html>');
    expect(await findDirectoryIndexFile(dir)).toBe(path.join(dir, 'index.htm'));
  });

  it('returns null when the directory has no index document', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'page.html'), '<html></html>');
    expect(await findDirectoryIndexFile(dir)).toBeNull();
  });
});
