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
