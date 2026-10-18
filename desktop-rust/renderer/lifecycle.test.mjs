import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function fixture(){
 const attrs=new Map(),styles=[],nodes=[],frames=[],calls=[],events=[],listeners=new Map();let observed,observerOptions;const status=[];
 const element=()=>({dataset:{},children:[],handlers:{},setAttribute(){},append(node){this.children.push(node);},replaceChildren(){this.children=[];},addEventListener(name,fn){this.handlers[name]=fn;},remove(){const i=status.indexOf(this);if(i>=0)status.splice(i,1);}});
 const html={setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),toggleAttribute:(k,on)=>on?attrs.set(k,''):attrs.delete(k)};
 const document={documentElement:html,head:{append:node=>styles.push(node)},body:{append:node=>status.push(node)},createElement:element,querySelectorAll:()=>nodes,querySelector:()=>({remove(){}}),hasFocus:()=>true,hidden:false,addEventListener(){},removeEventListener(){}};
 const window={top:null,termdockDesktop:{nativeTerminal:{available:true,request:request=>new Promise((resolve,reject)=>calls.push({request,resolve:value=>resolve(request.action==='prepareOverlay'&&value.hidden===true?{...value,ready:true,hidden:undefined}:value),reject}))}},addEventListener:(k,v)=>listeners.set(k,v),removeEventListener(){},dispatchEvent:event=>events.push(event),visualViewport:{scale:1,addEventListener(){},removeEventListener(){}}};window.top=window;
 const context={window,document,innerWidth:800,innerHeight:600,getComputedStyle:node=>({display:'block',opacity:'1',pointerEvents:'auto',...node.style}),MutationObserver:class{constructor(fn){observed=fn;}observe(_node,options){observerOptions=options;}disconnect(){}},requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){},queueMicrotask,CustomEvent:class{constructor(type,payload){this.type=type;this.detail=payload.detail;}},Promise,Set,String,Array,Object,Math,Number};
 vm.runInNewContext(fs.readFileSync(new URL('./lifecycle.js',import.meta.url),'utf8'),context);
 const frame=()=>frames.splice(0).forEach(fn=>fn());
 const add=()=>{const node={rect:{x:0,y:0,width:100,height:100},getAttribute:()=>null,getBoundingClientRect(){return this.rect;}};nodes.push(node);observed([{target:{},type:'childList'}]);return node;};
 return{window,attrs,styles,nodes,calls,events,listeners,frame,add,status,options:()=>observerOptions,observed:()=>observed};
}
test('global overlays are CSS-gated until the native panel cutout transaction is confirmed',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);assert.match(f.styles[0].textContent,/visibility:hidden !important/);assert(f.attrs.has('data-native-panels'));
 f.add();f.frame();assert.equal(f.calls[0].request.action,'prepareOverlay');assert.equal(JSON.stringify(f.calls[0].request.holes),'[[0,0,100,100]]');assert(!f.attrs.has('data-native-overlays-ready'));
 const gen=f.calls[0].request.generation;f.calls[0].resolve({ready:true,generation:gen,epoch:'page',views:['a','b']});await new Promise(resolve=>setTimeout(resolve,0));assert(f.attrs.has('data-native-overlays-ready'));
 f.nodes.length=0;f.observed()([{target:{},type:'childList'}]);f.frame();assert.equal(f.calls[1].request.action,'resumeAll');assert(!f.attrs.has('data-native-overlays-ready'));
});
test('a stale generation cannot expose an overlay for a newer native layout',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);f.add();f.frame();const first=f.calls[0];api.nativePanels(true);first.resolve({hidden:true,generation:first.request.generation,epoch:'old',views:['old']});await new Promise(resolve=>setTimeout(resolve,0));assert(!f.attrs.has('data-native-overlays-ready'));
});
test('an invalid clip receipt falls back to confirmed hide before retirement',async()=>{
 const f=fixture();f.window.termdockPreviewLifecycle.nativePanels(true);f.add();f.frame();f.calls[0].resolve({pending:true});await turn();assert.equal(f.calls[1].request.action,'hideAll');assert(!f.attrs.has('data-native-overlays-ready'));f.calls[1].resolve({pending:true});await turn();assert.equal(f.calls[2].request.action,'retireAll');assert.equal(f.events.length,0);
});
test('failed hide releases DOM only after an actual detach receipt',async()=>{
 const f=fixture();f.window.termdockPreviewLifecycle.nativePanels(true);f.add();f.frame();f.calls[0].reject(new Error('hide failure'));await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(f.calls[1].request.action,'hideAll');f.calls[1].reject(new Error('hide failure'));await turn();assert.equal(f.calls[2].request.action,'retireAll');assert(!f.attrs.has('data-native-overlays-ready'));
 f.calls[2].resolve({hidden:true,retired:true,generation:f.calls[2].request.generation,views:['a'],epoch:'page'});await new Promise(resolve=>setTimeout(resolve,0));assert(f.attrs.has('data-native-overlays-ready'));assert.equal(f.events[0].type,'termdock:preview-error');
});
test('a second overlay is gated synchronously before its first paint',async()=>{
 const f=fixture();f.window.termdockPreviewLifecycle.nativePanels(true);f.add();f.frame();f.calls[0].resolve({hidden:true,generation:f.calls[0].request.generation,views:['a'],epoch:'page'});await new Promise(resolve=>setTimeout(resolve,0));assert(f.attrs.has('data-native-overlays-ready'));
 f.add();assert(!f.attrs.has('data-native-overlays-ready'));f.frame();assert.equal(f.calls[1].request.action,'prepareOverlay');
});
test('same-owner overlay animation keeps its hide receipt while geometry changes',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);const overlay=f.add();await turn();
 const hide=f.calls[0];hide.resolve({hidden:true,generation:hide.request.generation,views:['actual-view'],epoch:'page'});await turn();
 for(let frame=1;frame<=6;frame++){
  overlay.rect={x:frame*12,y:20+frame,width:100+frame,height:100};
  f.observed()([{target:overlay,type:'attributes',attributeName:'style'}]);await turn();f.frame();await turn();
  assert.equal(api.snapshot().overlayReady,true);assert.equal(api.snapshot().gate.acknowledged,Number(hide.request.generation));
  assert.equal(f.calls.length,1,'motion must not repeat the whole-view hide');
 }
});

test('double failure preserves gate and exposes a non-gated recovery with actual detach retry',async()=>{
 const f=fixture();f.window.termdockPreviewLifecycle.nativePanels(true);f.add();f.frame();
 f.calls[0].reject(Error('clip rejected'));await turn();f.calls[1].reject(Error('hide rejected'));await turn();f.calls[2].reject(Error('detach rejected'));await new Promise(r=>setTimeout(r,0));
 assert(!f.attrs.has('data-native-overlays-ready'));assert.equal(f.status.length,1);assert.equal(f.status[0].dataset.nativeRecovery,'true');assert.match(f.styles[0].textContent,/:not\(\[data-native-recovery\]\)/);
 const button=f.status[0].children[1];button.handlers.click();await new Promise(r=>setTimeout(r,0));const retry=f.calls[3];assert.equal(retry.request.action,'hideAll');assert(!f.attrs.has('data-native-overlays-ready'));
 retry.resolve({hidden:true,generation:retry.request.generation,views:['a']});await new Promise(r=>setTimeout(r,0));assert(f.attrs.has('data-native-overlays-ready'));assert.equal(f.status.length,0);
});
test('existing node role changes invalidate the gate before paint',async()=>{
 const f=fixture();f.window.termdockPreviewLifecycle.nativePanels(true);assert(f.options().attributeFilter.includes('role'));
 for(const role of ['dialog','menu','tooltip','alert']){
  f.add();f.frame();const hide=f.calls.at(-1);hide.resolve({hidden:true,generation:hide.request.generation,views:['a']});await new Promise(r=>setTimeout(r,0));
  f.nodes.push({getAttribute:()=>null,getBoundingClientRect:()=>({x:10,y:20,width:50,height:50})});f.observed()([{target:{},type:'attributes',attributeName:'role'}]);assert(!f.attrs.has('data-native-overlays-ready'),role);
  f.frame();const next=f.calls.at(-1);next.resolve({hidden:true,generation:next.request.generation,views:['a']});await new Promise(r=>setTimeout(r,0));
 }
});

const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
test('stopped presentation frames cannot postpone the ordinary DOM overlay hide receipt',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);f.add();await turn();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].request.action,'prepareOverlay');assert.equal(api.snapshot().overlayReady,false);assert(!f.attrs.has('data-native-overlays-ready'));
 f.calls[0].resolve({hidden:true,generation:f.calls[0].request.generation,views:['actual-view'],epoch:'page'});await turn();
 assert.equal(api.snapshot().overlayReady,true);f.frame();await turn();assert.equal(f.calls.length,1);
 f.nodes.length=0;f.observed()([{target:{},type:'childList'}]);await turn();assert.equal(f.calls[1].request.action,'resumeAll');
 f.calls[1].resolve({generation:f.calls[1].request.generation,epoch:'page'});await turn();assert.equal(api.snapshot().gate.status,'resume-confirmed');
});
test('stopped presentation with malformed hide and delayed detach retains first-paint protection',async()=>{
 const f=fixture();f.window.termdockPreviewLifecycle.nativePanels(true);f.add();await turn();
 f.calls[0].resolve({pending:true});await turn();assert.equal(f.calls[1].request.action,'hideAll');f.calls[1].resolve({pending:true});await turn();assert.equal(f.calls[2].request.action,'retireAll');assert(!f.attrs.has('data-native-overlays-ready'));
 f.calls[2].resolve({hidden:true,retired:true,generation:f.calls[2].request.generation,views:['actual-view'],epoch:'page'});await turn();
 assert(f.attrs.has('data-native-overlays-ready'));assert.equal(f.window.termdockPreviewLifecycle.snapshot().gate.status,'detach-confirmed');
});
test('stopped presentation rejects an old generation and waits for the current host receipt',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);f.add();await turn();const old=f.calls[0];
 api.nativePanels(true);old.resolve({hidden:true,generation:old.request.generation,views:['old'],epoch:'page'});await turn();
 assert(!f.attrs.has('data-native-overlays-ready'));assert.equal(f.calls.length,2);assert.notEqual(f.calls[1].request.generation,old.request.generation);
 f.calls[1].resolve({hidden:true,generation:f.calls[1].request.generation,views:['current'],epoch:'page'});await turn();assert.equal(api.snapshot().overlayReady,true);
});
test('stopped presentation confirms safety without claiming a running DOM animation has settled',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);f.add();f.nodes[0].getAnimations=()=>[{playState:'running'}];await turn();
 f.calls[0].resolve({hidden:true,generation:f.calls[0].request.generation,views:['actual'],epoch:'page'});await turn();
 assert.equal(api.snapshot().overlayReady,true);assert.equal(api.snapshot().moving,true);assert.equal(api.snapshot().gate.status,'clip-confirmed');
});

test('stopped presentation does not expose an unconfirmed or malformed resume',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);f.add();await turn();
 f.calls[0].resolve({hidden:true,generation:f.calls[0].request.generation,views:['actual'],epoch:'page'});await turn();f.nodes.length=0;f.observed()([{target:{},type:'childList'}]);await turn();
 assert.equal(api.snapshot().overlayReady,false);assert.equal(api.snapshot().gate.resuming,true);
 f.calls[1].resolve({pending:true});await turn();assert.equal(api.snapshot().overlayReady,false);assert.equal(api.snapshot().gate.failed,true);assert.equal(f.status.length,1);
});

test('an old resume receipt cannot release a newer ordinary DOM overlay',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);f.add();await turn();f.calls[0].resolve({hidden:true,generation:f.calls[0].request.generation,views:['a'],epoch:'page'});await turn();
 f.nodes.length=0;f.observed()([{target:{},type:'childList'}]);await turn();const resume=f.calls[1];
 f.add();await turn();assert.equal(f.calls[2].request.action,'prepareOverlay');resume.resolve({generation:resume.request.generation,epoch:'page'});await turn();assert(!f.attrs.has('data-native-overlays-ready'));assert.equal(api.snapshot().overlayReady,false);
 f.calls[2].resolve({hidden:true,generation:f.calls[2].request.generation,views:['a'],epoch:'page'});await turn();assert.equal(api.snapshot().overlayReady,true);assert.equal(api.snapshot().gate.resuming,false);
});

const staticBackdrop=()=>({style:{opacity:'0',pointerEvents:'none'},getAttribute:name=>name==='data-sidebar-backdrop'?'right':null,getBoundingClientRect:()=>({x:0,y:0,width:800,height:600}),getAnimations:()=>[],querySelectorAll:()=>[]});
test('inactive transparent sidebar backdrop is excluded while the real startup surface remains gated',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);const backdrop=staticBackdrop();f.nodes.push(backdrop);f.observed()([{target:backdrop,type:'childList'}]);await turn();assert.equal(api.snapshot().overlays.length,0);assert.equal(f.calls.length,0);
 f.add();await turn();assert.equal(api.snapshot().overlays.length,1);assert.equal(f.calls[0].request.action,'prepareOverlay');assert(!f.attrs.has('data-native-overlays-ready'));
 f.calls[0].resolve({hidden:true,generation:f.calls[0].request.generation,views:['a']});await turn();f.nodes.splice(1);f.observed()([{target:{},type:'childList'}]);await turn();assert.equal(api.snapshot().overlays.length,0);assert.equal(f.calls[1].request.action,'resumeAll');assert.equal(api.snapshot().overlayReady,false);
});
test('an opening opacity-zero backdrop with pointer events retains first-paint protection without frames',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);const backdrop=staticBackdrop();f.nodes.push(backdrop);f.observed()([{target:backdrop,type:'childList'}]);await turn();backdrop.style.pointerEvents='auto';f.observed()([{target:backdrop,type:'attributes',attributeName:'style'}]);assert(!f.attrs.has('data-native-overlays-ready'));await turn();assert.equal(api.snapshot().overlays.length,1);assert.equal(f.calls[0].request.action,'prepareOverlay');
});
test('transparent overlay motion, pending animations and interactive children cannot bypass isolation',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);const node=staticBackdrop();f.nodes.push(node);
 node.getAnimations=()=>[{playState:'running'}];assert.equal(api.snapshot().overlays.length,1);assert.equal(api.snapshot().moving,true);
 node.getAnimations=()=>[{playState:'idle',pending:true}];assert.equal(api.snapshot().overlays.length,1);
 node.getAnimations=()=>[];node.querySelectorAll=()=>[{style:{pointerEvents:'auto',visibility:'hidden'},getBoundingClientRect:()=>({width:20,height:20})}];assert.equal(api.snapshot().overlays.length,1);f.observed()([{target:node,type:'attributes',attributeName:'style'}]);await turn();assert.equal(f.calls[0].request.action,'prepareOverlay');assert(!f.attrs.has('data-native-overlays-ready'));
});
test('unknown or excessive transparent descendants remain conservatively gated',()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);const node=staticBackdrop();f.nodes.push(node);node.querySelectorAll=()=>Array(65);assert.equal(api.snapshot().overlays.length,1);node.querySelectorAll=()=>{throw Error('unknown children');};assert.equal(api.snapshot().overlays.length,1);node.querySelectorAll=()=>[];node.shadowRoot={};assert.equal(api.snapshot().overlays.length,1);delete node.shadowRoot;delete node.getAnimations;assert.equal(api.snapshot().overlays.length,1);
});

test('cleanup retry needs a real retirement plus hide receipt to release the failed gate',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);api.nativePanels(true);api.nativePanels(true);await turn();
 let result='not-current';const retry=()=>Promise.resolve(result);
 f.listeners.get('termdock:native-cleanup-error')({detail:{message:'old cleanup failed',retry}});
 f.listeners.get('termdock:native-isolation-retry')();await turn();assert.equal(api.snapshot().gate.failed,true);assert.equal(f.calls.length,0);assert.equal(f.status.length,1);
 result='detached';f.listeners.get('termdock:native-isolation-retry')();await turn();
 assert.equal(f.calls[0].request.action,'hideAll');assert.equal(api.snapshot().gate.failed,true);
 f.calls[0].resolve({hidden:true,generation:f.calls[0].request.generation,views:['third']});await turn();
 assert.equal(api.snapshot().gate.failed,false);assert.equal(f.status.length,0);
 // Removing the first two owners must leave the third able to resume layout.
 api.nativePanels(false);api.nativePanels(false);await turn();assert.equal(api.snapshot().gate.nativePanels,1);
 const resume=f.calls.at(-1);assert.equal(resume.request.action,'resumeAll');resume.resolve({generation:resume.request.generation,epoch:'current'});await turn();assert.equal(api.snapshot().overlayReady,true);
});
test('an older retry receipt cannot clear a newer cleanup failure',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);await turn();let finish;
 f.listeners.get('termdock:native-cleanup-error')({detail:{message:'first',retry:()=>new Promise(resolve=>{finish=resolve;})}});
 f.listeners.get('termdock:native-isolation-retry')();await turn();
 f.listeners.get('termdock:native-cleanup-error')({detail:{message:'second',retry:()=>Promise.resolve('not-current')}});
 finish('detached');await turn();assert.equal(api.snapshot().gate.failed,true);assert.equal(f.status.length,1);assert.equal(f.calls.length,0);
});
test('a rejected older retry cannot replace a newer cleanup failure',async()=>{
 const f=fixture();let reject,newRetries=0;
 f.listeners.get('termdock:native-cleanup-error')({detail:{message:'old',retry:()=>new Promise((_resolve,no)=>{reject=no;})}});
 f.listeners.get('termdock:native-isolation-retry')();await turn();
 f.listeners.get('termdock:native-cleanup-error')({detail:{message:'new',retry:()=>{newRetries++;return Promise.resolve('not-current');}}});
 reject(Error('late old rejection'));await turn();assert.equal(f.status.length,1);assert.equal(f.status[0].children[0].textContent,'原生终端暂时无法恢复，服务端会话已保留。');f.listeners.get('termdock:native-isolation-retry')();await turn();assert.equal(newRetries,1);
});
test('actual center scripts suppress a recovered notice whose DOMContentLoaded show is still queued',()=>{
 const source=fs.readFileSync(new URL('../src-tauri/src/shell.rs',import.meta.url),'utf8');
 const scripts=[...source.matchAll(/local\.eval\(&format!\("((?:[^"\\]|\\.)*)"\)\)/g)].map(match=>JSON.parse('"'+match[1]+'"'));
 const expand=text=>text.replaceAll('{label}',JSON.stringify('owned-window')).replaceAll('{recovery_id}',JSON.stringify('page:1')).replaceAll('{id}',JSON.stringify('page:1')).replaceAll('{message}',JSON.stringify('owned failure')).replaceAll('{{','{').replaceAll('}}','}');
 const show=scripts.find(script=>script.includes('const state={{owner:')),clear=scripts.find(script=>script.includes('state.recovered=true'));
 assert(show&&clear);let onload;const notice={hidden:true,dataset:{},classList:{add(){}},replaceChildren(){},append(){}};
 const document={readyState:'loading',querySelector:()=>notice,addEventListener:(_name,fn)=>{onload=fn;},createElement:()=>({dataset:{}})};
 const context={window:{},document};vm.runInNewContext(expand(show),context);vm.runInNewContext(expand(clear),context);onload();assert.equal(notice.hidden,true);
});

test('rounded overlays cut out their silhouette instead of a square backing patch',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle;api.nativePanels(true);const node=f.add();
 node.rect={x:40,y:50,width:200,height:60};
 node.style={borderTopLeftRadius:'8px',borderTopRightRadius:'8px',borderBottomLeftRadius:'8px',borderBottomRightRadius:'8px'};
 f.frame();const holes=f.calls[0].request.holes;
 assert(holes.length>1&&holes.length<=64);
 assert(!holes.some(([x,y,w,h])=>x<=40&&y<=50&&x+w>40&&y+h>50),'top-left outside corner stays native');
 assert(holes.some(([x,y,w,h])=>x<=140&&y<=80&&x+w>=140&&y+h>=80),'toast center is exposed');
 assert.equal(JSON.stringify(api.snapshot().overlays.map(r=>[r.x,r.y,r.width,r.height])),JSON.stringify(holes),'ongoing native rect updates use the same silhouette');
});

test('recovered native lease clears only its own notice and cannot hide another failed pane',async()=>{
 const f=fixture(),api=f.window.termdockPreviewLifecycle,show=(id)=>f.listeners.get('termdock:native-cleanup-error')({detail:{message:id,retry:()=>Promise.resolve('not-current'),recoveryId:id}});
 show('pane-a');show('pane-b');
 f.listeners.get('termdock:native-cleanup-resolved')({detail:{recoveryIds:['unrelated']}});assert.equal(api.snapshot().gate.failed,true);
 f.listeners.get('termdock:native-cleanup-resolved')({detail:{recoveryIds:['pane-b']}});assert.equal(api.snapshot().gate.failed,true);assert.equal(f.status.length,1);
 f.listeners.get('termdock:native-cleanup-resolved')({detail:{recoveryIds:['pane-a']}});assert.equal(api.snapshot().gate.failed,false);assert.equal(f.status.length,0);
});

test('the center recovery button is clickable and re-enables after a rejected native recovery',async()=>{
 const source=fs.readFileSync(new URL('../src-tauri/src/shell.rs',import.meta.url),'utf8');
 const raw=[...source.matchAll(/local\.eval\(&format!\("((?:[^"\\]|\\.)*)"\)\)/g)].map(match=>JSON.parse('"'+match[1]+'"')).find(script=>script.includes('const state={{owner:'));
 const script=raw.replaceAll('{label}',JSON.stringify('workspace-a')).replaceAll('{recovery_id}',JSON.stringify('page:1')).replaceAll('{message}',JSON.stringify('recovery failed')).replaceAll('{{','{').replaceAll('}}','}');
 const children=[],notice={hidden:true,dataset:{},classList:{add(){}},replaceChildren(){children.length=0;},append(node){children.push(node);}};
 const calls=[],document={readyState:'complete',querySelector:()=>notice,createElement:()=>({dataset:{}})};
 vm.runInNewContext(script,{document,window:{termdockDesktop:{retryNativeIsolation:(...args)=>{calls.push(args);return Promise.reject(Error('controlled'));}}}});
 const button=children[1];assert(!button.disabled);button.onclick();assert.equal(button.disabled,true);await turn();assert.equal(button.disabled,false);assert.deepEqual(calls,[['workspace-a','page:1']]);
});
