import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/lib/components/sidebar/sidebarSelection.css'), 'utf8');

describe('Markdown code scroller styles', () => {
  it('keeps long code lines unwrapped inside a width-constrained horizontal scroller', () => {
    const rule = css.match(
      /\.termdock-native-select\s+pre\.termdock-file-preview-horizontal-scroll\s*\{([^}]+)\}/,
    )?.[1];

    expect(rule).toBeTruthy();
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/max-width:\s*100%/);
    expect(rule).toMatch(/overflow-x:\s*auto/);
    expect(rule).toMatch(/overflow-y:\s*hidden/);
    expect(rule).toMatch(/white-space:\s*pre/);
    expect(rule).toMatch(/overflow-wrap:\s*normal/);
    expect(rule).toMatch(/word-break:\s*normal/);
    expect(rule).toMatch(/touch-action:\s*pan-x pan-y/);
    expect(rule).toMatch(/-webkit-overflow-scrolling:\s*touch/);
  });
});
