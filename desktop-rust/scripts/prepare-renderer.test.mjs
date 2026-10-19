import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {JSDOM} from 'jsdom';
test('actual Preview renderer generation marks only the real rail/header hosts and preserves shared CSS geometry',()=>{
  const script=new URL('./prepare-renderer.mjs',import.meta.url);
  const result=spawnSync(process.execPath,[script.pathname],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const generated=fs.readFileSync(new URL('../.renderer-dist/index.html',import.meta.url),'utf8');
  const dom=new JSDOM(generated),doc=dom.window.document;
  try {
    assert.equal(doc.querySelectorAll('aside.rail[data-termdock-window-rail="true"]').length,1);
    assert.equal(doc.querySelectorAll('.brand[data-tauri-drag-region]').length,1);
    assert.equal(doc.querySelectorAll('.topbar[data-tauri-drag-region]').length,1);
    for(const selector of ['html','body','.app-shell','.workspace','.rail-nav'])assert.equal(doc.querySelector(selector).hasAttribute('data-tauri-drag-region'),false);
    for(const selector of ['html','body','.app-shell','.workspace','.rail-nav'])assert.equal(doc.querySelector(selector).hasAttribute('data-termdock-window-rail'),false);
    assert.equal(doc.querySelector('aside.rail > .brand').hasAttribute('data-tauri-drag-region'),true);
  }finally{dom.window.close();}
  const styles=fs.readFileSync(new URL('../.renderer-dist/styles.css',import.meta.url),'utf8');
  const shared=fs.readFileSync(new URL('../../desktop/renderer/styles.css',import.meta.url),'utf8');
  assert.ok(styles.startsWith(shared),'shared center geometry must remain unchanged');
  assert.equal(styles,shared,'center styling is shared without engine recovery overrides');
  assert.equal(fs.readFileSync(new URL('../.renderer-dist/floating.css',import.meta.url),'utf8'),fs.readFileSync(new URL('../../desktop/renderer/floating.css',import.meta.url),'utf8'));
});
