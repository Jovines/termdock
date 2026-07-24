import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Flexoki 色板单一来源守卫。
//
// 项目色板 = Flexoki 深色主题 (https://stephango.com/flexoki)。规则两条:
//  1. src/index.css :root 的核心变量必须等于官方值
//     (bg / bg-2 / ui 阶梯 / tx 阶梯 / 强调色一律官方 400);
//  2. src 任何文件里的十六进制色值必须属于 Flexoki 家族
//     (base 阶梯 + 400/600 强调色 + 亮色 base + paper/black 端点)。
//
// 踩坑史(都是凭手感取色导致的体系外污染):
//  - agent 状态点用了 Tailwind 的 #4ade80 / #facc15;
//  - onboarding 设置页用了通用蓝绿(#41d17d / #8bd5ff);
//  - 一次"提亮主色"把 --primary 调出了官方色板。
// 这条测试就是拦住下一次。扫描只认 6 位 hex;3 位简写(#fff)与
// rgba()/数字三元组不在此守卫范围(QR 底色、透明度叠色属于功能色)。

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const srcRoot = join(projectRoot, 'src');

const FLEXOKI_FAMILY = new Set(
  [
    // base 深色阶梯
    '#100F0F', // bg (black)
    '#1C1B1A', // bg-2 (base-950)
    '#282726', // ui (base-900)
    '#343331', // ui-2 (base-850)
    '#403E3C', // ui-3 (base-800)
    '#575653', // tx-3 (base-700)
    '#6F6E69', // base-600
    '#878580', // tx-2 (base-500)
    '#9F9D96', // base-400(代码标点等次亮文本)
    '#CECDC3', // tx (base-200)
    // 强调色 400(深色主题 UI 一律用 400)
    '#D14D41', // red-400
    '#DA702C', // orange-400
    '#D0A215', // yellow-400
    '#879A39', // green-400
    '#3AA99F', // cyan-400
    '#4385BE', // blue-400
    '#8B7EC8', // purple-400
    '#CE5D97', // magenta-400
    // 强调色 600(终端 ANSI 正常色 / 亮色主题强调色)
    '#AF3029', // red-600
    '#BC5215', // orange-600
    '#AD8301', // yellow-600
    '#66800B', // green-600
    '#24837B', // cyan-600
    '#205EA6', // blue-600
    '#5E409D', // purple-600
    '#A02F6F', // magenta-600
    // 亮色 base + 端点
    '#FFFCF0', // paper
    '#F2F0E5', // light bg-2
    '#E6E4D9', // light ui
    '#DAD8CE', // light ui-2
    '#B7B5AC', // light tx-3
  ].map((c) => c.toUpperCase()),
);

/** :root 深色块里必须严格等于官方值的核心变量。 */
const CORE_VARS: Record<string, string> = {
  '--background': '#100F0F', // bg
  '--background-subtle': '#1C1B1A', // bg-2
  '--surface': '#282726', // ui
  '--surface-2': '#343331', // ui-2
  '--surface-elevated': '#403E3C', // ui-3
  '--muted': '#575653', // tx-3
  '--muted-foreground': '#878580', // tx-2
  '--foreground': '#CECDC3', // tx
  '--primary': '#879A39', // green-400
  '--accent': '#4385BE', // blue-400
  '--destructive': '#D14D41', // red-400
  '--warning': '#D0A215', // yellow-400
  '--success': '#879A39', // green-400
  '--folder': '#D0A215', // yellow-400
  '--tmux': '#8B7EC8', // purple-400
  '--ring': '#4385BE', // blue-400
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(tsx|ts|css)$/.test(entry) && !/\.test\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function parseRootVars(css: string): Record<string, string> {
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!rootMatch) return {};
  const vars: Record<string, string> = {};
  for (const match of rootMatch[1]!.matchAll(/(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    vars[match[1]!] = match[2]!.toUpperCase();
  }
  return vars;
}

describe('Flexoki palette single source of truth', () => {
  it('keeps every core :root variable exactly on the official Flexoki values', () => {
    const vars = parseRootVars(readFileSync(join(srcRoot, 'index.css'), 'utf-8'));
    const mismatches = Object.entries(CORE_VARS)
      .filter(([name, official]) => vars[name] !== official)
      .map(([name, official]) => `${name}: expected ${official}, got ${vars[name] ?? '(missing)'}`);
    expect(mismatches).toEqual([]);
  });

  it('allows only Flexoki-family hex colors anywhere in src', () => {
    const offenders: string[] = [];
    for (const file of walk(join(srcRoot))) {
      const text = readFileSync(file, 'utf-8');
      for (const match of text.matchAll(/#[0-9A-Fa-f]{6}\b/g)) {
        const hex = match[0].toUpperCase();
        if (!FLEXOKI_FAMILY.has(hex)) {
          offenders.push(`${file.replace(srcRoot, 'src')}: ${hex}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
