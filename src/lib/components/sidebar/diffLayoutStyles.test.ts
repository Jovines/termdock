import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('diff layout styles', () => {
  it('lets wrapped split diffs fit a narrow pinned sidebar without horizontal overflow', () => {
    const splitRule = ruleBody('.diff-split .diff');
    const wrappedSplitRule = ruleBody('.diff-split.termdock-diff-wrap .diff');

    expect(splitRule).toMatch(/min-width:\s*48rem\s*;/);
    expect(wrappedSplitRule).toMatch(/min-width:\s*100%\s*;/);
    expect(css.indexOf('.diff-split.termdock-diff-wrap .diff'))
      .toBeGreaterThan(css.indexOf('.diff-split .diff'));
  });
});
