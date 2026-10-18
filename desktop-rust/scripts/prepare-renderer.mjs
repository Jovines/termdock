import fs from 'node:fs';
import { build } from 'esbuild';
const source = fs.readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
function block(selector) {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing color tokens: ${selector}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed color token block: ${selector}`);
}
const destination = new URL('../.renderer-dist/', import.meta.url);
fs.mkdirSync(destination, { recursive: true });
const chrome=block(':root').match(/--chrome-bg:\s*#([0-9a-f]{6})/i);
if(!chrome)throw new Error('Missing initial window background token');
fs.writeFileSync(new URL('window-background.json',destination),JSON.stringify([0,2,4].map(offset=>parseInt(chrome[1].slice(offset,offset+2),16))));

fs.writeFileSync(new URL('tokens.css', destination), ['/* Generated from src/index.css */', block(':root'), block("html[data-theme='light']")].join('\n'));
// Use the existing connection center and floating UI verbatim. No parallel UX.
for (const name of ['index.html', 'app.js', 'styles.css', 'floating.html', 'floating.js', 'floating.css']) {
  let text = fs.readFileSync(new URL(`../../desktop/renderer/${name}`, import.meta.url), 'utf8');
  if (name === 'index.html') text = text.replace('class="brand"','class="brand" data-tauri-drag-region').replace('class="topbar"','class="topbar" data-tauri-drag-region').replace('class="rail"','class="rail" data-termdock-window-rail="true"');
  if (name.endsWith('.html')) text = text.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '').replace('Termdock 连接中心', 'Termdock Preview 连接中心');
  if (name === 'app.js') text = text.replace('Termdock Desktop ${snapshot.appVersion}', 'Termdock Preview ${snapshot.appVersion}');
  if (name === 'styles.css') text += `
/* Native recovery feedback uses the same token surfaces as the center. */
.notice:has(.native-recovery-retry) { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.native-recovery-retry { flex-shrink:0; border:1px solid var(--border); border-radius:8px; padding:8px 12px; background:var(--surface); color:var(--foreground); font-weight:600; }
.native-recovery-retry:hover { background:var(--surface-2); }
`;
  fs.writeFileSync(new URL(name, destination), text);
}
await build({ entryPoints: [new URL('../../desktop/renderer/services.tsx', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'iife', minify: true, outfile: new URL('services.js', destination).pathname });
