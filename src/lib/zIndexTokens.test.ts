import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Single source of truth guard for overlay stacking.
//
// 全屏浮层（fixed 遮罩/抽屉/弹窗/浮窗）的 z-index 必须走 src/index.css 的
// --z-* 语义档位 + tailwind.config.js 的 z-* 语义类，禁止散落的裸 z-[数字]。
// 这条测试就是为了拦住「某个浮层被单独提了层级、别的浮层没跟上 → 被盖住、
// 点了没反应」这类回归（设置抽屉 vs 工具栏弹窗就踩过）。

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const srcRoot = join(repoRoot, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function parseTokenScale(): Record<string, number> {
  const css = readFileSync(join(srcRoot, 'index.css'), 'utf-8');
  const scale: Record<string, number> = {};
  for (const match of css.matchAll(/--(z-[a-z-]+):\s*(\d+);/g)) {
    scale[match[1]!] = Number.parseInt(match[2]!, 10);
  }
  return scale;
}

describe('overlay z-index single source of truth', () => {
  it('defines the full semantic token scale in index.css', () => {
    const scale = parseTokenScale();
    // Every named tier the app relies on must exist with a numeric value.
    expect(Object.keys(scale).sort()).toEqual([
      'z-drawer-backdrop',
      'z-drawer-panel',
      'z-menu-backdrop',
      'z-menu-panel',
      'z-modal-backdrop',
      'z-modal-panel',
      'z-popover',
      'z-sidebar-backdrop',
      'z-sidebar-panel',
      'z-toast',
    ]);
  });

  it('keeps the stacking order monotonic from sidebar up to popover', () => {
    const s = parseTokenScale();
    // The invariant that prevents "modal hidden behind drawer" regressions:
    // a child layer must always outrank the surface that launches it.
    expect(s['z-sidebar-backdrop']!).toBeLessThan(s['z-sidebar-panel']!);
    expect(s['z-sidebar-panel']!).toBeLessThan(s['z-menu-backdrop']!);
    expect(s['z-menu-backdrop']!).toBeLessThan(s['z-menu-panel']!);
    expect(s['z-menu-panel']!).toBeLessThan(s['z-drawer-backdrop']!);
    expect(s['z-drawer-backdrop']!).toBeLessThan(s['z-drawer-panel']!);
    // Modals are launched FROM the settings drawer, so they must outrank it.
    expect(s['z-drawer-panel']!).toBeLessThan(s['z-modal-backdrop']!);
    expect(s['z-modal-backdrop']!).toBeLessThan(s['z-modal-panel']!);
    expect(s['z-modal-panel']!).toBeLessThan(s['z-toast']!);
    expect(s['z-toast']!).toBeLessThan(s['z-popover']!);
  });

  it('exposes every token as a tailwind z-* utility', () => {
    const scale = parseTokenScale();
    const config = readFileSync(join(repoRoot, 'tailwind.config.js'), 'utf-8');
    for (const token of Object.keys(scale)) {
      // tailwind key drops the leading "z-": --z-modal-panel -> 'modal-panel'
      const key = token.replace(/^z-/, '');
      expect(config, `tailwind.config.js missing z-index mapping for ${token}`)
        .toContain(`'${key}': 'var(--${token})'`);
    }
  });

  it('forbids raw arbitrary z-[N] on full-screen fixed overlays', () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const text = readFileSync(file, 'utf-8');
      text.split('\n').forEach((line, index) => {
        // Only police lines that pin a fixed overlay; in-flow stacking
        // (sticky headers, dropdown menus inside a panel) is out of scope.
        if (line.includes('fixed') && /z-\[\d+\]/.test(line)) {
          offenders.push(`${file.replace(repoRoot + '/', '')}:${index + 1}`);
        }
      });
    }
    expect(offenders, `Use semantic z-* tokens (see src/index.css --z-*) instead of raw z-[N]:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});
