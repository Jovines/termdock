// Runs only in the opt-in isolated App driver. Every operation below uses the
// real production WK bridge/capability. No PTY, business API, clipboard or keys.
function tdNativeGateBoundedRequest(bridge,payload,timeoutMs){
 let timer;return Promise.race([Promise.resolve().then(()=>bridge.request(payload)),new Promise((_,reject)=>{timer=setTimeout(()=>{const error=Error(`Native request timed out: ${payload.action}; consumption unknown; no retry`);error.name='NativeGateRequestTimeout';reject(error);},timeoutMs);})]).finally(()=>clearTimeout(timer));
}
function tdNativeGateExpectedRejection(error){if(['NativeGateRequestTimeout','NativeGateRetryDeadline','NativeGateEpochInterrupted'].includes(error?.name))throw error;return true;}
async function tdNativeGateTitlebarDoubleClick(window,document,currentOwner){
 const internals=window.__TAURI_INTERNALS__,host=document.querySelector('[data-termdock-window-header="true"],[data-tauri-drag-region],.widget,[data-session-sidebar-pinned] [data-session-sidebar-header]');
 if(!internals||typeof internals.invoke!=='function'||!host)throw Error('Owned legal titlebar header or Tauri bridge unavailable');
 const owner=currentOwner?currentOwner():null,ownerStamp=owner?{token:owner.token,epoch:owner.epoch}:null;
 const verifyOwner=()=>{if(!ownerStamp)return;const value=currentOwner();if(value?.token!==ownerStamp.token||value?.epoch!==ownerStamp.epoch)throw Error('Titlebar owner or page epoch changed');};
 verifyOwner();
 const original=internals.invoke;let receiptPromise;
 internals.invoke=function(command,args){const result=Reflect.apply(original,this,[command,args]);if(command==='preview_dispatch'&&args?.op==='titlebarDoubleClick')receiptPromise=Promise.resolve(result);return result;};
 let receipt;
 try{host.dispatchEvent(new window.MouseEvent('dblclick',{detail:2,bubbles:true,cancelable:true}));if(!receiptPromise)throw Error('Legal header double-click did not enter the production bridge');receipt=await receiptPromise;}
 finally{internals.invoke=original;}
 const validSnapshot=value=>value&&value.frame&&['x','y','width','height'].every(key=>Number.isFinite(value.frame[key]))&&typeof value.isZoomed==='boolean'&&typeof value.isMiniaturized==='boolean';
 if(!receipt||typeof receipt.preferenceKnown!=='boolean'||!validSnapshot(receipt.before)||!validSnapshot(receipt.after))throw Error('Invalid native titlebar receipt');
 if(!receipt.preferenceKnown){if(receipt.action!=='unsupported'||JSON.stringify(receipt.before)!==JSON.stringify(receipt.after))throw Error('Unknown titlebar preference changed the owned window');return{action:'unsupported',preferenceKnown:false,before:receipt.before,after:receipt.after,restoration:null};}
 if(!['Zoom','Minimize','None'].includes(receipt.action))throw Error('Invalid known titlebar preference action');
 if(receipt.action==='Zoom'&&receipt.before.isZoomed===receipt.after.isZoomed)throw Error('Zoom did not change the owned window zoom state');
 if(receipt.action==='Minimize'&&(!receipt.after.isMiniaturized||receipt.before.isMiniaturized))throw Error('Minimize did not miniaturize the owned window');
 if(receipt.action==='None'&&(JSON.stringify(receipt.before)!==JSON.stringify(receipt.after)))throw Error('None changed the owned window state');
 let restoration=null;
 if(receipt.action==='Minimize'){
  verifyOwner();
  restoration=await Reflect.apply(original,internals,['preview_dispatch',{op:'titlebarDoubleClick',args:{restore:true}}]);
  verifyOwner();
  if(restoration?.action!=='Minimize'||!restoration.preferenceKnown||!restoration.restored||JSON.stringify(restoration.before)!==JSON.stringify(receipt.after)||JSON.stringify(restoration.after)!==JSON.stringify(receipt.before))throw Error('Minimize did not restore the same owned window snapshot');
 }
 return {action:receipt.action,preferenceKnown:receipt.preferenceKnown,before:receipt.before,after:receipt.after,restoration:restoration?{before:restoration.before,after:restoration.after,restored:restoration.restored}:null};
}
function tdNativeGateRequester(bridge,currentToken,pause,trace=()=>{},timeoutMs=12000){
 const global=new Set(['create','hideAll','prepareOverlay','resumeAll','retireAll','closeView','closeAllViews']);
 return async(action,args={},capability)=>{
  const resolved=capability===undefined?(global.has(action)?null:currentToken()):capability;
  const payload={action,...(resolved?{token:resolved}:{}),...args};
  const started=performance.now();let attempt=0;
  while(true){const remaining=timeoutMs-(performance.now()-started);if(remaining<=0){const error=Error(`Native unconsumed Backpressure deadline: ${action}`);error.name='NativeGateRetryDeadline';throw error;}
   trace('request-start',{action,attempt:++attempt,token:resolved,sequence:args.sequence??null,cursor:args.cursor??null});
   try{const reply=await tdNativeGateBoundedRequest(bridge,payload,remaining);trace('request-end',{action,attempt,token:resolved,sequence:args.sequence??null,cursor:args.cursor??null,receipt:reply});return reply;}
   catch(error){trace('request-error',{action,attempt,token:resolved,sequence:args.sequence??null,cursor:args.cursor??null,error:String(error)});if(!String(error).includes('pending batch or callbacks must be drained')||performance.now()-started>timeoutMs)throw error;await pause(10);}
  }
 };
}
function tdNativeGateSignal(nonce,kind,data){
 if(!['progress','result'].includes(kind)||!Array.isArray(data.steps)||data.steps.length>64||!Array.isArray(data.acks)||data.acks.length>128||!Array.isArray(data.stages)||data.stages.length>128)throw Error('Producer snapshot entry bound exceeded');
 const index=(data.progressIndex??0)+(kind==='result'?1:0);if(!Number.isSafeInteger(index)||index<0||index>2048)throw Error('Producer index bound exceeded');
 const snapshot={version:1,nonce,kind,data:{...data,progressIndex:index}};
 const wire=JSON.stringify(snapshot);if(new TextEncoder().encode(wire).byteLength>65536)throw Error('Producer snapshot byte bound exceeded');
 const notification=`TD_NATIVE_GATE_SIGNAL:${nonce}:${data.pageEpoch}:${index}`;
 if(new TextEncoder().encode(notification).byteLength>512)throw Error('Producer notification bound exceeded');
 window.__TD_NATIVE_GATE_WIRE=wire;document.title=notification;
}
(async()=>{
 const nonce=window.__TD_NATIVE_GATE_NONCE,pageEpoch=window.__TD_NATIVE_GATE_EPOCH;
 const prior=window.__TD_NATIVE_GATE_STATE,interrupted=window.__TD_NATIVE_GATE_INTERRUPTED;delete window.__TD_NATIVE_GATE_INTERRUPTED;
 if(window.__TD_NATIVE_GATE_RUNNING){
  if(prior&&prior.pageEpoch!==pageEpoch){prior.cancelled=true;tdNativeGateSignal(nonce,'result',{ok:false,pageEpoch,error:prior.finished?'Previous gate driver already ended; no restart':'Existing driver crossed host page epoch; pending native result unknown; no retry',steps:prior.steps,acks:prior.acks,stages:prior.stages,stageDropped:prior.stageDropped,lastAction:prior.lastAction,previousPageEpoch:prior.pageEpoch,previousFinished:!!prior.finished});}
  return;
 }
 window.__TD_NATIVE_GATE_RUNNING=true;
 const state=window.__TD_NATIVE_GATE_STATE={pageEpoch,steps:[],acks:[],stages:[],stageDropped:0,lastAction:null,finished:false};delete window.__TD_NATIVE_GATE_NONCE;delete window.__TD_NATIVE_GATE_EPOCH;
 const steps=state.steps,events=[],acks=state.acks,stages=state.stages;let token,epoch,sequence=0,streamSequence=0,overflow=false,progressIndex=0,lastAction=null,stageDropped=0;
 const current=()=>{if(state.cancelled){const error=Error('Old driver epoch interrupted; no retry');error.name='NativeGateEpochInterrupted';throw error;}};
 const publish=(phase,detail)=>{
  current();
  if(detail)lastAction=detail;state.lastAction=lastAction;
  // Never retain request bodies (raw output, snapshots or resource bytes).
  if(stages.length===128){stages.shift();stageDropped++;}stages.push({pageEpoch,index:++progressIndex,phase,detail});state.stageDropped=stageDropped;
  tdNativeGateSignal(nonce,'progress',{pageEpoch,progressIndex,phase,lastAction,steps,acks,stages,stageDropped});
 };
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(test,message)=>{current();if(overflow)throw Error('Native event evidence bound exceeded');const start=performance.now();while(!test()){current();if(overflow)throw Error('Native event evidence bound exceeded');if(performance.now()-start>12000)throw Error(message);await sleep(10);}};
 try{
  if(interrupted){steps.push(...(interrupted.steps||[]));acks.push(...(interrupted.acks||[]));stages.push(...(interrupted.stages||[]));stageDropped=interrupted.stageDropped||0;lastAction=interrupted.lastAction;publish('unexpected-page-epoch/pending-result-unknown');throw Error('Unexpected page epoch interrupted native request; result unknown; no retry');}
  const reloadKey='termdock-native-gate-reload';
  const reload=JSON.parse(sessionStorage.getItem(reloadKey)||'null');
  if(reload){assert(reload.acks.length<=128&&reload.steps.length<=64&&(reload.stages||[]).length<=128,'Reload evidence bound exceeded');steps.push(...reload.steps);acks.push(...reload.acks);stages.push(...(reload.stages||[]));stageDropped=reload.stageDropped||0;streamSequence=reload.seq;}
  publish('driver-entered');if(reload)publish('reload-evidence-restored');
  publish('wait-production-bridge');await until(()=>window.termdockDesktop?.nativeTerminal?.available,'production bridge unavailable');publish('production-bridge-ready');
  if(window.__TAURI_INTERNALS__?.invoke&&document.querySelector){const titlebar=await tdNativeGateTitlebarDoubleClick(window,document);record(`actual owned-header titlebar ${titlebar.action}`,titlebar);}
  const bridge=window.termdockDesktop.nativeTerminal;
  bridge.subscribe(payload=>{if(events.length>=4096){overflow=true;return;}events.push(payload);});
  const request=tdNativeGateRequester(bridge,()=>token,sleep,(phase,detail)=>{
   const receipt=detail.receipt;
   publish(phase,{...detail,receipt:receipt?{pending:receipt.pending,duplicate:receipt.duplicate,complete:receipt.complete,token:receipt.token,epoch:receipt.epoch,sequence:receipt.sequence,detached:receipt.detached,hidden:receipt.hidden,status:receipt.status}:undefined});
  });
  const layout=async()=>{const value=await request('layout');assert(value.complete&&value.token===token&&value.epoch===epoch,'layout not actually complete');return value;};
  const base={action:'create',view:'native-gate-view',session:'controlled-backend-no-PTY',device:'controlled-device',fontSize:13,viewportWidth:innerWidth,viewportHeight:innerHeight,options:{columns:80,rows:24,history:0,palette:{ansi:Array.from({length:16},(_,i)=>[i*15,i*15,i*15]),foreground:[206,205,195],background:[28,27,26],cursor:[206,205,195],selection:[64,62,60]}}};
  const create=async()=>{const value=await request('create',base,null);token=value.token;epoch=value.epoch;sequence=value.sequence;await layout();return value;};
  const rect={x:24,y:80,width:Math.min(800,innerWidth-48),height:Math.min(450,innerHeight-104),viewportWidth:innerWidth,viewportHeight:innerHeight};
  const write=async(text,replay=false,end=true,step='controlled feed')=>{
   const seq=++sequence,cap=token,start=events.length,bytes=text instanceof Uint8Array?text:new TextEncoder().encode(text);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
   const reply=await request('write',{sequence:seq,base64:btoa(binary),replay,replayEnd:end,cursor:{seq:++streamSequence,epoch:'controlled-stream'}},cap);
   assert(reply.pending===seq,'write did not enter actual worker');
   publish('wait-consumption-ack',{action:'write',step,token:cap,epoch,sequence:seq,streamCursor:{seq:streamSequence,epoch:'controlled-stream'}});
   await until(()=>events.slice(start).some(e=>e.token===cap&&e.epoch===epoch&&e.event.type==='ack'&&e.event.sequence===seq),'actual consumption ACK absent; consumption unknown; no retry');
   const ack=events.slice(start).find(e=>e.token===cap&&e.epoch===epoch&&e.event.type==='ack'&&e.event.sequence===seq);
   assert(acks.length<128,'Native ACK evidence bound exceeded');
   acks.push({step,token:ack.token,epoch:ack.epoch,sequence:ack.event.sequence,event:{...ack.event},streamCursor:{seq:streamSequence,epoch:'controlled-stream'}});publish('consumption-ack',{action:'write',step,token:ack.token,epoch:ack.epoch,sequence:ack.event.sequence});await layout();
  };
  const input=()=>events.filter(e=>e.token===token&&e.epoch===epoch&&e.event.type==='input').map(e=>atob(e.event.base64)).join('');
  const copy=async(selection=false)=>{const cap=token,copyEpoch=epoch,start=events.length;await request('copy',{selection},cap);const matches=e=>e.token===cap&&e.epoch===copyEpoch&&e.event.type==='selection';await until(()=>events.slice(start).some(matches),'bounded text read absent');return events.slice(start).find(matches).event.text;};
  const inspect=()=>request('inspect');
  const capture=async()=>{const value=await request('capture',{sequence,cursor:{seq:streamSequence,epoch:'controlled-stream'}});assert(value?.data&&value.cursor.seq===streamSequence,'durable capture not supported');return value;};
  const record=(name,value)=>{assert(steps.length<64,'Native step evidence bound exceeded');steps.push({name,value});publish('step-complete');};
  if(reload){
   sessionStorage.removeItem(reloadKey);
   let rejected=false;try{await request('layout',{},reload.token);}catch(error){rejected=tdNativeGateExpectedRejection(error);}assert(rejected,'previous page epoch capability accepted');
   const rebind=await create();assert(epoch!==reload.epoch&&rebind.reused&&rebind.baseline.seq===reload.seq,'same VT/new page epoch baseline lost');
   await request('rect',rect);await layout();assert((await inspect()).sibling,'reload attachment missing');await request('retireView',{view:base.view,token});
   record('actual WK reload/page epoch rejects old capability and rebinds consumed VT',true);
   await create();assert((await request('closeView',{view:base.view},null)).detached,'explicit previous-page view close failed');await create();assert((await inspect()).surfaces===1,'explicit close leaked a surface');assert((await request('closeAllViews',{},null)).detached,'bulk close failed');await create();assert((await inspect()).surfaces===1,'bulk close leaked surfaces');await request('retireView',{view:base.view,token});record('explicit previous-page close and bulk close',true);
   state.finished=true;tdNativeGateSignal(nonce,'result',{ok:true,pageEpoch,progressIndex,steps,acks,stages,stageDropped,lastAction,actualWK:true,noPTY:true,noClipboard:true});return;
  }
  await create();await request('rect',rect);await layout();await request('visible',{visible:true});const attachment=await inspect();assert(attachment.mainThread&&attachment.sibling&&!attachment.hidden,'actual WK sibling missing');record('actual WK sibling/main thread',attachment);
  // Both branches enter the actual two-argument C read/free export. No OS clipboard.
  for(let n=0;n<3;n++){assert((await copy()).trim()==='', 'fresh empty viewport changed');assert((await copy(true)).trim()==='', 'no-selection viewport fallback changed');}
  await write('é中🙂',false,true,'text allocation Unicode before restore');
  for(let n=0;n<3;n++)assert((await copy()).includes('é中🙂'),'Unicode viewport read/free changed contents');
  await request('command',{command:'select_all'});await layout();
  for(let n=0;n<3;n++)assert((await copy(true)).includes('é中🙂'),'nonempty selection read/free changed contents');
  await request('rect',{...rect,width:rect.width-40});await layout();await write(' continued',false,true,'surface after text free');assert((await copy()).includes('continued'),'surface unusable after text free/resize/feed');
  record('actual empty/nonempty/Unicode/selection repeated read-free and continued feed/resize',{emptyReads:6,unicodeReads:3,selectionReads:3});
  await request('destroy');await create();await request('rect',rect);await layout();await request('visible',{visible:true});
  await write('\x1b[20h\x1b(0pq\x1b[?1049h\x1b(Babc\x1b[2;4H\x1b[6n',true,false,'controlled historical query hold');
  assert(input()==='','historical query escaped suppression');assert((await inspect()).replaying,'historical hold missing');
  const duplicate=await request('write',{sequence,base64:btoa('ignored'),replay:true,replayEnd:true,cursor:null});assert(duplicate.duplicate,'duplicate rejected');assert((await inspect()).replaying,'duplicate ended historical transaction');
  let gap=false;try{await request('write',{sequence:sequence+2,base64:btoa('gap'),replay:true,replayEnd:true,cursor:null});}catch(error){gap=tdNativeGateExpectedRejection(error);}assert(gap&&(await inspect()).replaying,'rejected gap changed hold');
  let oversized=false;try{await request('write',{sequence:sequence+1,base64:btoa('x'.repeat(262145)),replay:false,replayEnd:true,cursor:null});}catch(error){oversized=tdNativeGateExpectedRejection(error);}assert(oversized&&(await inspect()).replaying,'oversize changed historical hold');
  await write('',true,true,'controlled historical end barrier');assert(!(await inspect()).replaying,'legal end barrier failed to release suppression');record('duplicate/gap preserve historical hold; legal end barrier',await inspect());
  await write('\x1b[6n',false,true,'live DSR');assert(input().endsWith('\x1b[2;4R'),'live DSR cursor differs');assert(JSON.stringify((await inspect()).cursor)===JSON.stringify({x:3,y:1}),'IME anchor used as cursor');
  const snapshot=await capture(),before=await copy();
  await write('Z\x1b[?1049l\x1b8q\x1b[6n');const live={text:await copy(),cursor:(await inspect()).cursor,dsr:input().match(/\x1b\[[0-9]+;[0-9]+R/g)?.at(-1)};
  await request('destroy');await create();await request('rect',rect);await layout();const restored=await request('restore',{snapshot});assert(restored?.baseline?.seq===snapshot.cursor.seq,'restore baseline absent');token=restored.token;epoch=restored.epoch;sequence=restored.sequence;streamSequence=snapshot.cursor.seq;await layout();assert(input()==='','restore emitted Input/query');assert(await copy()===before,'restore changed ALT ASCII/BCE/Unicode contents');
  await write('Z\x1b[?1049l\x1b8q\x1b[6n');const recovered={text:await copy(),cursor:(await inspect()).cursor,dsr:input().match(/\x1b\[[0-9]+;[0-9]+R/g)?.at(-1)};assert(JSON.stringify(live)===JSON.stringify(recovered),'actual callback suffix/DSR differs after restore');record('durable ALT charset and actual suffix/DSR',recovered);
  await write('\x1b(Bé中🙂',false,true,'text allocation Unicode after restore');
  for(let n=0;n<3;n++)assert((await copy()).includes('é中🙂'),'restored Unicode viewport read/free changed contents');
  await request('command',{command:'select_all'});await layout();
  for(let n=0;n<3;n++)assert((await copy(true)).includes('é中🙂'),'restored selection read/free changed contents');
  record('restored actual Unicode and selection repeated read-free',{viewportReads:3,selectionReads:3});
  const start=events.length;await request('paste',{text:'\r'});await layout();await until(()=>events.slice(start).some(e=>e.token===token&&e.event.type==='input'),'External Enter callback missing');assert(events.slice(start).filter(e=>e.token===token&&e.event.type==='input').map(e=>atob(e.event.base64)).join('')==='\r\n','restored External LNM mirror missing');record('restored External CR expands CRLF',true);
  await request('checkpoint',{sequence,cursor:{seq:streamSequence,epoch:'controlled-stream'}});const previous=token,reused=await create();assert(reused.reused&&reused.baseline.seq===streamSequence,'living rebind baseline absent');await request('rect',rect);await layout();let stale=false;try{await request('layout',{},previous);}catch(error){stale=tdNativeGateExpectedRejection(error);}assert(stale,'old capability accepted');record('same rect living rebind/stale capability reject',true);
  await request('rect',{...rect,width:rect.width-40});await layout();record('changed rect barrier',await inspect());
  let invalidGlobal;try{await request('hideAll',{generation:'controlled-invalid',token});}catch(error){tdNativeGateExpectedRejection(error);invalidGlobal=String(error);}
  assert(/unknown field.*token/.test(invalidGlobal||''),'global token rejection was weakened');record('production global token rejection',invalidGlobal);
  const hidden=await request('hideAll',{generation:'controlled-overlay'},null);assert(hidden.hidden&&hidden.views.includes(base.view),'hideAll not confirmed');assert((await inspect()).hidden,'actual NSView still visible');
  await request('clip',{holes:[[rect.x+10,rect.y+10,20,20]],generation:'controlled-overlay',viewportWidth:innerWidth,viewportHeight:innerHeight});await request('visible',{visible:true});assert(!(await inspect()).hidden,'clip/show failed');await request('hideAll',{generation:'controlled-overlay-2'},null);const detached=await request('retireView',{view:base.view,token});assert(detached.detached,'main-thread detach absent');record('actual hide/clip/show/detach',true);
  await request('resumeAll',{generation:'controlled-resume'},null);await create();await request('rect',rect);await layout();await request('history',{history:1000});await layout();await write('history\r\n'.repeat(100));let data=JSON.parse((await capture()).data);assert(data.state.row_states.filter(r=>r.screen==='primary').length>(await layout()).dimensions.rows,'zero to nonzero history failed');await request('history',{history:0});await layout();data=JSON.parse((await capture()).data);assert(data.state.row_states.filter(r=>r.screen==='primary').length===(await layout()).dimensions.rows,'history zero did not immediately trim');record('dynamic primary history zero/nonzero/zero',true);
  const partialCapture=()=>request('capture',{sequence,cursor:{seq:streamSequence,epoch:'controlled-stream'}});
  await write(new Uint8Array([0xe4]),false,true,'split UTF8 prefix');assert((await partialCapture()).status==='Unsafe','UTF8 partial was treated as durable ground');
  await write(new Uint8Array([0xb8,0xad]),false,true,'split UTF8 completion');assert((await copy()).includes('中'),'split UTF8 lost a codepoint');
  await write('\x1b',false,true,'split ESC prefix');assert((await partialCapture()).status==='Unsafe','ESC partial was treated as durable ground');
  await write('[?1049hALT\x1b[?1049l',false,true,'split ESC and alternate completion');await capture();record('actual partial UTF8/ESC Unsafe and completed alternate output',true);
  let clearRejected=false;try{await request('command',{command:'clear_screen'});}catch(error){clearRejected=tdNativeGateExpectedRejection(error);}assert(clearRejected,'unjournalled mutation accepted');record('unjournalled clear rejected',true);
  for(let n=0;n<36;n++){const value=await request('retireView',{view:base.view,token});assert(value.detached,'close not confirmed');await create();assert((await inspect()).surfaces===1,'surface registry leaked');}
  await request('retireView',{view:base.view,token});record('36 actual drop/create cycles',true);
  await create();await request('rect',rect);await layout();await write('reload baseline',false,true,'reload checkpoint');await request('checkpoint',{sequence,cursor:{seq:streamSequence,epoch:'controlled-stream'}});
  publish('reload-requested');await until(()=>window.__TD_NATIVE_GATE_STAGE_RECEIPT?.nonce===nonce&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.pageEpoch===pageEpoch&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.index===progressIndex,'reload intent stage receipt absent');
  sessionStorage.setItem(reloadKey,JSON.stringify({steps,acks,stages,stageDropped,token,epoch,seq:streamSequence}));location.reload();
 }catch(error){if(state.cancelled)return;state.finished=true;tdNativeGateSignal(nonce,'result',{ok:false,pageEpoch,progressIndex,steps,acks,stages,stageDropped,lastAction,error:String(error)});}
})();
