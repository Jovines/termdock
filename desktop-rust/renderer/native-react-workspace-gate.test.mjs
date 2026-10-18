import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const sharedPrefix=fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8').split('(async()=>{')[0];
const workspaceSource=fs.readFileSync(new URL('./native-react-workspace-gate.js',import.meta.url),'utf8');
const prefix=sharedPrefix+'\n'+workspaceSource.split('(async()=>{')[0];
function fixture(html){
 const dom=new JSDOM(html);const context={window:dom.window,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window)};
 for(const element of context.document.querySelectorAll('*'))element.getBoundingClientRect=()=>({x:0,y:0,width:element.closest('[hidden]')?0:120,height:24});
 vm.runInNewContext(prefix,context);return {window:dom.window,document:context.document,read:context.tdNativeReactLoginForm,settings:context.tdNativeReactSettingsClose,overlays:context.tdNativeReactOverlayEvidence,close:()=>dom.window.close()};
}
test('React nativeOverlay records the independent titlebar receipt before strict startup and overlay checks',()=>{
 const start=workspaceSource.indexOf('if(data.nativeOverlay){'),end=workspaceSource.indexOf('\n   else if(data.nativeKeyboardManual)',start),branch=workspaceSource.slice(start,end);assert(start>=0&&end>start);
 const close=branch.indexOf('await tdNativeReactOverlayCheck'),titlebar=branch.indexOf('await tdNativeGateTitlebarDoubleClick'),record=branch.indexOf('record(`actual owned-header titlebar');
 assert(titlebar>=0&&record>titlebar&&close>record,'Titlebar verification must record its independent receipt before strict startup and overlay checks');
});
test('invitation password belongs to its visible form and accepts default submit, not disabled background login',()=>{
 const f=fixture('<form id="background"><input type="password" disabled><button type="submit" disabled>Login</button></form><div role="dialog"><form id="invitation"><input type="password"><button>登录并连接</button></form></div>');
 try{const login=f.read();assert.equal(login.form.id,'invitation');assert.equal(login.input.form,login.form);assert.equal(login.submit.type,'submit');assert.equal(login.submit.hasAttribute('type'),false);assert.equal(login.submit.form,login.form);assert.notEqual(login.input,f.document.querySelector('input[type=password]'));}finally{f.close();}
});
const settingsPanel='<div role="dialog" aria-labelledby="settings-dialog-title" class="z-drawer-panel"><div><div><h2 id="settings-dialog-title">Settings</h2></div><button type="button" aria-label="Close">header</button></div><button aria-label="Close">unrelated nested setting</button></div>';
test('settings close selects only its own visible enabled header, preserving unrelated dialogs',()=>{
 const f=fixture('<div role="dialog"><button aria-label="Close" id="other">unrelated</button></div><button class="z-drawer-backdrop" aria-label="Close settings"></button>'+settingsPanel);
 try{const other=f.document.querySelector('#other'),selected=f.settings();let otherClicks=0,settingsClicks=0;other.addEventListener('click',()=>otherClicks++);selected.button.addEventListener('click',()=>{settingsClicks++;selected.panel.remove();});const old=[...f.document.querySelectorAll('button[aria-label]')].find(button=>/关闭设置|Close settings|关闭|Close/.test(button.getAttribute('aria-label'))&&button.closest('[role=dialog],.z-drawer-panel,.z-modal-panel,.z-drawer-content'));assert.equal(old,other);assert.notEqual(selected.button,other);assert.equal(selected.button.parentElement.querySelector('#settings-dialog-title')?.id,'settings-dialog-title');selected.button.click();assert.equal(settingsClicks,1);assert.equal(otherClicks,0);assert.equal(other.isConnected,true);assert.equal(f.settings(),null);}finally{f.close();}
});
test('hidden, disabled or ambiguous settings header controls are never clicked',()=>{
 const f=fixture(settingsPanel);
 try{const selected=f.settings();selected.button.disabled=true;assert.equal(f.settings(),null);selected.button.disabled=false;selected.panel.hidden=true;assert.equal(f.settings(),null);selected.panel.hidden=false;selected.button.style.visibility='hidden';assert.equal(f.settings(),null);selected.button.style.visibility='visible';const duplicate=selected.button.cloneNode(true);duplicate.getBoundingClientRect=selected.button.getBoundingClientRect;selected.button.parentElement.append(duplicate);assert.equal(f.settings(),null);duplicate.remove();assert.equal(f.settings().button,selected.button);}finally{f.close();}
});
test('overlay diagnostics are bounded semantic metadata and never export text, arbitrary IDs or history data',()=>{
 const f=fixture(settingsPanel+Array.from({length:12},()=>'<section id="private-user-id" role="alert" aria-labelledby="private-title" class="z-toast private-class">private terminal text</section>').join(''));
 try{f.window.history.replaceState({__termdockOverlay:'settings',secret:'private-history-value'},'');const value=f.overlays(),encoded=JSON.stringify(value);assert.equal(value.count,13);assert.equal(value.items.length,8);assert.equal(value.truncated,true);assert.equal(value.historyOverlay,'settings');assert.equal(value.settingsPresent,true);assert.equal(value.settingsVisible,true);assert.equal(value.items[0].labelledby,'settings-dialog-title');assert.equal(value.items[0].geometry.width,120);for(const text of ['private-user-id','private-title','private-class','private terminal text','private-history-value'])assert.equal(encoded.includes(text),false);f.document.querySelector('[aria-labelledby="settings-dialog-title"]').remove();assert.equal(f.overlays().settingsPresent,false);assert.equal(f.overlays().count,12);}finally{f.close();}
});
test('layer evidence identifies only the known startup and sidebar identities with actual bounded scalar state',()=>{
 const f=fixture('<div id="termdock-startup" class="z-modal-panel" style="opacity:1;pointer-events:auto">private startup text</div><div data-sidebar-backdrop="right" class="z-sidebar-backdrop" style="opacity:0;pointer-events:none"></div><div data-sidebar-backdrop="private-side" class="z-toast"></div>'+Array.from({length:34},()=>'<span data-startup-pending></span>').join(''));
 try{f.document.getElementById('termdock-startup').getAnimations=()=>Array.from({length:6},()=>({playState:'running',pending:false}));const value=f.overlays();assert.equal(value.items[0].startupRoot,true);assert.equal(value.items[0].opacity,1);assert.equal(value.items[0].pointerEvents,'auto');assert.equal(value.items[0].animations.length,4);assert.equal(value.items[0].animationsTruncated,true);assert.equal(value.items[1].sidebarBackdrop,'right');assert.equal(value.items[1].opacity,0);assert.equal(value.items[1].pointerEvents,'none');assert.equal(value.items[2].sidebarBackdrop,null);assert.equal(value.startupPendingMarkers,32);assert.equal(value.startupPendingMarkersTruncated,true);assert.equal(JSON.stringify(value).includes('private-side'),false);assert.equal(JSON.stringify(value).includes('private startup text'),false);}finally{f.close();}
});
test('hidden or inert background forms are excluded, and enabled submit must belong to selected input',()=>{
 const f=fixture('<form hidden><input type="password"><button>hidden</button></form><form inert><input type="password"><button>inert</button></form><form id="actual"><input type="password"><button type="button">Cancel</button><button disabled>Submit</button></form>');
 try{let login=f.read();assert.equal(login.form.id,'actual');assert.equal(login.submit,undefined);login.form.lastElementChild.disabled=false;login=f.read();assert.equal(login.submit.textContent,'Submit');login.input.disabled=true;assert.equal(f.read(),null);}finally{f.close();}
});
test('a replaced form cannot reuse the stale form or submit control',()=>{
 const f=fixture('<form id="before"><input type="password"><button type="submit">Login</button></form>');
 try{const original=f.read();f.document.body.innerHTML='<form id="after"><input type="password"><button>Connect</button></form>';for(const element of f.document.querySelectorAll('input,button'))element.getBoundingClientRect=()=>({width:120,height:24});const current=f.read();assert.equal(original.input.isConnected,false);assert.notEqual(current.form,original.form);assert.equal(current.submit.form,current.input.form);}finally{f.close();}
});
test('owned service WK pre-native comparison waits for real text commit, deduplicates, and removes its controls',async()=>{
 const {window}=new JSDOM('<form><input type="password"></form>');const values=[];let calls=0;
 const context={window,document:window.document,performance,Error};vm.runInNewContext(prefix,context);
 await context.tdNativeReactWKBeforeNative({publish:(phase,value)=>values.push(value),current:()=>{},pause:async()=>{
  const input=window.document.querySelector('[data-owned-wk-before-native] input');calls++;
  if(calls===1){input.dispatchEvent(new window.CompositionEvent('compositionstart'));input.value='a';input.dispatchEvent(new window.InputEvent('input'));}
  if(calls===3){input.value='啊';input.dispatchEvent(new window.CompositionEvent('compositionend'));input.dispatchEvent(new window.InputEvent('input'));window.document.querySelector('button').click();}
 }});
 assert.equal(values[0].committed,false);assert(values.some(v=>v.composing&&!v.committed));assert.equal(values.at(-1).committed,true);assert.equal(values.at(-1).compositionEnd,1);assert.equal(window.document.querySelector('[data-owned-wk-before-native]'),null);assert(!JSON.stringify(values).includes('啊'));window.close();
});
test('owned service WK pre-native cancellation removes the temporary input without logging text',async()=>{
 const {window}=new JSDOM('');const context={window,document:window.document,performance,Error};vm.runInNewContext(prefix,context);
 await assert.rejects(context.tdNativeReactWKBeforeNative({publish:()=>{},pause:async()=>{},current:()=>{throw Error('epoch cancelled');}}),/epoch cancelled/);
 assert.equal(window.document.querySelector('input'),null);window.close();
});

test('startup evidence reads only fixed readiness booleans and existing exact milestones',()=>{
 const f=fixture('<div data-owned-terminal-startup></div>');
 try{
  f.window.performance.getEntriesByName=name=>name==='termdock:startup:foreground-viewport-ready'?[{}]:[];
  f.document.querySelector('div').setAttribute('data-owned-terminal-startup',JSON.stringify({active:true,viewportReady:true,streamReady:true,contentReady:false,sizeReady:'private',text:'private output'}));
  const value=f.overlays();assert.equal(value.startupMilestones.viewportReady,true);assert.equal(value.startupMilestones.contentReady,false);assert.equal(value.startupMilestones.presented,false);
  assert.equal(value.startupTerminals[0].contentReady,false);assert.equal(value.startupTerminals[0].sizeReady,null);assert.equal(JSON.stringify(value).includes('private'),false);
 }finally{f.close();}
});
for(const hidden of [false,true])test(`owned browser benchmark ${hidden?'rejects a hidden document':'uses xterm without native requests or subscriptions'}`,async()=>{
 const dom=new JSDOM('<div class="terminal-viewport-container" data-termdock-terminal-dropzone="owned"><div class="xterm"></div></div>',{url:'http://127.0.0.1:12345',pretendToBeVisual:true});
 const {window}=dom;Object.defineProperty(window.document,'hidden',{value:hidden,configurable:true});let nativeRequests=0,nativeSubscriptions=0,benchmark=null;
 window.__TD_NATIVE_GATE_NONCE='owned';window.__TD_NATIVE_GATE_EPOCH='epoch';window.__TD_PREVIEW_BENCH_RENDERER='browser';
 window.termdockDesktop={nativeTerminal:{available:false,request:()=>{nativeRequests++;throw Error('Unexpected native request');},subscribe:()=>{nativeSubscriptions++;throw Error('Unexpected native subscription');}}};
 window.sessionStorage.setItem('termdock-react-gate-reload',JSON.stringify({steps:[],acks:[],stages:[],stageDropped:0}));
 window.document.querySelector('[data-termdock-terminal-dropzone]').dataset.ownedRendererMetrics=JSON.stringify({nonce:'owned',epoch:'epoch',renderer:'dom',requestedRenderer:'auto',fontSize:13,fontFamily:'Termdock Mono',history:1000});
 window.document.querySelector('[data-termdock-terminal-dropzone]').getBoundingClientRect=()=>({x:0,y:0,width:800,height:600});
 window.fetch=async(_url,init)=>{if(init?.body){const request=JSON.parse(init.body);assert.equal(request.action,'benchmark-output');benchmark={...request,done:true,bytes:0,chunks:0,expectedBytes:0,expectedChunks:0,epoch:"stream",lastSeq:1};}return{ok:true,json:async()=>({fixture:'actual-old-router-react-terminal-model-v1',sequence:1,epoch:'stream',events:[{type:'resize',cols:80,rows:24},{type:'output-ack',since:1,flowSeq:1,epoch:'stream'}],benchmark})};};
 let finish;const completed=new Promise(resolve=>{finish=resolve;});
 const context={window,navigator:window.navigator,document:window.document,sessionStorage:window.sessionStorage,devicePixelRatio:1,performance:window.performance,setTimeout:(callback,ms)=>setTimeout(callback,ms===10000?0:ms),clearTimeout,getComputedStyle:window.getComputedStyle.bind(window),tdNativeGateRequester:()=>()=>{nativeRequests++;throw Error('Unexpected native request');},tdNativeGateSignal:(_nonce,kind,value)=>{if(kind==='result')finish(value);}};
 try{
  vm.runInNewContext(workspaceSource,context);
  const result=await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Browser benchmark driver did not finish')),1500))]);
  if(hidden){assert.equal(result.ok,false);assert.match(result.error,/hidden document/);assert.equal(benchmark,null);assert.equal(nativeRequests,0);return;}
  assert.equal(result.ok,true,result.error);assert.equal(result.benchmarkRenderer,'browser');
  assert.equal(nativeRequests,0);assert.equal(nativeSubscriptions,0);
  assert.deepEqual(Array.from(result.steps.filter(item=>item.name==='owned renderer comparison phase complete'),item=>item.value.profile),['idle','steady','burst']);
 }finally{dom.window.close();}
});
