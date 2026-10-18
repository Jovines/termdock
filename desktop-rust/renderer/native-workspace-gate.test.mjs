import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function recordSnapshot(context,value,titles){
 assert(new TextEncoder().encode(value).length<=512);assert.match(value,/^TD_NATIVE_GATE_SIGNAL:/);
 const snapshot=JSON.parse(context.window.__TD_NATIVE_GATE_WIRE);
 titles.push(`${snapshot.kind==='progress'?'TD_NATIVE_GATE_PROGRESS':'TD_NATIVE_GATE'}:${snapshot.nonce}:`+JSON.stringify(snapshot.data));
}
function factory(bridge,currentToken=()=> 'owned-surface',trace=()=>{},timeoutMs=12000){
 const context={window:{__TD_NATIVE_GATE_RUNNING:true},performance,Set,setTimeout,clearTimeout,TextEncoder};
 vm.runInNewContext(fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8'),context);
 return context.tdNativeGateRequester(bridge,currentToken,async()=>{},trace,timeoutMs);
}
test('actual driver requester emits global actions without a surface token and binds surface actions to the current token',async()=>{
 const calls=[],request=factory({request:async value=>{calls.push(value);return{};}});
 for(const action of ['hideAll','resumeAll','retireAll'])await request(action,{generation:'controlled'});
 await request('create',{view:'controlled'});await request('closeView',{view:'controlled'});await request('closeAllViews');
 for(const call of calls)assert(!Object.hasOwn(call,'token'),call.action);
 await request('layout');assert.equal(calls.at(-1).token,'owned-surface');
 await request('hideAll',{generation:'second'},null);assert.deepEqual({...calls.at(-1)},{action:'hideAll',generation:'second'});
});
test('unknown write consumption times out once with action evidence and never retries',async()=>{
 const calls=[],progress=[];
 const request=factory({request:value=>{calls.push(value);return new Promise(()=>{});}},()=> 'actual',(...event)=>progress.push(event),10);
 await assert.rejects(request('write',{sequence:19,cursor:{seq:42,epoch:'stream'}}),/write; consumption unknown; no retry/);
 assert.equal(calls.length,1);assert.deepEqual(progress.map(e=>e[0]),['request-start','request-error']);
 assert.equal(progress[0][1].sequence,19);assert.equal(progress[0][1].cursor.seq,42);
 assert.equal(progress[1][1].token,'actual');
});
test('bounded request records receipt and clears timeout without manufacturing a consumption ACK',async()=>{
 const progress=[];const request=factory({request:async()=>({pending:9})},()=> 'actual',(...event)=>progress.push(event),10);
 assert.equal((await request('write',{sequence:9})).pending,9);
 assert.deepEqual(progress.map(e=>e[0]),['request-start','request-end']);assert.equal(progress[1][1].receipt.pending,9);
 await new Promise(r=>setTimeout(r,20));assert.equal(progress.length,2);
});
test('owned titlebar driver dispatches a legal DOM double-click, records native receipt, and restores only Minimize',async()=>{
 const source=fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8');
 for(const action of ['Zoom','Minimize','None','unsupported']){
  const calls=[],before={frame:{x:1,y:2,width:800,height:600},isZoomed:false,isMiniaturized:false};
  const after=action==='Zoom'?{...before,isZoomed:true}:action==='Minimize'?{...before,isMiniaturized:true}:before;
  let event;const internals={invoke:async(command,args)=>{calls.push({command,args});if(args.op==='titlebarDoubleClick'&&args.args?.restore)return{action,before:after,after:before,restored:true,preferenceKnown:true};return{action,before,after,restored:false,preferenceKnown:action!=='unsupported'};}};
  const host={dispatchEvent:value=>{event=value;void internals.invoke('preview_dispatch',{op:'titlebarDoubleClick',args:{}});}};
  const context={window:{__TD_NATIVE_GATE_RUNNING:true,__TAURI_INTERNALS__:internals,MouseEvent:class{constructor(type,init){this.type=type;Object.assign(this,init);}}},document:{querySelector:()=>host},TextEncoder};
  vm.runInNewContext(source,context);
  const result=await context.tdNativeGateTitlebarDoubleClick(context.window,context.document,()=>({token:'owned-token',epoch:'owned-epoch'}));
  assert.equal(event.type,'dblclick');assert.equal(event.detail,2);assert.equal(calls[0].command,'preview_dispatch');
  assert.equal(result.action,action);assert.deepEqual({...result.before},{...before});
  assert.equal(calls.length,action==='Minimize'?2:1);
  if(action==='Minimize'){assert.equal(calls[1].args.op,'titlebarDoubleClick');assert.deepEqual({...calls[1].args.args},{restore:true});assert.equal(result.restoration.restored,true);}
 }
});
test('titlebar driver refuses Minimize restoration after its owned page epoch changes',async()=>{
 const source=fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8'),calls=[];
 const normal={frame:{x:1,y:2,width:800,height:600},isZoomed:false,isMiniaturized:false},minimized={...normal,isMiniaturized:true};
 const original=async(command,args)=>{calls.push({command,args});return{action:'Minimize',preferenceKnown:true,before:normal,after:minimized,restored:false};};
 let ownerReads=0;const internals={invoke:original},host={dispatchEvent(){void internals.invoke('preview_dispatch',{op:'titlebarDoubleClick',args:{}});}};
 const context={window:{__TD_NATIVE_GATE_RUNNING:true,__TAURI_INTERNALS__:internals,MouseEvent:class{constructor(type,init){this.type=type;Object.assign(this,init);}}},document:{querySelector:()=>host},TextEncoder};
 vm.runInNewContext(source,context);
 await assert.rejects(context.tdNativeGateTitlebarDoubleClick(context.window,context.document,()=>({token:'owned-token',epoch:++ownerReads<3?'epoch-a':'epoch-b'})),/owner or page epoch changed/);
 assert.equal(calls.length,1);assert.equal(internals.invoke,original);
});
test('a stalled negative request is a timeout failure, not proof of a production rejection',()=>{
 const context={window:{__TD_NATIVE_GATE_RUNNING:true},performance,Set,setTimeout,clearTimeout,TextEncoder};
 vm.runInNewContext(fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8'),context);
 assert.equal(context.tdNativeGateExpectedRejection(Error('actual production rejection')),true);
 const timeout=Error('write consumption unknown');for(const name of ['NativeGateRequestTimeout','NativeGateRetryDeadline']){timeout.name=name;assert.throws(()=>context.tdNativeGateExpectedRejection(timeout),error=>error===timeout);}
});
test('new page restores prior observed ACKs before bridge wait, preserving them on an early failure',async()=>{
 let clock=0;const titles=[];
 const prior={steps:[{name:'observed step',value:true}],acks:[{sequence:7,token:'actual-old',epoch:'actual-epoch',event:{type:'ack',sequence:7},streamCursor:{seq:42,epoch:'stream'}}],stages:Array.from({length:128},(_,index)=>({pageEpoch:'old-page',index,phase:'old-actual-stage'})),stageDropped:2,seq:42};
 const document={set title(value){recordSnapshot(context,value,titles);}};
 const context={window:{__TD_NATIVE_GATE_NONCE:'controlled',__TD_NATIVE_GATE_EPOCH:'new-actual-page'},document,
  sessionStorage:{getItem:()=>JSON.stringify(prior)},performance:{now:()=>clock+=13000},Set,setTimeout,clearTimeout,TextEncoder};
 await vm.runInNewContext(fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8'),context);
 const first=JSON.parse(titles[0].split('TD_NATIVE_GATE_PROGRESS:controlled:')[1]);
 const final=JSON.parse(titles.at(-1).split('TD_NATIVE_GATE:controlled:')[1]);
 assert.deepEqual(first.acks,prior.acks);assert.deepEqual(final.acks,prior.acks);assert.equal(first.pageEpoch,'new-actual-page');
 assert.equal(final.stages.length,128);assert(final.stageDropped>2);assert.equal(final.stages.at(-1).pageEpoch,'new-actual-page');
 assert.equal(final.ok,false);assert.match(final.error,/production bridge unavailable/);
});
test('same JS context with a new host epoch stops the old pending create and ignores its late result',async()=>{
 const source=fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8'),titles=[],calls=[];let complete;
 const context=vm.createContext({window:{__TD_NATIVE_GATE_NONCE:'nonce',__TD_NATIVE_GATE_EPOCH:'old',termdockDesktop:{nativeTerminal:{available:true,subscribe:()=>()=>{},request:value=>{calls.push(value);return new Promise(resolve=>complete=resolve);}}}},
  document:{set title(value){recordSnapshot(context,value,titles);}},sessionStorage:{getItem:()=>null},performance,Set,setTimeout,clearTimeout,TextEncoder,innerWidth:1000,innerHeight:700});
 const first=vm.runInContext(source,context);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);assert.equal(calls[0].action,'create');
 const before=titles.length;context.window.__TD_NATIVE_GATE_NONCE='nonce';context.window.__TD_NATIVE_GATE_EPOCH='old';await vm.runInContext(source,context);assert.equal(titles.length,before);assert.equal(calls.length,1);
 context.window.__TD_NATIVE_GATE_NONCE='nonce';context.window.__TD_NATIVE_GATE_EPOCH='new';await vm.runInContext(source,context);
 const count=titles.length,result=JSON.parse(titles.at(-1).split('TD_NATIVE_GATE:nonce:')[1]);assert.equal(result.pageEpoch,'new');assert.equal(result.previousPageEpoch,'old');assert.match(result.error,/result unknown; no retry/);
 complete({token:'late-old',epoch:'old',sequence:0});await first;assert.equal(calls.length,1);assert.equal(titles.length,count);assert.deepEqual(result.acks,[]);
});
test('a finished driver is distinguished from a pending one and is never restarted in a new epoch',async()=>{
 const titles=[];const context={window:{__TD_NATIVE_GATE_NONCE:'nonce',__TD_NATIVE_GATE_EPOCH:'new',__TD_NATIVE_GATE_RUNNING:true,__TD_NATIVE_GATE_STATE:{pageEpoch:'old',finished:true,steps:[],acks:[],stages:[],stageDropped:0}},document:{set title(value){recordSnapshot(context,value,titles);}},TextEncoder};
 await vm.runInNewContext(fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8'),context);
 const result=JSON.parse(titles[0].split('TD_NATIVE_GATE:nonce:')[1]);assert.equal(result.previousFinished,true);assert.match(result.error,/already ended; no restart/);assert.equal(result.ok,false);
});
test('fresh JS document interrupted by an unexpected host epoch preserves evidence without sending another create',async()=>{
 const titles=[],calls=[],interrupted={pageEpoch:'old',steps:[],acks:[{sequence:3,token:'actual-old',epoch:'old'}],stages:[],lastAction:{action:'create'},stageDropped:0};
 const context={window:{__TD_NATIVE_GATE_NONCE:'nonce',__TD_NATIVE_GATE_EPOCH:'new',__TD_NATIVE_GATE_INTERRUPTED:interrupted,termdockDesktop:{nativeTerminal:{available:true,request:value=>calls.push(value)}}},document:{set title(value){recordSnapshot(context,value,titles);}},performance,Set,setTimeout,clearTimeout,TextEncoder};
 await vm.runInNewContext(fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8'),context);
 const result=JSON.parse(titles.at(-1).split('TD_NATIVE_GATE:nonce:')[1]);assert.deepEqual(calls,[]);assert.deepEqual(result.acks,interrupted.acks);assert.equal(result.pageEpoch,'new');assert.match(result.error,/result unknown; no retry/);
});
test('invalid explicit global tokens reach the production boundary and its rejection is preserved',async()=>{
 let observed;
 const request=factory({request:async value=>{observed=value;if(Object.hasOwn(value,'token'))throw Error('unknown field token, expected generation');return{};}});
 await assert.rejects(request('hideAll',{generation:'g',token:'incorrect'}),/unknown field token/);
 assert.equal(observed.token,'incorrect');
});
test('an unconsumed retry repeats the same capability; Pending remains a receipt, never an ACK',async()=>{
 const calls=[];let token='original';const request=factory({request:async value=>{calls.push(value);if(calls.length===1){token='replacement';throw Error('pending batch or callbacks must be drained');}return{pending:7};}},()=>token);
 assert.deepEqual(await request('write',{sequence:7}),{pending:7});assert.equal(calls.length,2);assert.equal(calls[0],calls[1]);assert.equal(calls[1].token,'original');
});
test('short title notification survives a truncating observer while the exact large producer snapshot stays separate',()=>{
 const window={__TD_NATIVE_GATE_RUNNING:true},signals=[];const context={window,TextEncoder,document:{set title(value){signals.push(value.slice(0,512));}}};
 vm.runInNewContext(fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8'),context);
 const data={pageEpoch:'actual-page',progressIndex:14,phase:'consumption-ack',steps:[{name:'actual fixture',value:'中'.repeat(1000)}],acks:[{sequence:7,token:'actual',epoch:'actual-page',event:{type:'ack',sequence:7}}],stages:[],stageDropped:0};
 context.tdNativeGateSignal('nonce','progress',data);assert(signals[0].length<512);assert(!signals[0].includes('acks'));assert(!signals[0].includes('中'));
 const wire=JSON.parse(window.__TD_NATIVE_GATE_WIRE);assert.deepEqual(wire.data,data);assert(new TextEncoder().encode(window.__TD_NATIVE_GATE_WIRE).length>2000);
});
test('producer rejects oversized entries or UTF8 bytes before replacing the last valid bounded snapshot',()=>{
 const window={__TD_NATIVE_GATE_RUNNING:true},signals=[];const context={window,TextEncoder,document:{set title(value){signals.push(value);}}};
 vm.runInNewContext(fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8'),context);
 const data={pageEpoch:'owned',progressIndex:1,steps:[],acks:[],stages:[]};context.tdNativeGateSignal('nonce','progress',data);const previous=window.__TD_NATIVE_GATE_WIRE;
 assert.throws(()=>context.tdNativeGateSignal('nonce','progress',{...data,acks:Array(129).fill(null)}),/entry bound/);
 assert.throws(()=>context.tdNativeGateSignal('nonce','progress',{...data,steps:[{value:'中'.repeat(23000)}]}),/byte bound/);
 assert.throws(()=>context.tdNativeGateSignal('x'.repeat(600),'progress',data),/notification bound/);assert.equal(window.__TD_NATIVE_GATE_WIRE,previous);assert.equal(signals.length,1);
});
test('final status has a distinct monotonic signal even when a title observer ignores unchanged titles',()=>{
 const window={__TD_NATIVE_GATE_RUNNING:true},signals=[];let last;
 const context={window,TextEncoder,document:{set title(value){if(value!==last)signals.push(value);last=value;}}};
 vm.runInNewContext(fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8'),context);
 const data={pageEpoch:'actual',progressIndex:5,steps:[],acks:[],stages:[]};context.tdNativeGateSignal('nonce','progress',data);context.tdNativeGateSignal('nonce','result',{...data,ok:true});
 assert.equal(signals.length,2);assert.notEqual(signals[0],signals[1]);assert.equal(JSON.parse(window.__TD_NATIVE_GATE_WIRE).data.progressIndex,6);assert.equal(JSON.parse(window.__TD_NATIVE_GATE_WIRE).data.ok,true);
});

// Reach the reloaded driver branch with controlled normal-capability replies.
test('a reloaded driver completes its observed steps without shadowing lifecycle state',async()=>{
 const source=fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8');let creates=0,token;const calls=[],titles=[];
 const prior={steps:[],acks:[],stages:[],stageDropped:0,token:'previous-page',epoch:'old',seq:42};
 const bridge={available:true,subscribe:()=>()=>{},request:async payload=>{
  calls.push(payload);
  if(payload.action==='create'){token=`new-${++creates}`;return{token,epoch:'new',sequence:0,reused:true,baseline:{seq:42}};}
  if(payload.action==='layout'){if(payload.token==='previous-page')throw Error('stale capability');return{complete:true,token,epoch:'new',dimensions:{columns:80,rows:24}};}
  if(payload.action==='inspect')return{sibling:true,surfaces:1};
  if(['retireView','closeView','closeAllViews'].includes(payload.action))return{detached:true};
  return{};
 }};
 const context={window:{__TD_NATIVE_GATE_NONCE:'nonce',__TD_NATIVE_GATE_EPOCH:'new',termdockDesktop:{nativeTerminal:bridge}},document:{set title(value){recordSnapshot(context,value,titles);}},
 sessionStorage:{getItem:()=>JSON.stringify(prior),removeItem:()=>{}},performance,Set,setTimeout,clearTimeout,TextEncoder,innerWidth:1000,innerHeight:700};
 await vm.runInNewContext(source,context);
 const result=JSON.parse(context.window.__TD_NATIVE_GATE_WIRE).data;assert.equal(result.ok,true);assert.equal(context.window.__TD_NATIVE_GATE_STATE.finished,true);assert.equal(result.steps.length,2);assert.deepEqual(result.acks,[]);assert.equal(creates,4);
});
