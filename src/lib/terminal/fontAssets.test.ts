import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..', '..');
const fontRoot = join(projectRoot, 'public', 'fonts');
const indexHtml = readFileSync(join(projectRoot, 'index.html'), 'utf8');

const TERMINAL_FACE_FILES = [
  'JetBrainsMonoNLNerdFontMono-Regular.woff2',
  'JetBrainsMonoNLNerdFontMono-Bold.woff2',
  'JetBrainsMonoNLNerdFontMono-Italic.woff2',
  'JetBrainsMonoNLNerdFontMono-BoldItalic.woff2',
] as const;

describe('terminal startup font assets', () => {
  it('references only font files that ship with the client', () => {
    const referencedFonts = [...indexHtml.matchAll(/(?:url\('|href=")\/fonts\/([^'"]+)/g)]
      .map((match) => match[1]!);

    expect(referencedFonts.length).toBeGreaterThan(0);
    for (const file of referencedFonts) {
      expect(existsSync(join(fontRoot, file)), `missing public/fonts/${file}`).toBe(true);
    }
  });

  it('keeps the complete Nerd Font face pack compressed without legacy duplicates', () => {
    const shippedFonts = readdirSync(fontRoot);
    expect(shippedFonts.some((file) => file.endsWith('.ttf'))).toBe(false);

    const facePackBytes = TERMINAL_FACE_FILES.reduce(
      (total, file) => total + statSync(join(fontRoot, file)).size,
      0,
    );
    expect(facePackBytes).toBeLessThan(4.5 * 1024 * 1024);
  });
});

it('keeps critical font preloads below 160 KB and all unicode shards available', () => {
  const preloads = [...indexHtml.matchAll(/<link[^>]+href="\/fonts\/([^\"]+)"[^>]*>/g)].map((match) => match[1]);
  expect(preloads.reduce((bytes, file) => bytes + statSync(join(fontRoot, file)).size, 0)).toBeLessThan(160_000);
  const css = readFileSync(join(here, 'fontFaces.css'), 'utf8');
  const shards = [...css.matchAll(/url\(['"]?\/fonts\/([^)'" ]+)/g)].map((match) => match[1]);
  expect(shards.length).toBeGreaterThan(100);
  expect((css.match(/unicode-range:/g) ?? []).length).toBe(shards.length);
  for (const file of shards) {
    expect(file).toMatch(/-[a-f0-9]{12}\.woff2$/);
    expect(existsSync(join(fontRoot, file))).toBe(true);
  }
});
