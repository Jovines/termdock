import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {webcrypto} from 'node:crypto';
const source = fs.readFileSync(new URL('./bridge.js', import.meta.url), 'utf8');
function fixture(overrides = {}) {
  const calls = [], socketCalls = [], ipc = [], storage = overrides.storage??new Map(), listeners=new Map(), handlers=new Map();
  const batch='11111111-1111-4111-8111-111111111111', receipt='22222222-2222-4222-8222-222222222222'; let data=[];
  class Socket { static OPEN = 1; static CLOSED = 3; constructor(...args) { socketCalls.push(args); } }
  const boot = { origin: 'http://127.0.0.1:43000', origins: ['https://entry.test','https://target.test'], defaultRoute: 1, connection: { url:'https://entry.test', serviceOrigin:'https://target.test', targetPeerId:'target-pin', entryServiceId:'entry-pin', label:'Target' }, platform:'darwin', version:'0.1.0', ...overrides };
  const window = { __TD_PREVIEW_BOOT__:boot, __TAURI_INTERNALS__:{ invoke:async (command,args) => {
      ipc.push({command,...args}); if(overrides.invoke) return overrides.invoke(args.op,args.args,ipc);
      if(args.op==='clipboardImage'||args.op==='clipboardFiles') {data=args.op==='clipboardImage'?[1,2,255]:[0,255];return {batch,files:[{name:'local.dat',type:'application/octet-stream',index:0,size:data.length}]};}
      if(args.op==='fileChunk') return {index:0,seq:args.args.seq,offset:0,length:data.length,eof:true,receipt,base64:Buffer.from(data).toString('base64')};
      if(args.op==='releaseFiles')return null;
      if (args.op === 'notification') return false; if (args.op === 'updateState') return {status:'error',error:'Preview channel not configured'};
    } },
    fetch:overrides.fetch??(async (...args) => { calls.push(args); if (overrides.fetchError) throw new TypeError('disconnected'); return new Response('public'); }), WebSocket:Socket, setTimeout,clearTimeout,addEventListener:(name,fn)=>{const list=handlers.get(name)||[];list.push(fn);handlers.set(name,list);listeners.set(name,event=>[...list].forEach(handler=>handler(event)));}, removeEventListener:(name,fn)=>{const list=handlers.get(name)||[];const index=list.indexOf(fn);if(index>=0)list.splice(index,1);} };
  window.top=overrides.frame ? {} : window;
  const context = {window, location:{origin:boot.origin, pathname:'/', hash:''}, navigator:{serviceWorker:{getRegistrations:async()=>[],register:async()=>({scope:boot.origin+'/'})}}, sessionStorage:{setItem:(key,value)=>storage.set(key,value),getItem:key=>storage.get(key)??null}, AbortController, Request, Response, URL, TypeError, Error, Uint8Array, TextEncoder,crypto:webcrypto, atob, btoa, Blob, Number, Promise, Object, Set, String, JSON, queueMicrotask, ...overrides.context};
  vm.runInNewContext(source, context);
  return { window,calls,socketCalls,ipc,storage,context,listeners };
}
test('actual bridge preserves an invitation across failed/stale guards and suppresses only its completed fingerprint on a new document',async()=>{
 const invitation='controlled-private-invitation',first=fixture({invitation});
 const fingerprint=Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(invitation))).toString('hex');
 assert.equal((await first.window.termdockDesktop.getServiceConnection()).invitation,invitation);
 assert.equal(await first.window.termdockDesktop.acknowledgeServiceInvitation({targetPeerId:'other',fingerprint},()=>true),false);
 assert.equal(await first.window.termdockDesktop.acknowledgeServiceInvitation({targetPeerId:'target-pin',fingerprint},()=>false),false);
 assert.equal((await first.window.termdockDesktop.getServiceConnection()).invitation,invitation);
 assert.equal(await first.window.termdockDesktop.acknowledgeServiceInvitation({targetPeerId:'target-pin',fingerprint},()=>true),true);
 assert(!first.storage.get('termdock-secure-preview-invitation-v1').includes(invitation));assert.equal(first.ipc.length,0);
 const next=fixture({invitation,storage:first.storage});assert.equal((await next.window.termdockDesktop.getServiceConnection()).invitation,undefined);
 for(const overrides of [{invitation:'new-private-invitation'},{origin:'http://127.0.0.1:43001'},{connection:{url:'https://entry.test',serviceOrigin:'https://target.test',targetPeerId:'other',entryServiceId:'entry-pin',label:'Target'}}]){
  const other=fixture({invitation,storage:first.storage,...overrides});assert.equal((await other.window.termdockDesktop.getServiceConnection()).invitation,overrides.invitation??invitation);
 }
 const closed=fixture({invitation});closed.listeners.get('pagehide')({});assert.equal(await closed.window.termdockDesktop.acknowledgeServiceInvitation({targetPeerId:'target-pin',fingerprint},()=>true),false);
});
test('Preview page confirmation waits for overlay readiness and initializes focus once; cancel never invokes native business',async()=>{
 const dom=new JSDOM('<button id="before">Before</button>'),f=fixture({context:{document:dom.window.document}}),doc=dom.window.document;let notify,unsubscribed=false;doc.querySelector('#before').focus();
 f.window.termdockPreviewLifecycle={subscribe:callback=>{notify=callback;callback({overlayReady:false});return()=>{unsubscribed=true;};}};
 try{const pending=f.window.termdockDesktop.confirm({title:'Restart',message:'<img src=x onerror=alert(1)>',confirmLabel:'Confirm',cancelLabel:'Cancel'});await Promise.resolve();const panel=doc.querySelector('[data-desktop-confirmation]'),buttons=panel.querySelectorAll('button');assert.equal(panel.querySelector('img'),null);assert.match(panel.textContent,/<img/);assert.equal(doc.activeElement.id,'before');notify({overlayReady:true});assert.equal(doc.activeElement,buttons[0]);buttons[1].focus();notify({overlayReady:true});assert.equal(doc.activeElement,buttons[1]);buttons[0].click();assert.equal(await pending,false);assert.equal(unsubscribed,true);assert.equal(doc.querySelector('[data-desktop-confirmation]'),null);assert.equal(f.ipc.length,0);assert.equal(doc.activeElement.id,'before');}finally{dom.window.close();}
});
test('Preview confirmation accepts only the explicit button, rejects concurrent prompts and expires on secure context changes',async()=>{
 const dom=new JSDOM(''),f=fixture({context:{document:dom.window.document}}),doc=dom.window.document,options={title:'Restart',message:'Controlled only',confirmLabel:'Confirm',cancelLabel:'Cancel'};
 try{let pending=f.window.termdockDesktop.confirm(options);await assert.rejects(f.window.termdockDesktop.confirm(options),/already open/);doc.querySelector('[data-desktop-confirmation] button:last-child').click();assert.equal(await pending,true);
 pending=f.window.termdockDesktop.confirm(options);f.listeners.get('termdock:secure-state')({});assert.equal(await pending,false);assert.equal(doc.querySelector('[data-desktop-confirmation]'),null);
 pending=f.window.termdockDesktop.confirm(options);doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(await pending,false);assert.equal(f.ipc.length,0);await assert.rejects(f.window.termdockDesktop.confirm({...options,message:'x'.repeat(2049)}),/Invalid/);}finally{dom.window.close();}
});
test('entry, target, relay, renewal and metadata all keep their exact route', async()=>{
  const f=fixture();
  new f.window.WebSocket('wss://entry.test/api/federation/secure');
  new f.window.WebSocket('wss://target.test/api/federation/secure');
  new f.window.WebSocket('wss://entry.test/api/federation/relay?routeToken=opaque');
  new f.window.WebSocket('wss://target.test/api/federation/secure');
  assert.deepEqual(f.socketCalls.map(([url])=>url),[
    'ws://127.0.0.1:43000/__td_route/0/api/federation/secure',
    'ws://127.0.0.1:43000/__td_route/1/api/federation/secure',
    'ws://127.0.0.1:43000/__td_route/0/api/federation/relay?routeToken=opaque',
    'ws://127.0.0.1:43000/__td_route/1/api/federation/secure']);
  await f.window.fetch('/api/meta'); await f.window.fetch('https://entry.test/api/auth/status');
  assert.equal(f.calls[0][0], 'http://127.0.0.1:43000/__td_route/1/api/meta');
  assert.equal(f.calls[1][0], 'http://127.0.0.1:43000/__td_route/0/api/auth/status');
  assert.equal(f.window.WebSocket.OPEN,1);
  const target=JSON.parse(f.storage.get('termdock-secure-target-v1'));
  assert.equal(target.targetPeerId,'target-pin'); assert.equal(target.serviceOrigin,'https://target.test'); assert(!JSON.stringify(target).includes('pairingCode'));
});
test('unknown routes, raw business requests and legacy upload attempts fail closed',async()=>{
  const f=fixture();
  for (const url of ['wss://stranger.test/api/federation/secure','wss://entry.test/api/terminal/ws','wss://user:pass@target.test/api/federation/secure']) assert.throws(()=>new f.window.WebSocket(url));
  for (const url of ['/api/terminal/fs/upload','https://entry.test/api/terminal/input','/api/auth/password/start','https://stranger.test/api/meta']) await assert.rejects(f.window.fetch(url));
  await assert.rejects(f.window.fetch('/api/meta',{method:'POST'}));
  assert.equal(f.calls.length,0); assert.equal(f.socketCalls.length,0);
  assert.equal(f.window.termdockDesktop.pasteClipboardImage,undefined);
  assert.equal(f.window.termdockDesktop.uploadDroppedFiles,undefined);
});
test('first-load cancellation and transport failure never retry ordinary APIs',async()=>{
  const controller=new AbortController(), f=fixture();
  await f.window.fetch(new Request('https://target.test/api/meta',{headers:{Authorization:'ambient-secret'},credentials:'include'}),{signal:controller.signal});
  assert.equal(f.calls[0][1].signal,controller.signal); assert.equal(f.calls[0][1].headers,undefined); assert.equal(f.calls[0][1].credentials,'same-origin');
  const bad=fixture({fetchError:true});
  await assert.rejects(bad.window.fetch('/api/meta')); assert.equal(bad.calls.length,1);
});
test('native readers preserve safe bytes; delivery and update state come from the backend',async()=>{
  const f=fixture(), bridge=f.window.termdockDesktop;
  const files=await bridge.readClipboardFiles({localServiceId:'target-pin'});
  assert.equal(files[0].path,undefined); assert.deepEqual([...new Uint8Array(files[0].bytes)],[0,255]);
  assert.deepEqual([...new Uint8Array(await bridge.readClipboardImage())],[1,2,255]);
  assert.equal(await bridge.showNotification({title:'test'}),false); assert.equal((await bridge.desktopUpdateState()).status,'error');
  assert.equal(bridge.nativeTerminal, undefined);
  assert.equal((await f.context.navigator.serviceWorker.register('/sw.js')).scope,f.context.location.origin+'/');
  assert.equal(bridge.previewCapabilities.backgroundWorker,true);
  assert.equal(f.ipc.some(call=>call.op.includes('upload')),false);
});

test('openConnection normalizes native string rejections for UI and retains internal detail in diagnostics', async()=>{
 const cases=[
  ['invalid peer certificate: UnknownIssuer','无法验证服务证书或身份。请核对服务地址和已保存的证书指纹。'],
  ['Pinned target identity changed. Remove the old connection explicitly before adding it again.','无法验证服务证书或身份。请核对服务地址和已保存的证书指纹。'],
  ['Invitation does not match this connection','服务拒绝或无法验证此次授权。请检查邀请、服务权限或密码。'],
  ['Cannot discover service. Verify the address and Preview certificate fingerprint.','暂时无法连接服务。请检查地址、网络或证书指纹后重试。'],
  ['Permission denied (os error 13): /Users/alice/private/key.pem','暂时无法打开服务，请检查地址和网络后重试。'],
 ];
 for(const [detail, safe] of cases) {
  const diagnostics=[], f=fixture({invoke:async(op)=>{if(op==='openConnection') throw detail;},context:{console:{error:(...args)=>diagnostics.push(args)}}});
  await assert.rejects(f.window.termdockDesktop.openServiceConnection({url:'https://service.test'}),error=>{
   assert.equal(error.message,safe);assert(!error.message.includes('/Users/alice'));return true;
  });
  assert.equal(diagnostics[0][0],'[Termdock Preview] openConnection rejected:');
  assert.equal(diagnostics[0][1],detail);
  assert.equal(f.ipc[0].op,'openConnection');
 }
});

test('sandboxed child documents never receive the native bridge',()=>{
  const f=fixture({frame:true});
  assert.equal(f.window.termdockDesktop,undefined);
  assert.equal(f.ipc.length,0);assert.equal(f.storage.size,0);
});

test('password binding maps only the current loopback and explicitly approved exact routes',()=>{
 const f=fixture(); const method=f.window.termdockDesktop.passwordBootstrapOrigin;
 assert.equal(method(f.context.location.origin),'https://target.test');
 assert.equal(method('https://entry.test'),'https://entry.test');
 for(const value of ['https://attacker.test','https://target.test/','https://u:p@target.test','https://target.test/?x=1','file:///etc/passwd']) assert.throws(()=>method(value));
});
test('bridge subscriptions remove the exact native callback',()=>{
 const listeners=new Map();
 const f=fixture({context:{}});f.window.addEventListener=(name,fn)=>listeners.set(name,fn);f.window.removeEventListener=(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);};
 let count=0;const stop=f.window.termdockDesktop.onDesktopUpdateState(()=>count++);
 listeners.get('termdock:preview-update')({detail:{status:'ready'}});assert.equal(count,1);stop();assert.equal(listeners.size,0);
});
test('worker uses exact encrypted routes and cannot inherit page plaintext business routes',()=>{
 const worker=fs.readFileSync(new URL('./worker-transport.js',import.meta.url),'utf8');const calls=[];
 class Socket {constructor(url){calls.push(url);}}
 const self={__TD_PREVIEW_TRANSPORT__:{origins:['https://entry.test','https://target.test'],defaultRoute:1},location:{origin:'http://127.0.0.1:43000'},WebSocket:Socket};
 vm.runInNewContext(worker,{self,URL,TypeError});
 new self.WebSocket('wss://target.test/api/federation/secure');new self.WebSocket('wss://entry.test/api/federation/relay?routeToken=opaque');
 assert.deepEqual(calls,['ws://127.0.0.1:43000/__td_route/1/api/federation/secure','ws://127.0.0.1:43000/__td_route/0/api/federation/relay?routeToken=opaque']);
 for(const value of ['wss://other.test/api/federation/secure','wss://entry.test/api/terminal/ws','wss://user:pass@entry.test/api/federation/secure']) assert.throws(()=>new self.WebSocket(value));
});

test('notification focus waits for the mounted page acknowledgment and cleans pending timers',async()=>{
 const worker=new EventTarget();
 const f=fixture({context:{navigator:{serviceWorker:worker},MessageChannel,MessageEvent}});
 let count=0;
 f.listeners.get('termdock:preview-focus-request')({detail:{requestId:'first',sessionId:'session-one',targetPeerId:'target-pin'}});
 assert.equal(f.ipc.length,0,'no mounted App handler means no focus receipt');
 worker.addEventListener('message',event=>{count++;assert.equal(event.data.sessionId,'session-two');event.ports[0].postMessage({type:'termdock:focus-session-ack'});});
 f.listeners.get('termdock:preview-focus-request')({detail:{requestId:'second',sessionId:'session-two',targetPeerId:'target-pin'}});
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(count,1);assert.equal(f.ipc.length,1);assert.equal(f.ipc[0].op,'focusReceipt');assert.equal(f.ipc[0].args.requestId,'second');
 f.listeners.get('pagehide')();
});

function streamedFixture(data, alter = () => {}) {
 const batch='11111111-1111-4111-8111-111111111111';
 const receipt='22222222-2222-4222-8222-222222222222';
 let offset=0,sequence=0;
 let f;
 f=fixture({invoke:async(op,args)=>{
  if(['clipboardImage','clipboardFiles','chooseFiles','dropFiles'].includes(op)) {offset=0;sequence=0;return {batch,files:[{index:0,size:data.length,name:'real.bin',type:'application/octet-stream'}]};}
  if(op==='releaseFiles')return null;
  if(op==='fileChunk') {
   assert.equal(args.seq,sequence);assert.equal(args.receipt,sequence?receipt:null);assert.equal(args.batch,batch);
   const end=Math.min(data.length,offset+256*1024);
   const chunk={index:0,seq:sequence++,offset,length:end-offset,eof:end===data.length,receipt,base64:Buffer.from(data.subarray(offset,end)).toString('base64')};offset=end;
   alter(chunk,f);return chunk;
  }
  throw new Error('Unexpected capability');
 }});
 return f;
}
test('image, file and movie-style readers assemble bounded blocks into the existing ArrayBuffer contract',async()=>{
 const data=Uint8Array.from({length:2*1024*1024+3},(_,i)=>i%251);
 for(const method of ['readClipboardImage','readClipboardFiles','readLocalFiles']) {
  const f=streamedFixture(data);const result=await f.window.termdockDesktop[method]();const bytes=method==='readClipboardImage'?result:result[0].bytes;
  assert.deepEqual(new Uint8Array(bytes),data);
  assert.equal(f.ipc.filter(c=>c.op==='fileChunk').length,9);
  assert.equal(f.ipc.at(-1).op,'releaseFiles');assert.equal(f.calls.length,0);
 }
});
test('corrupt chunks, disconnects and target changes release the read without a plaintext retry',async()=>{
 for(const failure of ['length','receipt','disconnect','target']) {
  const f=streamedFixture(new Uint8Array(256*1024+3),(chunk,f)=>{
   if(failure==='length')chunk.length++;
   if(failure==='receipt')chunk.receipt='invalid';
   if(failure==='disconnect')throw new Error('disconnected');
   if(failure==='target')f.storage.set('termdock-secure-target-v1','different target');
  });
  await assert.rejects(f.window.termdockDesktop.readLocalFiles());
  assert.equal(f.ipc.at(-1).op,'releaseFiles');assert.equal(f.calls.length,0);
 }
});
test('native file drops resolve the exact owning terminal view and carry it to the Rust capability',async()=>{
 const dom=new JSDOM('<div data-termdock-terminal-dropzone="view-a"></div><div data-termdock-terminal-dropzone="view-b"></div>');
 const dropErrors=[];for(const target of dom.window.document.querySelectorAll('[data-termdock-terminal-dropzone]'))target.addEventListener('termdock:file-drop-error',event=>dropErrors.push(event.detail));
 const calls=[],fetches=[],batch='11111111-1111-4111-8111-111111111111',receipt='22222222-2222-4222-8222-222222222222';let chunks=0;
 const f=fixture({context:{document:dom.window.document,CustomEvent:dom.window.CustomEvent,FormData,Blob},invoke:async(op,args)=>{
  calls.push({op,args});
  if(op==='dropFiles')return {batch,files:[{index:0,name:'local.txt',size:4,type:'text/plain'}]};
  if(op==='fileChunk'){chunks++;return {index:0,seq:0,offset:0,length:4,eof:true,receipt,base64:'REFUQQ=='};}
  if(op==='releaseFiles')return null;
  return null;
 }});
 // The actual workspace installs its encrypted fetch after this early bridge;
 // verify that the drop path calls the current page fetch owner dynamically.
 f.window.fetch=async(url,options)=>{
  fetches.push([String(url),options]);
  if(String(url).includes('/api/csrf-token'))return new Response(JSON.stringify({csrfToken:'csrf'}),{status:200,headers:{'content-type':'application/json'}});
  if(String(url).includes('/api/terminal/fs/upload'))return new Response(JSON.stringify({files:[{path:'/remote/tmp/local.txt'}]}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error(`Unexpected request ${String(url)}`);
 };
 const delivered=[];f.window.termdockDesktop.onNativeFileDrop(value=>delivered.push(value));
 await f.listeners.get('termdock:preview-files')({detail:{token:'capability-a',sessionKey:'view-b'}});
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(delivered.length,1,dropErrors.join(';'));assert.equal(delivered[0].sessionKey,'view-b');assert.deepEqual(Array.from(delivered[0].paths),['/remote/tmp/local.txt']);
 assert.equal(calls[0].op,'dropFiles');
 assert.equal(calls[0].args.viewId,'view-b');
 assert.equal(calls[0].args.targetPeerId,'target-pin');
 assert.equal(chunks,1);assert.equal(fetches.length,2);
 assert.deepEqual(fetches.map(([url])=>url),['/api/csrf-token','/api/terminal/fs/upload?dir=%2Ftmp&fileCount=1']);
 assert.equal(calls.at(-1).op,'releaseFiles');
});
test('an older native-drop error timer cannot clear a newer error for the same owner',async()=>{
 const dom=new JSDOM('<div data-termdock-terminal-dropzone="view-a"></div>'),target=dom.window.document.querySelector('[data-termdock-terminal-dropzone]');
 const f=fixture({context:{document:dom.window.document,CustomEvent:dom.window.CustomEvent},invoke:async op=>op==='dropFiles'?{batch:'11111111-1111-4111-8111-111111111111',files:[{name:'local.txt',path:'/tmp/local.txt'}]}:null});
 const timers=[];f.window.setTimeout=(callback,delay)=>{if(delay===3000)timers.push({callback,delay});return timers.length;};
 let deliveries=0;f.window.termdockDesktop.onNativeFileDrop(()=>{deliveries++;throw new Error(`failure-${deliveries}`);});
 const drop=()=>f.listeners.get('termdock:preview-files')({detail:{token:'capability-a',sessionKey:'view-a'}});
 drop();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(target.dataset.nativeFileDropState,'error');assert.equal(timers.length,1);assert.equal(timers[0].delay,3000);
 const firstOperation=target.dataset.nativeFileDropOperation;
 drop();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(target.dataset.nativeFileDropState,'error');assert.equal(timers.length,2);
 const secondOperation=target.dataset.nativeFileDropOperation;assert.notEqual(secondOperation,firstOperation);
 timers[0].callback();
 assert.equal(target.dataset.nativeFileDropState,'error');assert.equal(target.dataset.nativeFileDropOperation,secondOperation);
 timers[1].callback();
 assert.equal(target.dataset.nativeFileDropState,undefined);assert.equal(target.dataset.nativeFileDropOperation,undefined);
 dom.window.close();
});
test('a stale native-drop upload success cannot deliver paths or clear a newer drop',async()=>{
 const dom=new JSDOM('<div data-termdock-terminal-dropzone="view-a"></div>'),target=dom.window.document.querySelector('[data-termdock-terminal-dropzone]');
 const batch='11111111-1111-4111-8111-111111111111',receipt='22222222-2222-4222-8222-222222222222';
 const f=fixture({context:{document:dom.window.document,CustomEvent:dom.window.CustomEvent,FormData,Blob},invoke:async op=>{
  if(op==='dropFiles')return {batch,files:[{index:0,name:'upload.bin',size:1,type:'application/octet-stream'}]};
  if(op==='fileChunk')return {index:0,seq:0,offset:0,length:1,eof:true,receipt,base64:'QQ=='};
  return null;
 }});
 const uploads=[];f.window.fetch=async url=>{
  if(String(url).includes('/api/csrf-token'))return new Response(JSON.stringify({csrfToken:'csrf'}),{status:200,headers:{'content-type':'application/json'}});
  if(String(url).includes('/api/terminal/fs/upload'))return new Promise(resolve=>uploads.push(resolve));
  throw new Error(`Unexpected request ${String(url)}`);
 };
 const delivered=[];f.window.termdockDesktop.onNativeFileDrop(value=>delivered.push(value));
 const drop=()=>f.listeners.get('termdock:preview-files')({detail:{token:'capability-a',sessionKey:'view-a'}});
 const flushUntil=async predicate=>{for(let attempt=0;attempt<30&&!predicate();attempt++)await new Promise(resolve=>setTimeout(resolve,0));assert(predicate(),'native drop did not reach the expected async boundary');};
 drop();await flushUntil(()=>uploads.length===1);const firstOperation=target.dataset.nativeFileDropOperation;
 f.storage.set('termdock-secure-target-v1',JSON.stringify({targetPeerId:'target-two'}));
 drop();await flushUntil(()=>uploads.length===2);const secondOperation=target.dataset.nativeFileDropOperation;assert.notEqual(secondOperation,firstOperation);
 uploads[0](new Response(JSON.stringify({files:[{path:'/tmp/old.txt'}]}),{status:200,headers:{'content-type':'application/json'}}));
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.deepEqual(delivered,[]);assert.equal(target.dataset.nativeFileDropState,'uploading');assert.equal(target.dataset.nativeFileDropOperation,secondOperation);
 uploads[1](new Response(JSON.stringify({files:[{path:'/tmp/new.txt'}]}),{status:200,headers:{'content-type':'application/json'}}));
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(delivered.length,1);assert.equal(delivered[0].sessionKey,'view-a');assert.deepEqual(Array.from(delivered[0].paths),['/tmp/new.txt']);
 assert.equal(target.dataset.nativeFileDropState,'uploaded');assert(target.dataset.nativeFileDropOperation);
 dom.window.close();
});
test('a changed target while a native selector is pending cannot return its files to the new target',async()=>{
 let finish;const batch='11111111-1111-4111-8111-111111111111';
 const f=fixture({invoke:async op=>op==='chooseFiles'?new Promise(resolve=>finish=resolve):null});
 const pending=f.window.termdockDesktop.readLocalFiles();
 f.storage.set('termdock-secure-target-v1','changed while choosing');finish({batch,files:[{name:'local',path:'/private/local'}]});
 await assert.rejects(pending);assert.equal(f.ipc.at(-1).op,'releaseFiles');assert.equal(f.calls.length,0);
});
test('oversized and malformed selections are rejected before allocating data, with cancellation and pagehide cleanup',async()=>{
 const batch='11111111-1111-4111-8111-111111111111';
 for(const files of [[{name:'oversized',index:0,size:128*1024*1024+1}],Array.from({length:51},()=>({name:'file',index:0,size:0})),[{name:'old bytes',bytes:[1,2,3]}]]) {
  const f=fixture({invoke:async op=>op==='chooseFiles'?{batch,files}:null});await assert.rejects(f.window.termdockDesktop.readLocalFiles());assert.equal(f.ipc.at(-1).op,'releaseFiles');
 }
 let finish;const f=fixture({invoke:async op=>op==='chooseFiles'?{batch,files:[{name:'f',index:0,size:1}]}:op==='fileChunk'?new Promise(resolve=>finish=resolve):null});
 const pending=f.window.termdockDesktop.readLocalFiles();await new Promise(resolve=>setTimeout(resolve,0));f.listeners.get('pagehide')();finish({});await assert.rejects(pending);assert(f.ipc.some(c=>c.op==='releaseFiles'));assert.equal(f.calls.length,0);
});
test('AbortSignal releases an active transfer and unreadable movies retain the strict no-cover/text-fallback error',async()=>{
 const controller=new AbortController();let f;
 f=streamedFixture(new Uint8Array(256*1024+1),()=>controller.abort());
 await assert.rejects(f.window.termdockDesktop.readLocalFiles({signal:controller.signal}));
 assert.equal(f.ipc.at(-1).op,'releaseFiles');assert.equal(f.calls.length,0);
 const batch='11111111-1111-4111-8111-111111111111';
 const movie=fixture({invoke:async op=>{
  if(op==='clipboardFiles')return {batch,files:[{name:'video.mov',type:'video/quicktime',size:100,index:0}]};
  if(op==='fileChunk')throw Error('disconnected while reading movie');
  return null;
 }});
 await assert.rejects(movie.window.termdockDesktop.readClipboardFiles(),/TERMDOCK_CLIPBOARD_VIDEO_ERROR/);
 assert.equal(movie.ipc.at(-1).op,'releaseFiles');assert.equal(movie.calls.length,0);
});

test('actual Preview feedback is visible bounded text, has one dismissible alert and expires without native business',()=>{
 const dom=new JSDOM(''),f=fixture({context:{document:dom.window.document}}),doc=dom.window.document;
 try{f.window.termdockDesktop.alert('<img src=x onerror=bad()>');const first=doc.querySelector('[data-preview-feedback]');assert.equal(first.getAttribute('role'),'alert');assert.equal(first.querySelector('img'),null);assert.match(first.textContent,/<img/);f.window.termdockDesktop.alert('Controlled failure');assert.equal(doc.querySelectorAll('[data-preview-feedback]').length,1);assert.equal(first.isConnected,false);doc.querySelector('[data-preview-feedback] button').click();assert.equal(doc.querySelector('[data-preview-feedback]'),null);f.window.termdockDesktop.alert('Another failure');f.listeners.get('termdock:secure-state')({});assert.equal(doc.querySelector('[data-preview-feedback]'),null);assert.equal(f.ipc.length,0);assert.throws(()=>f.window.termdockDesktop.alert('a'.repeat(4097)),/Invalid/);}finally{dom.window.close();}
});

function dragFixture(markup,local=true) {
 const dom=new JSDOM(markup),doc=dom.window.document;
 const f=fixture({local,context:{document:doc,Element:dom.window.Element,history:{state:null,replaceState(){}}}});
 f.listeners.get('DOMContentLoaded')();
 f.listeners.get('termdock:window-document-epoch')({detail:{epoch:'12345678-1234-4234-8234-123456789abc'}});
 const down=(selector,button=0)=>doc.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('mousedown',{button,bubbles:true,cancelable:true}));
 const double=(selector)=>doc.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('dblclick',{detail:2,bubbles:true,cancelable:true}));
 return {...f,dom,doc,down,double,drags:()=>f.ipc.filter(call=>call.op==='dragWindow')};
}
test('titlebar double-click is limited to existing chrome hosts and excludes controls and pane drags',()=>{
 const f=dragFixture('<header data-termdock-window-header="true"><span id="title">Title</span><button id="button">Control</button><div data-split-pane-title><span id="pane">Pane</span></div></header><main id="body">Body</main>');
 try{f.double('#title');f.double('header');for(const selector of ['#button','#pane','#body'])f.double(selector);const actions=f.ipc.filter(call=>call.op==='titlebarDoubleClick');assert.equal(actions.length,2);assert(actions.every(call=>call.command==='preview_dispatch'&&Object.keys(call.args).length===0));}finally{f.dom.window.close();}
});
test('normal pinned session header blank invokes the existing epoch-bound window drag channel',()=>{
 const sidebar=fs.readFileSync(new URL('../../src/lib/components/sidebar/LeftSidebar.tsx',import.meta.url),'utf8');
 const header=fs.readFileSync(new URL('../../src/lib/components/sidebar/SidebarHeader.tsx',import.meta.url),'utf8');
 assert.match(sidebar,/<SidebarHeader/);assert.match(header,/data-session-sidebar-header className=/);assert.match(sidebar,/data-session-sidebar-pinned/);
 const f=dragFixture('<div data-session-sidebar-pinned><div data-session-sidebar-header><div><span id="session-label">会话</span></div></div></div>');
 try{f.down('#session-label');assert.equal(f.drags().length,0);f.down('[data-session-sidebar-header]');assert.equal(f.drags().length,1);assert.equal(f.drags()[0].command,'preview_dispatch');assert.equal(f.drags()[0].args.documentEpoch,'12345678-1234-4234-8234-123456789abc');}finally{f.dom.window.close();}
});

test('service header nested SVG/text drag only for primary unhandled presses; body and overlay header do not drag',()=>{
 const f=dragFixture('<div data-session-sidebar-pinned><div data-session-sidebar-header><svg><path id="icon"/></svg><span id="text">会话</span></div><div id="body">body</div></div><div data-session-sidebar-header id="drawer-header"></div>');
 try{f.down('#icon');f.down('#text');assert.equal(f.drags().length,1);for(const selector of ['#body','#drawer-header'])f.down(selector);f.down('#text',1);f.down('#text',2);assert.equal(f.drags().length,1);
 f.doc.querySelector('#text').addEventListener('mousedown',e=>e.preventDefault());f.down('#text');assert.equal(f.drags().length,1);
 }finally{f.dom.window.close();}
});
test('no-drag interactive ancestors win over every supported chrome drag ancestor',()=>{
 const children=['<button><svg><path id="hit"/></svg></button>','<a href="#"><span id="hit">Link</span></a>','<input id="hit">','<textarea id="hit"></textarea>','<select id="hit"><option>A</option></select>','<form><span id="hit">Form</span></form>','<div contenteditable="true"><span id="hit">Edit</span></div>','<summary><span id="hit">Details</span></summary>','<label><span id="hit">Label</span></label>','<div draggable="true"><span id="hit">Row</span></div>',...['data-rbd-draggable-id="row"','data-rbd-drag-handle-draggable-id="row"','data-split-pane-title="owned"','data-panel-drag-title="true"','class="split-pane-drag-handle"','data-no-drag','data-tauri-no-drag','data-tauri-drag-region="false"','data-termdock-terminal-dropzone="terminal::owned"','class="xterm"'].map(attr=>`<div ${attr}><span id="hit">Child</span></div>`),...['button','link','tab','menu','menuitem','menuitemcheckbox','menuitemradio','textbox','combobox','listbox','option','slider','spinbutton','checkbox','radio','switch','treeitem','scrollbar'].map(role=>`<div role="${role}"><span id="hit">Control</span></div>`)];
 for(const wrapper of ['<div data-termdock-window-header="true">CHILD</div>','<div data-tauri-drag-region>CHILD</div>','<div class="widget">CHILD</div>','<div data-session-sidebar-pinned><div data-session-sidebar-header>CHILD</div></div>'])for(const child of children){
  const f=dragFixture(wrapper.replace('CHILD',child));try{f.down('#hit');assert.equal(f.drags().length,0,child);}finally{f.dom.window.close();}
 }
});
test('prepared normal center brand/topbar and floating widget retain their existing drag behavior',()=>{
 // These are the same source and marker transformation used by prepare-renderer.
 const original=fs.readFileSync(new URL('../../desktop/renderer/index.html',import.meta.url),'utf8');
 const markup=original.replace('class="brand"','class="brand" data-tauri-drag-region').replace('class="topbar"','class="topbar" data-tauri-drag-region');
 const f=dragFixture(markup);try{for(const selector of ['.brand-name','.topbar h1']){assert(f.doc.querySelector(selector));f.down(selector);}assert.equal(f.drags().length,0);const brand=f.doc.querySelector('.brand');brand.dispatchEvent(new f.dom.window.MouseEvent('mousedown',{button:0,bubbles:true}));assert.equal(f.drags().length,1);const button=f.doc.querySelector('.topbar button');assert(button);button.dispatchEvent(new f.dom.window.MouseEvent('mousedown',{button:0,bubbles:true}));assert.equal(f.drags().length,1);}finally{f.dom.window.close();}
 const floating=fs.readFileSync(new URL('../../desktop/renderer/floating.html',import.meta.url),'utf8');
 const w=dragFixture(floating);try{assert(w.doc.querySelector('.widget'));w.down('.widget');assert.equal(w.drags().length,1);for(const button of w.doc.querySelectorAll('button'))button.dispatchEvent(new w.dom.window.MouseEvent('mousedown',{button:0,bubbles:true}));assert.equal(w.drags().length,1);}finally{w.dom.window.close();}
});

test('actual App main topbar marker works with pin hidden and narrow layout without broad main matching',()=>{
 const app=fs.readFileSync(new URL('../../src/App.tsx',import.meta.url),'utf8');
 assert.match(app,/<CollaborationWorkspaceFrame[^\n]*>\s*<div\s+data-termdock-window-header="true"\s+className=\{`\$\{isDesktopViewport/);
 assert.equal((app.match(/data-termdock-window-header=/g)||[]).length,1);
 for(const mode of ['desktop-unpinned','narrow']){
  const f=dragFixture(`<main><div><div data-termdock-window-header="true" class="${mode==='narrow'?'relative':'absolute inset-x-0 top-0'}"><button id="open">Menu</button><span id="header-text">Title</span><svg><path id="header-icon"/></svg></div><div id="terminal-body">Body</div></div></main>`);
  try{f.down('#header-text');f.down('#header-icon');assert.equal(f.drags().length,1,mode);f.down('#open');f.down('#terminal-body');f.down('#header-text',2);assert.equal(f.drags().length,1,mode);}finally{f.dom.window.close();}
 }
 const f=dragFixture('<main><div data-termdock-window-header="false" id="not-header">Body</div></main>');try{f.down('#not-header');assert.equal(f.drags().length,0);}finally{f.dom.window.close();}
});

test('actual collaboration workspace header marker drags title and blank chrome, never controls or menus',()=>{
 const workspace=fs.readFileSync(new URL('../../src/lib/components/sidebar/CollaborationMainWorkspace.tsx',import.meta.url),'utf8');
 assert.match(workspace,/<header data-termdock-window-header="true" className="flex min-h-14/);
 assert.equal((workspace.match(/data-termdock-window-header=/g)||[]).length,1);
 const f=dragFixture('<div data-collaboration-workspace-frame><header data-termdock-window-header="true" id="blank"><button id="sidebar"><svg><path id="sidebar-icon"/></svg></button><div><h2 tabindex="-1"><span id="title">Owned workspace</span></h2><p id="members">2 members</p></div><button id="terminal">Terminal</button><div role="menu"><span role="menuitem" id="menu">Item</span></div></header><div id="workspace-body">Board</div></div>');
 try{for(const selector of ['#blank','#title','#members'])f.down(selector);assert.equal(f.drags().length,1);for(const selector of ['#sidebar-icon','#terminal','#menu','#workspace-body'])f.down(selector);assert.equal(f.drags().length,1);}finally{f.dom.window.close();}
});

test('split window header is explicit chrome while pane titles, controls and terminal selection stay excluded',()=>{
 const component=fs.readFileSync(new URL('../../src/lib/components/MultiTerminalView.tsx',import.meta.url),'utf8');
 const app=fs.readFileSync(new URL('../../src/App.tsx',import.meta.url),'utf8');
 assert.match(component,/data-termdock-window-header="true"\s+data-split-window-header="true"/);assert.match(app,/desktopLeftSidebarPinned=\{showPinnedLeft\}/);
 const f=dragFixture('<div><header data-termdock-window-header="true" data-split-window-header="true" id="blank"><span id="title">Owned split</span><button id="button">Control</button><div role="menu"><span id="menu">Menu</span></div><div data-split-pane-title="one"><span id="pane">Pane</span></div><div data-panel-drag-title><span id="panel">Panel</span></div><span class="split-pane-drag-handle" id="handle">Handle</span></header><div data-termdock-terminal-dropzone="terminal::owned"><span id="output">Terminal</span></div><button role="separator" id="divider">Divider</button></div>');
 try{f.down('#blank');f.down('#title');assert.equal(f.drags().length,1);for(const selector of ['#button','#menu','#pane','#panel','#handle','#output','#divider'])f.down(selector);assert.equal(f.drags().length,1);}finally{f.dom.window.close();}
});

test('packaged center rail drag stays on exact blank root targets and never swallows descendants',()=>{
 const original=fs.readFileSync(new URL('../../desktop/renderer/index.html',import.meta.url),'utf8');
 const generator=fs.readFileSync(new URL('../scripts/prepare-renderer.mjs',import.meta.url),'utf8');
 assert(generator.includes('data-termdock-window-rail="true"'));
 const markup=original.replace('class="brand"','class="brand" data-tauri-drag-region').replace('class="topbar"','class="topbar" data-tauri-drag-region').replace('class="rail"','class="rail" data-termdock-window-rail="true"');
 for(const local of [true,false]){
  const f=dragFixture(markup,local),rail=f.doc.querySelector('[data-termdock-window-rail]'),brand=rail.querySelector('.brand');
  const bounds={left:0,right:224,top:0,bottom:820};rail.getBoundingClientRect=()=>bounds;brand.getBoundingClientRect=()=>({top:54});
  const hit=(x,y,target=rail)=>target.dispatchEvent(new f.dom.window.MouseEvent('mousedown',{button:0,clientX:x,clientY:y,bubbles:true,cancelable:true}));
  try{
   for(const [x,y] of [[100,8],[180,23],[200,40]])hit(x,y);
   assert.equal(f.drags().length,local?3:0);
   for(const [x,y] of [[224,23],[-1,23],[100,-1],[100,54],[100,700]])hit(x,y);
   assert.equal(f.drags().length,local?5:0);
   hit(100,23,rail.querySelector('.nav-item'));assert.equal(f.drags().length,local?5:0);
   rail.setAttribute('data-no-drag','');hit(100,23);rail.removeAttribute('data-no-drag');
   const child=f.doc.createElement('span');rail.prepend(child);hit(100,23,child);child.remove();
   brand.getBoundingClientRect=()=>({top:NaN});hit(100,23);
   brand.remove();hit(100,23);assert.equal(f.drags().length,local?7:0);
  }finally{f.dom.window.close();}
 }
});

test('packaged connection center app-shell/workspace/section blank areas drag without stealing controls or scrollbar input',()=>{
 const original=fs.readFileSync(new URL('../../desktop/renderer/index.html',import.meta.url),'utf8');
 const packaged=original.replace('class="brand"','class="brand" data-tauri-drag-region').replace('class="topbar"','class="topbar" data-tauri-drag-region').replace('class="rail"','class="rail" data-termdock-window-rail="true"');
 const f=dragFixture(packaged,true);f.context.location.pathname='/';const main=f.doc.querySelector('main.app-shell');
 f.doc.querySelector('.rail').getBoundingClientRect=()=>({left:0,right:224,top:0,bottom:500,width:224,height:500});
 Object.defineProperties(main,{scrollHeight:{value:1000},clientHeight:{value:500},scrollWidth:{value:800},clientWidth:{value:800},offsetWidth:{value:816},offsetHeight:{value:500}});
 main.getBoundingClientRect=()=>({left:0,right:816,top:0,bottom:500,width:816,height:500});
 try {
  for(const selector of ['main.app-shell','.workspace','.rail','.topbar','.local-stage','.remote-section'])f.down(selector);
  assert.equal(f.drags().length,6);
  for(const selector of ['#refresh','#prepare-local','#local-address','#service-manager'])f.down(selector);
  assert.equal(f.drags().length,6);
  main.dispatchEvent(new f.dom.window.MouseEvent('mousedown',{button:0,clientX:810,clientY:250,bubbles:true,cancelable:true}));
  assert.equal(f.drags().length,6,'the actual vertical scrollbar strip is not a drag surface');
  const range=f.doc.createRange();range.selectNodeContents(f.doc.querySelector('.topbar h1'));f.doc.getSelection().addRange(range);
  f.down('.topbar');assert.equal(f.drags().length,6,'active text selection is preserved');
 } finally {f.dom.window.close();}
});

test('existing full viewport login root is draggable while password form and controls are excluded',()=>{
 const f=dragFixture('<div id="root"><div id="login" class="flex w-screen flex-col items-center justify-center bg-background px-4 text-foreground" style="height:var(--app-vh, 100vh)"><pre>Brand</pre><form id="form"><input type="password" autocomplete="current-password"><button>Login</button></form></div></div>',false);
 f.context.location.pathname='/workspace.html';const root=f.doc.querySelector('#login');
 Object.defineProperties(f.doc.documentElement,{clientWidth:{value:1100},clientHeight:{value:800}});
 root.getBoundingClientRect=()=>({left:0,top:0,right:1100,bottom:800,width:1100,height:800});
 try {
  f.down('#login');assert.equal(f.drags().length,1);
  for(const selector of ['pre','#form','input','button'])f.down(selector);
  assert.equal(f.drags().length,1);
  root.getBoundingClientRect=()=>({left:0,top:0,right:900,bottom:800,width:900,height:800});
  f.down('#login');assert.equal(f.drags().length,1,'a non-viewport form wrapper is not granted drag behavior');
 } finally {f.dom.window.close();}
});

test('drag command is disabled without a host epoch and carries only the current document epoch',()=>{
 const dom=new JSDOM('<main class="app-shell"><div class="workspace" id="main"></div></main>'),f=fixture({local:true,context:{document:dom.window.document,Element:dom.window.Element}});
 try {
  f.listeners.get('DOMContentLoaded')();
  dom.window.document.querySelector('#main').dispatchEvent(new dom.window.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));
  assert.equal(f.ipc.filter(call=>call.op==='dragWindow').length,0);
  f.listeners.get('termdock:window-document-epoch')({detail:{epoch:'12345678-1234-4234-8234-123456789abc'}});
  dom.window.document.querySelector('#main').dispatchEvent(new dom.window.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));
  assert.equal(f.ipc.filter(call=>call.op==='dragWindow').length,1);
  assert.equal(f.ipc.at(-1).args.documentEpoch,'12345678-1234-4234-8234-123456789abc');
  f.listeners.get('termdock:window-document-epoch')({detail:{epoch:'invalid'}});
  dom.window.document.querySelector('#main').dispatchEvent(new dom.window.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));
  assert.equal(f.ipc.filter(call=>call.op==='dragWindow').length,2);
 } finally {dom.window.close();}
});

test('owned page window observations are default off and diagnostic rejection never gates dragging',async()=>{
 const dom=new JSDOM('<header data-tauri-drag-region id="hit"><span>Owned</span></header>');
 try{
  const f=fixture({local:true,ownedWindowChrome:true,invoke:op=>op==='windowChromeObservation'?Promise.reject(Error('controlled observation failure')):Promise.resolve(null),context:{document:dom.window.document,Element:dom.window.Element}});
  f.listeners.get('DOMContentLoaded')();f.listeners.get('termdock:window-document-epoch')({detail:{epoch:'12345678-1234-4234-8234-123456789abc'}});f.listeners.get('termdock:owned-window-chrome')({detail:{ownerGeneration:101,documentGeneration:2}});
  dom.window.document.querySelector('#hit').dispatchEvent(new dom.window.MouseEvent('mousedown',{button:0,clientX:5,clientY:8,bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.ipc.filter(c=>c.op==='dragWindow').length,1);const observations=f.ipc.filter(c=>c.op==='windowChromeObservation').map(c=>c.args);
  assert.deepEqual(observations.map(c=>c.phase),['hit','request-start','request-end']);assert.equal(observations[2].outcome,'resolved');
  for(const value of observations){assert.equal(value.ownerGeneration,101);assert.equal(value.documentGeneration,2);assert.equal(JSON.stringify(value).includes('Owned'),false);}
 }finally{dom.window.close();}
 const normal=dragFixture('<header data-tauri-drag-region id="hit"><span>Header</span></header>');try{assert.equal(normal.listeners.has('termdock:owned-window-chrome'),false);normal.down('#hit');assert.equal(normal.ipc.filter(c=>c.op==='windowChromeObservation').length,0);assert.equal(normal.drags().length,1);}finally{normal.dom.window.close();}
});
test('owned window diagnostics safely classify the new center blank drag path',async()=>{
 const dom=new JSDOM('<main class="app-shell"><div class="workspace" id="blank"></div></main>');
 try {
  const f=fixture({local:true,ownedWindowChrome:true,context:{document:dom.window.document,Element:dom.window.Element}});
  f.listeners.get('DOMContentLoaded')();f.listeners.get('termdock:window-document-epoch')({detail:{epoch:'12345678-1234-4234-8234-123456789abc'}});
  f.listeners.get('termdock:owned-window-chrome')({detail:{ownerGeneration:301,documentGeneration:1}});
  dom.window.document.querySelector('#blank').dispatchEvent(new dom.window.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));
  assert.equal(f.ipc.filter(call=>call.op==='dragWindow').length,1);
  assert.equal(f.ipc.filter(call=>call.op==='dragWindow')[0].args.documentEpoch,'12345678-1234-4234-8234-123456789abc');
  await Promise.resolve();
  assert.equal(f.ipc.find(call=>call.op==='windowChromeObservation'&&call.args.phase==='hit')?.args.hit,'body');
 } finally {dom.window.close();}
});
test('owned page observations keep a visible budget boundary and discard late old-generation drag callbacks',async()=>{
 const dom=new JSDOM('<div data-tauri-drag-region id="hit"><span>Owned</span></div>');let resolve;
 const f=fixture({local:true,ownedWindowChrome:true,invoke:op=>op==='dragWindow'?new Promise(done=>{resolve=done;}):Promise.resolve(null),context:{document:dom.window.document,Element:dom.window.Element}});
 try{
  f.listeners.get('DOMContentLoaded')();f.listeners.get('termdock:window-document-epoch')({detail:{epoch:'12345678-1234-4234-8234-123456789abc'}});const attach=value=>f.listeners.get('termdock:owned-window-chrome')({detail:value});attach({ownerGeneration:201,documentGeneration:1});
  const down=()=>dom.window.document.querySelector('#hit').dispatchEvent(new dom.window.MouseEvent('mousedown',{button:0,clientX:3,clientY:4,bubbles:true}));
  down();attach({ownerGeneration:201,documentGeneration:2});const before=f.ipc.length;resolve();await Promise.resolve();assert.equal(f.ipc.length,before);
  attach({ownerGeneration:201,documentGeneration:1}); // Late attachment cannot revert the current binding.
  for(let n=0;n<20;n++)down();await Promise.resolve();const observations=f.ipc.filter(c=>c.op==='windowChromeObservation').map(c=>c.args).filter(c=>c.documentGeneration===2);
  assert.equal(observations.length,32);assert.equal(observations.at(-1).phase,'budget');assert.equal(f.ipc.filter(c=>c.op==='dragWindow').length,21);
 }finally{dom.window.close();}
});

test('native blob save uses bounded one-time chunks and reports saved only after host completion',async()=>{
 const batch='33333333-3333-4333-8333-333333333333';let receipt='44444444-4444-4444-8444-444444444444',seq=0,written=0;const output=[];
 const data=Uint8Array.from({length:256*1024+7},(_,i)=>i%251);
 const f=fixture({invoke:async(op,args)=>{
  if(op==='downloadStart')return {batch,seq:0,receipt,chunkBytes:256*1024};
  if(op==='downloadChunk') {assert.equal(args.batch,batch);assert.equal(args.seq,seq);assert.equal(args.receipt,receipt);const bytes=Buffer.from(args.base64,'base64');assert(bytes.length<=256*1024);output.push(bytes);written+=bytes.length;receipt='55555555-5555-4555-8555-555555555555';seq++;return {written,seq,receipt};}
  if(op==='downloadFinish'){assert.equal(args.seq,seq);assert.equal(args.receipt,receipt);return {status:'saved'};}
  if(op==='downloadCancel')return {status:'canceled'};
  throw new Error('Unexpected capability '+op);
 }});
 assert.equal(await f.window.termdockDesktop.saveDownloadBlob(new Blob([data]),'video.bin'), 'saved');
 assert.deepEqual(Buffer.concat(output),Buffer.from(data));assert.equal(f.ipc.filter(call=>call.op==='downloadChunk').length,2);assert.equal(f.ipc.at(-1).op,'downloadFinish');assert.equal(f.calls.length,0);
});
test('native save cancellation releases its one-time capability without finish',async()=>{
 const batch='33333333-3333-4333-8333-333333333333',receipt='44444444-4444-4444-8444-444444444444';
 let unblock;const controller=new AbortController();
 const f=fixture({invoke:async(op)=>{
  if(op==='downloadStart')return {batch,seq:0,receipt,chunkBytes:256*1024};
  if(op==='downloadChunk')return new Promise(resolve=>{unblock=()=>resolve({written:3,seq:1,receipt:'55555555-5555-4555-8555-555555555555'});});
  if(op==='downloadCancel')return {status:'canceled'};
  throw new Error('Unexpected capability '+op);
 }});
 const pending=f.window.termdockDesktop.saveDownloadBlob(new Blob(['abc']),'A',controller.signal);
 await new Promise(resolve=>setTimeout(resolve,0));controller.abort();unblock();await assert.rejects(pending,/cancelled|changed|切换|关闭/i);
 assert.equal(f.ipc.some(call=>call.op==='downloadFinish'),false);assert.equal(f.ipc.at(-1).op,'downloadCancel');
});
test('native save failure never reports saved and releases its partial file',async()=>{
 const batch='33333333-3333-4333-8333-333333333333',receipt='44444444-4444-4444-8444-444444444444';
 const f=fixture({invoke:async op=>{
  if(op==='downloadStart')return {batch,seq:0,receipt,chunkBytes:256*1024};
  if(op==='downloadChunk')return {written:3,seq:1,receipt:'55555555-5555-4555-8555-555555555555'};
  if(op==='downloadFinish')throw new Error('disk full');
  if(op==='downloadCancel')return {status:'canceled'};
  throw new Error('Unexpected capability '+op);
 }});
 await assert.rejects(f.window.termdockDesktop.saveDownloadBlob(new Blob(['abc']),'A'),/disk full/);
 assert.equal(f.ipc.at(-1).op,'downloadCancel');assert.equal(f.calls.length,0);
});
test('native save does not report a late finish receipt after abort or target change',async()=>{
 for(const reason of ['abort','target']){
  const batch='33333333-3333-4333-8333-333333333333',receipt='44444444-4444-4444-8444-444444444444';
  let release,entered;const finishing=new Promise(resolve=>{entered=resolve;}),controller=new AbortController();
  const f=fixture({invoke:async op=>{
   if(op==='downloadStart')return {batch,seq:0,receipt,chunkBytes:256*1024};
   if(op==='downloadFinish'){entered();return new Promise(resolve=>{release=()=>resolve({status:'saved'});});}
   if(op==='downloadCancel')return {status:'canceled'};
   throw Error('Unexpected save operation');
  }});
  const pending=f.window.termdockDesktop.saveDownloadBlob(new Blob([]),'empty.txt',controller.signal);
  await finishing;if(reason==='abort')controller.abort();else f.storage.set('termdock-secure-target-v1',JSON.stringify({targetPeerId:'new-owned-target'}));
  release();await assert.rejects(pending,/切换|关闭/);assert.equal(f.ipc.filter(call=>call.op==='downloadFinish').length,1);assert(f.ipc.some(call=>call.op==='downloadCancel'));
 }
});
test('native save abort while reading a blob chunk never dispatches that chunk',async()=>{
 const batch='33333333-3333-4333-8333-333333333333',receipt='44444444-4444-4444-8444-444444444444';
 let release,entered;const reading=new Promise(resolve=>{entered=resolve;}),controller=new AbortController();
 class DeferredBlob extends Blob{slice(){return {arrayBuffer:()=>{entered();return new Promise(resolve=>{release=()=>resolve(new Uint8Array([1,2,3]).buffer);});}};}}
 const f=fixture({invoke:async op=>{
  if(op==='downloadStart')return {batch,seq:0,receipt,chunkBytes:256*1024};
  if(op==='downloadCancel')return {status:'canceled'};
  throw Error('Canceled chunk must not be dispatched');
 }});
 const pending=f.window.termdockDesktop.saveDownloadBlob(new DeferredBlob(['abc']),'owned.bin',controller.signal);
 await reading;controller.abort();release();await assert.rejects(pending,/切换|关闭/);
 assert.equal(f.ipc.some(call=>call.op==='downloadChunk'||call.op==='downloadFinish'),false);
});
test('native response streaming exceeds 128 MiB with one bounded chunk in flight and no Blob buffering',async()=>{
 const batch='33333333-3333-4333-8333-333333333333',receipt='44444444-4444-4444-8444-444444444444';let seq=0,written=0,produced=0,inFlight=0,maxInFlight=0,maxAhead=0;
 const count=513,block=new Uint8Array(256*1024);
 const stream=new ReadableStream({pull(controller){maxAhead=Math.max(maxAhead,produced-seq);if(produced===count){controller.close();return;}produced++;controller.enqueue(block);}});
 const f=fixture({invoke:async(op,args,ipc)=>{
  if(op==='downloadStart'){assert.equal(args.size,null);return {batch,seq:0,receipt,chunkBytes:256*1024};}
  if(op==='downloadChunk'){inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);assert.equal(args.seq,seq);const size=Buffer.byteLength(args.base64,'base64');assert(size<=256*1024);delete ipc.at(-1).args.base64;await Promise.resolve();seq++;written+=size;inFlight--;return {seq,written,receipt};}
  if(op==='downloadFinish'){assert.equal(args.written,written);return {status:'saved'};}
  if(op==='downloadCancel')return {status:'canceled'};throw Error('Unexpected stream operation');
 }});
 assert.equal(await f.window.termdockDesktop.saveDownloadStream(stream,'large.bin'),'saved');assert(written>128*1024*1024);assert.equal(maxInFlight,1);assert(maxAhead<=2);assert.equal(seq,count);assert.equal(stream.locked,false);
});
test('native streaming handles empty and declared lengths and rejects truncated or excessive bodies',async()=>{
 for(const [size,expected,ok]of [[0,0,true],[0,undefined,true],[3,3,true],[3,2,false],[3,4,false]]){
  const batch='33333333-3333-4333-8333-333333333333',receipt='44444444-4444-4444-8444-444444444444';let written=0,seq=0;
  const f=fixture({invoke:async(op,args)=>{
   if(op==='downloadStart')return {batch,seq:0,receipt,chunkBytes:256*1024};
   if(op==='downloadChunk'){written+=Buffer.byteLength(args.base64,'base64');return {seq:++seq,written,receipt};}
   if(op==='downloadFinish'){assert.equal(args.written,written);return {status:'saved'};}
   if(op==='downloadCancel')return {status:'canceled'};throw Error('Unexpected operation');
  }});
  const stream=new ReadableStream({start(c){if(size)c.enqueue(new Uint8Array(size));c.close();}});
  const pending=f.window.termdockDesktop.saveDownloadStream(stream,'owned.bin',{expectedBytes:expected});
  if(ok)assert.equal(await pending,'saved');else{await assert.rejects(pending,/length/);assert(!f.ipc.some(call=>call.op==='downloadFinish'));}
  assert.equal(stream.locked,false);
 }
});
test('native stream failure, abort, or target change cancels only the owned pending save',async()=>{
 for(const reason of ['disconnect','disk','abort','target']){
  const batch='33333333-3333-4333-8333-333333333333',receipt='44444444-4444-4444-8444-444444444444';let readerController,reached;const ready=new Promise(resolve=>{reached=resolve;}),controller=new AbortController();
  const stream=new ReadableStream({start(c){readerController=c;}});
  const f=fixture({invoke:async op=>{if(op==='downloadStart'){reached();return {batch,seq:0,receipt,chunkBytes:256*1024};}if(op==='downloadChunk')throw Error('disk failed');if(op==='downloadCancel')return {status:'canceled'};throw Error('Must not finish failed stream');}});
  const pending=f.window.termdockDesktop.saveDownloadStream(stream,'owned.bin',{signal:controller.signal});
  await ready;
  if(reason==='disconnect')readerController.error(Error('disconnected'));
  else if(reason==='abort')controller.abort();
  else{if(reason==='target')f.storage.set('termdock-secure-target-v1','changed-owned-target');readerController.enqueue(new Uint8Array([1]));}
  await assert.rejects(pending,/disconnected|disk|切换|关闭/);assert(!f.ipc.some(call=>call.op==='downloadFinish'));assert(f.ipc.some(call=>call.op==='downloadCancel'));assert.equal(stream.locked,false);
 }
});
test('secure target or unauthorized events settle a pending read without any new data or finish',async()=>{
 for(const reason of ['target','unauthorized','unchanged']){
  const batch='33333333-3333-4333-8333-333333333333',receipt='44444444-4444-4444-8444-444444444444';let entered;const reading=new Promise(resolve=>{entered=resolve;}),controller=new AbortController();
  const stream=new ReadableStream({}),getReader=stream.getReader.bind(stream);stream.getReader=()=>{const reader=getReader(),read=reader.read.bind(reader);reader.read=()=>{entered();return read();};return reader;};
  const f=fixture({invoke:async op=>{if(op==='downloadStart')return {batch,seq:0,receipt,chunkBytes:256*1024};if(op==='downloadCancel')return {status:'canceled'};throw Error('No chunk or finish may follow a canceled pending read');}});
  const pending=f.window.termdockDesktop.saveDownloadStream(stream,'owned.bin',{signal:controller.signal});await reading;
  if(reason==='target')f.storage.set('termdock-secure-target-v1','new-owned-target');
  const event=reason==='unauthorized'?'auth:unauthorized':'termdock:secure-state';f.listeners.get(event)({type:event});
  if(reason==='unchanged'){assert(!f.ipc.some(call=>call.op==='downloadCancel'));controller.abort();}
  await assert.rejects(pending,/切换|关闭/);assert(f.ipc.some(call=>call.op==='downloadCancel'));assert(!f.ipc.some(call=>call.op==='downloadChunk'||call.op==='downloadFinish'));assert.equal(stream.locked,false);
  const calls=f.ipc.length;f.listeners.get('auth:unauthorized')({type:'auth:unauthorized'});assert.equal(f.ipc.length,calls,'completed operation must remove its event listeners');
 }
});
test('a same-view backend rebound invalidates a pending native drop capability',async()=>{
 const dom=new JSDOM('<div data-termdock-terminal-dropzone="view-a" data-termdock-terminal-owner="backend-old:1"></div>'),target=dom.window.document.querySelector('[data-termdock-terminal-dropzone]');
 let finish;const f=fixture({context:{document:dom.window.document,CustomEvent:dom.window.CustomEvent},invoke:async op=>op==='dropFiles'?new Promise(resolve=>finish=resolve):null});
 const delivered=[];f.window.termdockDesktop.onNativeFileDrop(value=>delivered.push(value));f.listeners.get('termdock:preview-files')({detail:{token:'owned-cap',sessionKey:'view-a'}});
 assert.equal(typeof finish,'function');target.dataset.termdockTerminalOwner='backend-new:2';finish({batch:'11111111-1111-4111-8111-111111111111',files:[{name:'owned.txt',path:'/tmp/old'}]});
 await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(delivered,[]);dom.window.close();
});

test('Web-only Preview omits engine APIs while preserving desktop clipboard collection',async()=>{
 const f=fixture();const api=f.window.termdockDesktop;
 assert.equal(api.nativeTerminal,undefined);assert.equal(api.terminalEngine,undefined);
 const files=await api.readClipboardFiles();assert.equal(files.length,1);
 assert.deepEqual(Array.from(new Uint8Array(files[0].bytes)),[0,255]);
 assert(f.ipc.some(call=>call.op==='clipboardFiles'));
});

test('certificate management is center-only and changed certificates retain a typed safe error',async()=>{
 const service=fixture();assert.equal(service.window.termdockDesktop.inspectCertificate,undefined);assert.equal(service.window.termdockDesktop.trustCertificate,undefined);
 const diagnostics=[],center=fixture({local:true,invoke:async(op)=>{if(op==='trustCertificate')throw 'PREVIEW_CERTIFICATE_CHANGED: controlled changed leaf';return null;},context:{console:{error:(...args)=>diagnostics.push(args)}}});
 await center.window.termdockDesktop.inspectCertificate('https://owned.test');
 await assert.rejects(center.window.termdockDesktop.trustCertificate('https://owned.test','a'.repeat(64),'owned-receipt'),error=>error.code==='PREVIEW_CERTIFICATE_CHANGED'&&error.message.includes('重新核对'));
 await center.window.termdockDesktop.discardCertificateInspection('owned-receipt');
 assert.deepEqual(JSON.parse(JSON.stringify(center.ipc.map(x=>[x.op,x.args]))),[
 ['inspectCertificate',{origin:'https://owned.test'}],['trustCertificate',{origin:'https://owned.test',fingerprint:'a'.repeat(64),receipt:'owned-receipt'}],['discardCertificateInspection',{receipt:'owned-receipt'}]]);
 assert.equal(diagnostics.length,1);
});

test('native window backing color follows the CSS chrome token on first load and theme change',()=>{
 const dom=new JSDOM(''),doc=dom.window.document;let changed,value='#1C1B1A';
 const f=fixture({local:true,context:{document:doc,Element:dom.window.Element,getComputedStyle:()=>({getPropertyValue:()=>value}),MutationObserver:class{constructor(fn){changed=fn;}observe(){}}}});
 try{
  f.listeners.get('DOMContentLoaded')();
  assert.equal(JSON.stringify(f.ipc.find(call=>call.op==='windowBackground').args.rgb),'[28,27,26]');
  value='#FFFCF0';changed();
  assert.equal(JSON.stringify(f.ipc.at(-1).args.rgb),'[255,252,240]');
  const count=f.ipc.length;value='url(untrusted)';changed();assert.equal(f.ipc.length,count);
 }finally{dom.window.close();}
});

for(const source of ['bundledWorkspace','serviceWorkspace'])test(`${source} activates only its own waiting worker and reloads once`,async()=>{
 const handlers=new Map(),messages=[],reloads=[];let updates=0;
 const own={scope:'http://127.0.0.1:43000/',waiting:{postMessage:message=>messages.push(message)},addEventListener(){},update:async()=>{updates++;}};
 const other={scope:'https://other.test/',waiting:{postMessage:()=>assert.fail('foreign worker touched')},addEventListener:()=>assert.fail('foreign worker watched')};
 const sw={controller:{},getRegistrations:async()=>[own,other],addEventListener:(name,fn)=>handlers.set(name,fn)};
 fixture({[source]:true,context:{navigator:{serviceWorker:sw},location:{origin:'http://127.0.0.1:43000',pathname:'/',hash:'',reload:()=>reloads.push(true)}}});
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(updates,1);assert(messages.length>0);assert(messages.every(m=>m.type==='SKIP_WAITING'));
 handlers.get('controllerchange')();handlers.get('controllerchange')();assert.equal(reloads.length,1);
});

test('ordinary service pages retain explicit PWA update consent',async()=>{
 let touched=false;fixture({context:{navigator:{serviceWorker:{controller:{},getRegistrations:async()=>{touched=true;return[];},addEventListener:()=>{touched=true;}}}}});
 await Promise.resolve();assert.equal(touched,false);
});

test('force reload coalesces repeated accelerators and worker activation into one navigation',async()=>{
 const events=new Map(),reloads=[],messages=[];let finishUpdate,updates=0;
 const update=new Promise(resolve=>{finishUpdate=resolve;});
 const registration={scope:'http://127.0.0.1:43000/',update:()=>{updates++;return update;},waiting:{postMessage:value=>messages.push(value)}};
 const sw={controller:{},getRegistrations:async()=>[],getRegistration:async()=>registration,
  addEventListener:(name,fn)=>{const set=events.get(name)||new Set();set.add(fn);events.set(name,set);},removeEventListener:(name,fn)=>events.get(name)?.delete(fn)};
 const location={origin:'http://127.0.0.1:43000',pathname:'/',hash:'',reload:()=>reloads.push(true)};
 const f=fixture({bundledWorkspace:true,context:{navigator:{serviceWorker:sw},location}});
 const first=f.window.termdockDesktop.reloadWorkspace({force:true});
 const second=f.window.termdockDesktop.reloadWorkspace({force:true});
 assert.equal(first,second);
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(updates,1);assert.equal(reloads.length,0);
 finishUpdate();
 for(let i=0;i<16;i++)await Promise.resolve();
 assert.equal(messages.length,1);assert.equal(reloads.length,0);
 for(const callback of [...events.get('controllerchange')])callback();
 await first;assert.equal(reloads.length,1);
 for(const callback of [...events.get('controllerchange')])callback();
 await f.window.termdockDesktop.reloadWorkspace({force:true});assert.equal(reloads.length,1);
});

test('late update completion after pagehide cannot reload a replacement document',async()=>{
 let finish;const updates=new Promise(resolve=>{finish=resolve;});let reloads=0;
 const registration={scope:'http://127.0.0.1:43000/',update:()=>updates};
 const f=fixture({context:{navigator:{serviceWorker:{getRegistration:async()=>registration}},location:{origin:registration.scope.slice(0,-1),pathname:'/',hash:'',reload:()=>reloads++}}});
 const task=f.window.termdockDesktop.reloadWorkspace({force:true});
 for(let i=0;i<8;i++)await Promise.resolve();
 f.listeners.get('pagehide')({});finish();await task;assert.equal(reloads,0);
});

test('force reload still navigates once when the worker update fails',async()=>{
 let reloads=0;
 const registration={scope:'http://127.0.0.1:43000/',update:async()=>{throw Error('offline');}};
 const f=fixture({context:{navigator:{serviceWorker:{getRegistration:async()=>registration}},location:{origin:registration.scope.slice(0,-1),pathname:'/',hash:'',reload:()=>reloads++}}});
 await f.window.termdockDesktop.reloadWorkspace({force:true});assert.equal(reloads,1);
});

test('a repeated shortcut in a replacement loading document does not restart startup',async()=>{
 let reloads=0;const storage=new Map([['termdock-preview-reload-at',String(Date.now())]]);
 const f=fixture({storage,context:{Date,document:{getElementById:()=>({hidden:false})},location:{origin:'http://127.0.0.1:43000',pathname:'/',hash:'',reload:()=>reloads++}}});
 await f.window.termdockDesktop.reloadWorkspace({force:true});assert.equal(reloads,0);
});

test('Web terminal opens only the final external URL and copies text on the client through bounded desktop IPC',async()=>{
 const f=fixture(),api=f.window.termdockDesktop;assert.equal(api.capabilities.webWorkspace,true);
 await api.openExternal('https://example.test/terminal?q=1#L2');await api.writeClipboardText('远程选区');
 assert.deepEqual(JSON.parse(JSON.stringify(f.ipc.map(({op,args})=>({op,args})))),[{op:'openExternal',args:{url:'https://example.test/terminal?q=1#L2'}},{op:'clipboardWriteText',args:{text:'远程选区'}}]);
 const before=f.ipc.length;for(const url of ['javascript:alert(1)','file:///tmp/private','https://user:pass@example.test/'])await assert.rejects(api.openExternal(url));await assert.rejects(api.writeClipboardText('x'.repeat(262145)));assert.equal(f.ipc.length,before);
 f.listeners.get('pagehide')({});await assert.rejects(api.writeClipboardText('late'));assert.equal(f.ipc.length,before);
});
test('normal coordinate-based OS drops select the hovered Web terminal and reuse verified local paths without uploading',async()=>{
 const dom=new JSDOM('<div data-termdock-terminal-dropzone="view-a"></div><div data-termdock-terminal-dropzone="view-b"></div>'),doc=dom.window.document,target=doc.querySelector('[data-termdock-terminal-dropzone="view-b"]');
 doc.elementFromPoint=(x,y)=>{assert.equal(x,240);assert.equal(y,120);return target;};
 const f=fixture({context:{document:doc,CustomEvent:dom.window.CustomEvent},invoke:async op=>op==='dropFiles'?{batch:null,files:[{name:'local.txt',path:'/Users/test/local.txt'}]}:null});
 const delivered=[];f.window.termdockDesktop.onNativeFileDrop(value=>delivered.push(value));
 f.listeners.get('termdock:preview-drag')({detail:{phase:'enter',x:240,y:120,local:true}});assert.equal(target.dataset.nativeFileDropState,'local');
 f.listeners.get('termdock:preview-files')({detail:{token:'os-drop',x:240,y:120}});
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(delivered.length,1);assert.equal(delivered[0].sessionKey,'view-b');assert.deepEqual(Array.from(delivered[0].paths),['/Users/test/local.txt']);assert.equal(f.calls.length,0);assert.equal(target.dataset.nativeFileDropState,'inserted');assert.equal(target.dataset.nativeFileDrag,'true');dom.window.close();
});
test('native remote upload displays progress and cancel aborts the page request without delivering paths',async()=>{
 const dom=new JSDOM('<div data-termdock-terminal-dropzone="view-a"></div>'),target=dom.window.document.querySelector('div');
 const batch='11111111-1111-4111-8111-111111111111',receipt='22222222-2222-4222-8222-222222222222';
 const f=fixture({context:{document:dom.window.document,CustomEvent:dom.window.CustomEvent,FormData,Blob},invoke:async op=>op==='dropFiles'?{batch,files:[{index:0,name:'remote.txt',size:1}]}:op==='fileChunk'?{index:0,seq:0,offset:0,length:1,eof:true,receipt,base64:'QQ=='}:null});
 let signal;f.window.fetch=async(url,options)=>{
  if(String(url).includes('csrf'))return new Response(JSON.stringify({csrfToken:'csrf'}));
  signal=options.signal;options.onUploadProgress(Math.floor(options.body.size/2));
  return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError'))));
 };
 const delivered=[];f.window.termdockDesktop.onNativeFileDrop(value=>delivered.push(value));
 f.listeners.get('termdock:preview-files')({detail:{token:'drop',sessionKey:'view-a'}});
 for(let i=0;i<50&&!signal;i++)await new Promise(resolve=>setTimeout(resolve,2));assert(signal);assert.equal(target.dataset.nativeFileDropState,'uploading');assert.equal(target.dataset.nativeFileDrag,'true');assert(Number(target.dataset.nativeFileDropProgress)>0);
 f.listeners.get('termdock:file-drop-cancel')({target});await new Promise(resolve=>setTimeout(resolve,0));assert(signal.aborted);assert.deepEqual(delivered,[]);assert.equal(target.dataset.nativeFileDropState,'cancelled');dom.window.close();
});

test('workspace transfers certificate recovery to the bundled center without receiving trust capabilities',async()=>{
 const service=fixture(),center=fixture({local:true});
 const connection={id:'owned',url:'https://entry.test',serviceOrigin:'https://target.test',routes:[{url:'https://backup.test',targetPeerId:'backup'}]};
 await service.window.termdockDesktop.reviewServiceConnection(connection,'private-invitation');
 assert.deepEqual(JSON.parse(JSON.stringify(service.ipc)),[{command:'preview_dispatch',op:'reviewConnection',args:{connection,invitation:'private-invitation'}}]);
 assert.equal(service.window.termdockDesktop.takeServiceConnectionReview,undefined);
 assert.equal(service.window.termdockDesktop.certificatePins,undefined);
 assert.equal(center.window.termdockDesktop.reviewServiceConnection,undefined);
 await center.window.termdockDesktop.takeServiceConnectionReview();
 assert.equal(center.ipc[0].op,'takeConnectionReview');
 let notified=0;
 const stop=center.window.termdockDesktop.onServiceConnectionReview(()=>notified++);
 center.listeners.get('termdock:preview-connection-review')({});assert.equal(notified,1);
 stop();center.listeners.get('termdock:preview-connection-review')({});assert.equal(notified,1);
});

test('a saved service identity mismatch cannot be recovered by trusting a TLS certificate',async()=>{
 const f=fixture({invoke:async()=>{throw 'Pinned target identity changed. Remove the old connection explicitly before adding it again.';}});
 await assert.rejects(f.window.termdockDesktop.openServiceConnection({url:'https://owned.test'}),error=>error.code==='PREVIEW_IDENTITY_REJECTED');
});
