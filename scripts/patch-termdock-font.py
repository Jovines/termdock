#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphComponent

ROOT = Path(__file__).resolve().parents[1]
PATCH_FILE = ROOT / 'tools/font/termdock-glyph-patches.json'
FONT_DIR = ROOT / 'public/fonts'
WEIGHTS = ['Regular', 'Bold', 'Italic', 'BoldItalic']


def parse_cp(value: str) -> int:
    return int(value.replace('U+', ''), 16)


def build_cmap(font: TTFont) -> dict[int, str]:
    cmap: dict[int, str] = {}
    for table in font['cmap'].tables:
        cmap.update(table.cmap)
    return cmap


def add_post_name(post, glyph_name: str) -> None:
    if post and hasattr(post, 'extraNames') and hasattr(post, 'mapping'):
        post.extraNames.append(glyph_name)
        post.mapping[glyph_name] = glyph_name


def add_unicode_mapping(font: TTFont, codepoint: int, glyph_name: str) -> None:
    for table in font['cmap'].tables:
        if table.isUnicode():
            table.cmap[codepoint] = glyph_name


def make_component(glyph_name: str, x: int, y: int, scale: float) -> GlyphComponent:
    component = GlyphComponent()
    component.glyphName = glyph_name
    component.x = x
    component.y = y
    component.transform = ((scale, 0), (0, scale))
    component.flags = 4
    return component


def add_black_diamond_minus_white_x(font: TTFont, cmap: dict[int, str], glyph_order: list[str], post) -> int:
    dst_cp = 0x2756
    if dst_cp in cmap:
        return 0
    src_name = cmap.get(0x25C6)
    if not src_name:
        print('missing source U+25C6 for U+2756', file=sys.stderr)
        return 0
    dst_name = 'termdock_uni2756'
    if dst_name in glyph_order:
        return 0

    glyph = Glyph()
    glyph.numberOfContours = -1
    # Four small black diamonds arranged around the center.  The source diamond
    # is 600 units wide; scale 0.34 keeps the composite visually distinct from
    # U+25C6 while staying inside a single terminal cell.
    scale = 0.34
    glyph.components = [
        make_component(src_name, 198, 436, scale),
        make_component(src_name, 198, 100, scale),
        make_component(src_name, 30, 268, scale),
        make_component(src_name, 366, 268, scale),
    ]
    glyph_order.append(dst_name)
    font['glyf'].glyphs[dst_name] = glyph
    font['hmtx'].metrics[dst_name] = copy.deepcopy(font['hmtx'].metrics[src_name])
    add_post_name(post, dst_name)
    add_unicode_mapping(font, dst_cp, dst_name)
    cmap[dst_cp] = dst_name
    return 1


def patch_font(path: Path, aliases: dict[int, int]) -> int:
    font = TTFont(path)
    cmap = build_cmap(font)
    glyph_order = font.getGlyphOrder()
    glyf = font['glyf']
    hmtx = font['hmtx']
    post = font['post'] if 'post' in font else None
    patched = add_black_diamond_minus_white_x(font, cmap, glyph_order, post)

    for dst_cp, src_cp in aliases.items():
        if dst_cp in cmap:
            continue
        src_name = cmap.get(src_cp)
        if not src_name:
            print(f'{path.name}: missing source U+{src_cp:04X}', file=sys.stderr)
            continue
        dst_name = f'termdock_uni{dst_cp:04X}'
        if dst_name in glyph_order:
            continue

        glyph_order.append(dst_name)
        glyf.glyphs[dst_name] = copy.deepcopy(glyf[src_name])
        hmtx.metrics[dst_name] = copy.deepcopy(hmtx.metrics[src_name])
        add_post_name(post, dst_name)
        add_unicode_mapping(font, dst_cp, dst_name)
        patched += 1

    if patched:
        font.setGlyphOrder(glyph_order)
        font['maxp'].numGlyphs = len(glyph_order)
        font.save(path)
    return patched


def main() -> int:
    config = json.loads(PATCH_FILE.read_text())
    aliases = {parse_cp(k): parse_cp(v) for k, v in config.get('aliases', {}).items()}
    total = 0
    for weight in WEIGHTS:
        path = FONT_DIR / f'JetBrainsMonoNLNerdFontMono-{weight}.ttf'
        if not path.exists():
            print(f'missing font: {path}', file=sys.stderr)
            return 1
        count = patch_font(path, aliases)
        total += count
        print(f'{path.name}: patched {count} glyphs')
    print(f'total patched: {total}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
