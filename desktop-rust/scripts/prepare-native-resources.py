#!/usr/bin/env python3
"""Generate process-registered SFNTs from the exact shipped WOFF2 faces.
Requires fonttools[woff]; never downloads/replaces fonts or installs globally.
"""
from pathlib import Path
import hashlib,json,os,shutil,sys,subprocess
import fontTools,brotli
from fontTools.ttLib import TTFont
if fontTools.__version__!="4.61.1" or brotli.__version__!="1.2.0":raise RuntimeError("Use native-resources-requirements.txt in an isolated build environment")
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'desktop-rust/.native-resources'
shutil.rmtree(OUT,ignore_errors=True);(OUT/'fonts').mkdir(parents=True)
fonts=[]
shutil.copytree(ROOT/'desktop-rust/runtime-licenses',OUT/'licenses/fonts')
for name in ['JetBrainsMonoNLNerdFontMono-Regular','JetBrainsMonoNLNerdFontMono-Bold','JetBrainsMonoNLNerdFontMono-Italic','JetBrainsMonoNLNerdFontMono-BoldItalic','NotoSansMonoCJKsc-Subset','NotoSansMonoCJKsc-Bold-Subset','NotoSansSymbols2-Subset']:
    source=ROOT/'public/fonts'/f'{name}.woff2';font=TTFont(source,recalcTimestamp=False)
    cmap=font.getBestCmap();widths=dict(font['hmtx'].metrics)
    family=font['name'].getDebugName(1);postscript=font['name'].getDebugName(6)
    if name=='NotoSansSymbols2-Subset' and (not family or not postscript):
        # Existing web subset has no usable name table. Supply its existing CSS
        # alias for process registration; preserve every glyph and metric.
        family='Noto Sans Symbols 2';postscript='TermdockNotoSansSymbols2'
        for key,value in [(1,family),(2,'Regular'),(4,family+' Regular'),(6,postscript)]: font['name'].setName(value,key,3,1,0x409)
    if not family or not postscript: raise RuntimeError(f'Missing actual CoreText font identity: {name}')
    font.flavor=None;extension='otf' if 'CFF ' in font else 'ttf'
    relative=f'fonts/{name}.{extension}';font.save(OUT/relative)
    actual=TTFont(OUT/relative)
    if actual.getBestCmap()!=cmap or dict(actual['hmtx'].metrics)!=widths: raise RuntimeError('Conversion changed cmap or metrics')
    notices=[]
    for key in [0,7,8,9,11,13,14]:
        value=font['name'].getDebugName(key)
        if value:notices.append(f'nameID {key}: {value}')
    (OUT/f'fonts/{name}.notices.txt').write_text('\n'.join(notices)+'\n')
    fonts.append({'path':relative,'family':family,'postscript':postscript,'sourcePath':str(source.relative_to(ROOT)),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'sha256':hashlib.sha256((OUT/relative).read_bytes()).hexdigest(),'size':(OUT/relative).stat().st_size})
# Menlo-derived TermdockStarSymbol remains the existing web asset. Native uses
# the user's system symbol fallback; no extra redistributed Apple SFNT is made.
prefix=os.environ.get('TERMDOCK_GHOSTTY_PREFIX')
if sys.platform=='darwin':
    if not prefix: raise RuntimeError('macOS native resources require the locked Ghostty prefix')
    prefix=Path(prefix);lock=(ROOT/'desktop-rust/native-terminal/ghostty/lock.json').read_text()
    if (prefix/'termdock-build.json').read_text().strip()!=lock.strip():raise RuntimeError('Ghostty resource provenance mismatch')
    notices=prefix/'share/termdock-ghostty/licenses'
    index=json.loads((notices/'index.json').read_text())
    for entry in index:
        source=prefix/entry['bundle_path']
        if not source.resolve().is_relative_to(notices.resolve()) or hashlib.sha256(source.read_bytes()).hexdigest()!=entry['sha256']:raise RuntimeError('Ghostty license index mismatch')
    shutil.copytree(notices,OUT/'licenses/ghostty')
    shutil.copyfile(prefix/'termdock-build.json',OUT/'ghostty-lock.json')
files={}
for path in sorted(OUT.rglob('*')):
    if path.is_symlink():raise RuntimeError('Native resources cannot be symlinks')
    if path.is_file():files[str(path.relative_to(OUT))]={'size':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
revision=os.environ.get('TERMDOCK_PREVIEW_SOURCE_REVISION') or subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
manifest={'version':1,'sourceRevision':revision,'fonts':fonts,'files':files,'ghosttyLicensesIncluded':sys.platform=='darwin'}
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(f'Prepared {len(fonts)} native SFNT faces; all cmap/advance-width mappings match shipped WOFF2')
