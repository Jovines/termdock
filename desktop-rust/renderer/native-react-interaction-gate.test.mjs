import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const source=fs.readFileSync(new URL('./native-react-interaction-gate.js',import.meta.url),'utf8');
test('actual driver waits for a normal enabled install button after confirmation closes before clicking once',async()=>{
 const {window}=new JSDOM('<section><button disabled>Restart and install</button></section>');
 const context=vm.createContext({document:window.document,Error});vm.runInContext(source,context);
 const root=window.document.querySelector('section'),button=root.querySelector('button');let clicks=0,observations=0;button.onclick=()=>clicks++;
 await context.tdNativeReactInteractionClick(root,/^Restart and install$/,async predicate=>{assert.equal(predicate(),undefined);observations++;await Promise.resolve();assert.equal(clicks,0);button.disabled=false;assert.equal(predicate(),button);},'still pending');
 assert.equal(observations,1);assert.equal(clicks,1);window.close();
});
test('actual driver preserves a bounded wait failure and does not click when readiness never returns',async()=>{
 const {window}=new JSDOM('<section><button disabled>Restart and install</button></section>');const context=vm.createContext({document:window.document,Error});vm.runInContext(source,context);let clicks=0;window.document.querySelector('button').onclick=()=>clicks++;
 await assert.rejects(context.tdNativeReactInteractionClick(window.document.querySelector('section'),/Restart and install/,async predicate=>{assert.equal(predicate(),undefined);throw Error('ordinary action still pending');},'missing'),/still pending/);assert.equal(clicks,0);window.close();
});
test('actual feedback predicate uses the production client API message and requires the normal alert role',()=>{
 const {window}=new JSDOM('<section data-preview-feedback role="alert"><p>Failed to dismiss server health</p><button>×</button></section>');const context=vm.createContext({document:window.document,Error});vm.runInContext(source,context);
 assert(context.tdNativeReactInteractionFeedback('Failed to dismiss server health'));assert.equal(context.tdNativeReactInteractionFeedback('Controlled health dismissal failure'),null);window.document.querySelector('section').removeAttribute('role');assert.equal(context.tdNativeReactInteractionFeedback('Failed to dismiss server health'),null);window.close();
});

test('actual install driver rejects a stale ready state without clicking an enabled old button',async()=>{
 const {window}=new JSDOM('<section><button>Restart and install</button></section>');const context=vm.createContext({document:window.document,Error});vm.runInContext(source,context);let clicks=0;window.document.querySelector('button').onclick=()=>clicks++;
 await assert.rejects(context.tdNativeReactInteractionClick(window.document.querySelector('section'),/Restart and install/,async predicate=>assert(predicate()),'ready changed',()=>{},async()=>({status:'idle',controlledInstallCalls:1})),/ready changed/);assert.equal(clicks,0);window.close();
});
test('actual service-check selector cannot select the identically labelled desktop update action',()=>{
 const {window}=new JSDOM('<section aria-labelledby="termdock-update-title"><div id="termdock-update-title"></div><div><button id="service">Check for updates</button></div><div><button id="desktop">Check for updates</button></div></section>');const context=vm.createContext({document:window.document,Error});vm.runInContext(source,context);
 const settings=window.document.querySelector('section');assert.equal(context.tdNativeReactInteractionServiceCheck(settings).id,'service');window.document.getElementById('service').disabled=true;assert.equal(context.tdNativeReactInteractionServiceCheck(settings),null);window.close();
});

test('selection snapshots contain fixed scalar DOM facts without inventing native readiness',()=>{
 const {window}=new JSDOM('<button class="sidebar-session-primary">Controlled Second<span class="absolute inset-y-2 left-0"></span></button><div data-termdock-terminal-dropzone="terminal::owned-second"><div class="xterm">private output</div></div><div id="private-id">private text</div>');
 window.termdockPreviewLifecycle={snapshot:()=>({overlayReady:false,moving:true,hidden:true})};const context=vm.createContext({window,document:window.document,Error});vm.runInContext(source,context);
 const value=context.tdNativeReactFeedbackSnapshot('owned-second',{extraBackend:'second',events:[{type:'terminal-open',backend:'second'}]});assert.equal(value.matchingViewports,1);assert.equal(value.xtermInMatchingViewport,1);assert.equal(value.selectionIndicator,true);assert.equal(value.engineReady,null);assert.equal(value.overlayReady,false);assert.equal(value.secondOpen,true);const wire=JSON.stringify(value);for(const secret of ['private output','private-id','private text','owned-second'])assert.equal(wire.includes(secret),false);window.close();
});
test('selection ring retains the latest 16 changes with exact dropped count and deduplicates unchanged observations',()=>{
 const context=vm.createContext({Error});vm.runInContext(source,context);const buffer={samples:[],dropped:0,total:0,lastKey:null};for(let n=0;n<40;n++)context.tdNativeReactFeedbackRemember(buffer,{matchingViewports:n});context.tdNativeReactFeedbackRemember(buffer,{matchingViewports:39});assert.equal(buffer.samples.length,16);assert.equal(buffer.dropped,24);assert.equal(buffer.total,40);assert.equal(buffer.samples[0].matchingViewports,24);assert.equal(buffer.samples.at(-1).matchingViewports,39);
});
test('second ACK waiter keeps the full backend/flow/since/epoch predicate and publishes the latest failure sample',async()=>{
 const context=vm.createContext({Error});vm.runInContext(source,context);let final,calls=0;const buffer={samples:[],dropped:0,total:0,lastKey:null};
 const observe=phase=>{context.tdNativeReactFeedbackRemember(buffer,{phase,observation:++calls});return{samples:buffer.samples,dropped:buffer.dropped};};
 await assert.rejects(context.tdNativeReactFeedbackAwaitSecond({data:{extraBackend:'second'},model:async()=>({events:[{type:'output-ack',backend:'wrong',flowSeq:2,since:2,epoch:'controlled-stream-second'}]}),until:async predicate=>{for(let n=0;n<20;n++)assert.equal(await predicate(),false);throw Error('bounded diagnostic failure');},observe,publish:(phase,detail)=>{final={phase,detail};}}),/bounded diagnostic failure/);
 assert.equal(final.phase,'feedback-selection-failed');assert.equal(final.detail.selection.samples.length,16);assert.equal(final.detail.selection.samples.at(-1).phase,'failed');assert.equal(final.detail.selection.dropped,5);
 await context.tdNativeReactFeedbackAwaitSecond({data:{extraBackend:'second'},model:async()=>({events:[{type:'output-ack',backend:'second',flowSeq:2,since:2,epoch:'controlled-stream-second'}]}),until:async predicate=>assert.equal(await predicate(),true),observe,publish:()=>{throw Error('Unexpected failure');}});
});
test('owned input predicate rejects wrong backend and duplicate delivery',()=>{
 const context=vm.createContext({Error});vm.runInContext(source,context);const input={type:'input',backend:'second',data:'owned',bytes:5,receipt:'controlled-terminal-input-v1'};
 assert.equal(context.tdNativeReactInputReceipt({events:[]},'second','owned'),false);
 assert.equal(context.tdNativeReactInputReceipt({events:[input]},'second','owned'),true);
 assert.throws(()=>context.tdNativeReactInputReceipt({events:[{...input,backend:'first'}]},'second','owned'),/another backend/);
 assert.throws(()=>context.tdNativeReactInputReceipt({events:[input,input]},'second','owned'),/more than once/);
});
test('actual input driver selects three normal tabs, routes each marker once and deletes first two before third continues',async()=>{
 const {window}=new JSDOM('<main></main>');window.termdockPreviewLifecycle={snapshot:()=>({gate:{failed:false}})};
 const identities=[{name:'Controlled React',frontend:'a',backend:'back-a',token:'token-a'},{name:'Controlled Second',frontend:'b',backend:'back-b',token:'token-b'},{name:'Controlled Third',frontend:'c',backend:'back-c',token:'token-c'}];let cap={token:'token-a',epoch:'page'},items=[],events=[],calls=[],records=[];
 const add=index=>{const item=identities[index];if(items.includes(item))return;items.push(item);const row=window.document.createElement('div'),tab=window.document.createElement('button'),close=window.document.createElement('button'),zone=window.document.createElement('div');tab.className='sidebar-session-primary';tab.textContent=item.name;close.setAttribute('aria-label','Close '+item.name);zone.dataset.termdockTerminalDropzone='terminal::'+item.frontend;zone.setAttribute('aria-disabled',index===0?'false':'true');tab.onclick=()=>{for(const value of window.document.querySelectorAll('[data-termdock-terminal-dropzone]'))value.setAttribute('aria-disabled',String(value!==zone));cap={token:item.token,epoch:'page'};};close.onclick=()=>{items=items.filter(value=>value!==item);row.remove();zone.remove();};row.append(tab,close);window.document.querySelector('main').append(row,zone);if(index)events.push({type:'output-ack',backend:item.backend,flowSeq:2,since:2,epoch:index===1?'controlled-stream-second':'controlled-stream-third'});};add(0);
 const inspect=()=>({frontend:'a',backend:'back-a',extraFrontend:'b',extraBackend:'back-b',thirdFrontend:'c',thirdBackend:'back-c',inventory:{clientSessions:items.map(value=>({frontendSessionId:value.frontend}))},events});
 const context=vm.createContext({window,document:window.document,Error,Set});vm.runInContext(source,context);
 await context.tdNativeReactInputGate({request:async(action,args,token)=>{assert.equal(action,'paste');assert(!args.text.includes('\r'));assert(!args.text.includes('\n'));const owner=identities.find(item=>item.token===token);assert(items.includes(owner));calls.push({token,marker:args.text});events.push({type:'input',backend:owner.backend,data:args.text,bytes:args.text.length,receipt:'controlled-terminal-input-v1'});},model:async action=>{if(action==='feedback-add-session')add(1);if(action==='feedback-add-three-sessions')add(2);return inspect();},record:(name,value)=>records.push({name,value}),publish:()=>{},until:async(predicate,message)=>assert(await predicate(),message),capability:()=>cap});
 assert.deepEqual(calls.map(call=>call.token),['token-a','token-b','token-c','token-a','token-c']);assert.deepEqual(items.map(item=>item.frontend),['c']);assert.equal(records.at(-1).value.physicalKeysTested,false);window.close();
});
test('full App keyboard driver uses only fixed owned stages and real Input/model receipts without paste or forced focus',async()=>{
 const events=[],modelEvents=[],state={},records=[];let index=0;
 const expected=['a','b','A','\r','\t','\x7f'];
 const window={};const context=vm.createContext({window,Error,performance,atob,Array});vm.runInContext(source,context);context.tdNativeReactKeyboardComparison=async({gateState})=>{gateState.keyboardComparison=[];};
 await context.tdNativeReactKeyboardGate({request:async action=>assert.equal(action,'layout'),model:async()=>({frontend:'owned',backend:'backend',events:modelEvents}),record:(name,value)=>records.push(value),publish:(phase,detail)=>{index++;assert(['controlled-keyboard-case','controlled-keyboard-read'].includes(phase));if(phase==='controlled-keyboard-case'){events.push({token:'native',epoch:'page',event:{type:'input',base64:btoa(expected[detail.caseIndex])}});modelEvents.push({type:'input',backend:'backend',data:expected[detail.caseIndex],bytes:1});}window.__TD_NATIVE_KEYBOARD_RESULT={progressIndex:index,submitted:phase==='controlled-keyboard-case',stages:Array(20).fill(0),forcedFirstResponder:false};},until:async(predicate,message)=>assert(await predicate(),message),pause:async()=>{},capability:()=>({token:'native',epoch:'page'}),gateState:state,currentIndex:()=>index,nativeEvents:()=>events});
 assert.equal(records.length,6);assert.deepEqual(records.map(value=>value.nativeInputBytes[0]),[97,98,65,13,9,127]);assert(records.every(value=>value.forcedFirstResponder===false));
});

test('keyboard comparison separates initial WK/native, activation, and forced responder with exact owned receipts',async()=>{
 const {window}=new JSDOM('<main></main>'),events=[],modelEvents=[],state={};let index=0;
 const context=vm.createContext({window,document:window.document,Error,performance,atob,Array});vm.runInContext(source,context);
 await context.tdNativeReactKeyboardComparison({request:async action=>assert.equal(action,'layout'),model:async()=>({frontend:'owned',backend:'backend',events:modelEvents}),record:()=>{},publish:(phase,detail)=>{
  index++;assert(detail.caseIndex<5);assert(['controlled-keyboard-probe-prepare','controlled-keyboard-probe-send','controlled-keyboard-probe-read'].includes(phase));
  if(phase==='controlled-keyboard-probe-send'){
   if(detail.caseIndex===0||detail.caseIndex===2){assert.equal(window.document.activeElement.tagName,'INPUT');window.document.activeElement.value='a';}
   else {events.push({token:'native',epoch:'page',event:{type:'input',base64:btoa('a')}});modelEvents.push({type:'input',backend:'backend',data:'a',bytes:1});}
  }
  window.__TD_NATIVE_KEYBOARD_RESULT={progressIndex:index,submitted:phase.endsWith('-send'),prepared:phase.endsWith('-prepare'),contextBefore:Array(12).fill(0),contextAfter:Array(12).fill(1),stages:Array(20).fill(0)};
 },until:async(predicate,message)=>assert(await predicate(),message),pause:async()=>{},capability:()=>({token:'native',epoch:'page'}),gateState:state,currentIndex:()=>index,nativeEvents:()=>events});
 assert.equal(state.keyboardComparison.length,5);assert.equal(state.keyboardComparison[0].wkLetterMatched,true);assert.equal(state.keyboardComparison[2].wkLetterMatched,true);
 assert.deepEqual(Array.from(state.keyboardComparison,value=>value.forcedFirstResponder),[false,false,false,false,true]);assert.equal(state.keyboardComparison[3].modelMatched,true);assert.equal(window.document.querySelector('input'),null);window.close();
});
test('manual keyboard entry sends no keys and completes only from fixed user input and encrypted backend receipts',async()=>{
 const {window}=new JSDOM('<header data-termdock-window-header></header>'),modelEvents=[],native=[],state={};let pauses=0;
 window.addEventListener('keydown',event=>{if(event.key==='a')event.preventDefault();});
 const context=vm.createContext({window,document:window.document,Error,performance,atob,Array});vm.runInContext(source,context);
 await context.tdNativeReactKeyboardManual({model:async()=>({backend:'owned',events:modelEvents}),request:async action=>{assert.equal(action,'inspect');return {hidden:false,focused:true};},record:()=>{},publish:phase=>{if(phase==='manual-keyboard-final'||phase==='manual-keyboard-ready')window.__TD_NATIVE_MANUAL_COUNTER_INDEX=1;},until:async predicate=>assert(await predicate()),currentIndex:()=>1,pause:async()=>{
  const input=window.document.querySelector('input');const key=pauses++===0?'a':'b';input.dispatchEvent(new window.KeyboardEvent('keydown',{key,code:key==='a'?'KeyA':'KeyB',bubbles:true,cancelable:true}));input.value+=key;input.dispatchEvent(new window.Event('input'));
  input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab'}));
  modelEvents.push({type:'input',backend:'owned',data:key,bytes:1});native.push({token:'native',epoch:'page',event:{type:'input',base64:btoa(key)}});
  if(pauses===2)window.document.querySelector('button').click();
 },capability:()=>({token:'native',epoch:'page'}),gateState:state,nativeEvents:()=>native});
 assert(state.keyboardManual.wkA&&state.keyboardManual.wkB&&state.keyboardManual.nativeA&&state.keyboardManual.nativeB);assert.equal(state.keyboardManual.wkADefaultPrevented,true);assert.equal(state.keyboardManual.wkACodeMatches,true);assert.equal(state.keyboardManual.wkAModifiers,0);assert.equal(state.keyboardManual.wkReadOnly,false);assert.equal(state.keyboardManual.wkDisabled,false);assert.equal(state.keyboardManual.automaticKeys,false);assert.equal(state.keyboardManual.forcedFirstResponder,false);assert.equal(state.keyboardManual.modelInputCount,2);assert.equal(window.document.querySelector('input'),null);window.close();
});
test('manual idle waiting never polls model or native IPC and publishes at most changed bounded states',async()=>{
 const {window}=new JSDOM('<header data-termdock-window-header></header>'),events=[],modelEvents=[],state={};let ticks=0,modelReads=0,inspections=0,publications=0,records=0;
 const context=vm.createContext({window,document:window.document,Error,performance:{now:()=>ticks*250},atob,Array});vm.runInContext(source,context);
 await context.tdNativeReactKeyboardManual({model:async()=>{modelReads++;return {backend:'owned',events:modelEvents};},request:async action=>{assert.equal(action,'inspect');inspections++;return {hidden:false,focused:true};},record:()=>{records++;},publish:phase=>{publications++;if(phase==='manual-keyboard-final'||phase==='manual-keyboard-ready')window.__TD_NATIVE_MANUAL_COUNTER_INDEX=1;},until:async predicate=>assert(await predicate()),currentIndex:()=>1,pause:async()=>{
  if(++ticks!==100)return;const input=window.document.querySelector('input');input.value='ab';input.dispatchEvent(new window.Event('input'));modelEvents.push({type:'input',backend:'owned',data:'ab',bytes:2});events.push({token:'native',epoch:'page',event:{type:'input',base64:btoa('ab')}});window.document.querySelector('button').click();
 },capability:()=>({token:'native',epoch:'page'}),gateState:state,nativeEvents:()=>events});
 assert.equal(ticks,100);assert.equal(modelReads,2);assert.equal(inspections,2);assert.equal(records,2);assert.equal(publications,4);assert(state.keyboardManual.nativeA&&state.keyboardManual.nativeB);window.close();
});
test('manual entry waits for actual arm acknowledgement before inspect and reads final counters before completing',async()=>{
 const {window}=new JSDOM('<header data-termdock-window-header></header>'),modelEvents=[],native=[],state={},order=[];let index=0;
 const context=vm.createContext({window,document:window.document,Error,performance,atob,Array});vm.runInContext(source,context);
 await context.tdNativeReactKeyboardManual({model:async()=>({backend:'owned',events:modelEvents}),request:async()=>{assert(order.includes('arm-ack'));order.push('inspect');return {hidden:false,focused:true};},record:()=>{},publish:phase=>{index++;order.push(phase);},currentIndex:()=>index,until:async predicate=>{
  assert.equal(await predicate(),false);assert(!order.includes('inspect')||order.includes('arm-ack'));
  order.push(order.includes('arm-ack')?'final-ack':'arm-ack');window.__TD_NATIVE_MANUAL_COUNTER_INDEX=index;assert(await predicate());
 },pause:async()=>{
  const input=window.document.querySelector('input');input.value='ab';input.dispatchEvent(new window.Event('input'));
  modelEvents.push({type:'input',backend:'owned',data:'ab',bytes:2});native.push({token:'native',epoch:'page',event:{type:'input',base64:btoa('ab')}});window.document.querySelector('button').click();
 },capability:()=>({token:'native',epoch:'page'}),gateState:state,nativeEvents:()=>native});
 assert(order.indexOf('arm-ack')<order.indexOf('inspect'));assert.equal(order.at(-1),'final-ack');assert.equal(window.document.querySelector('input'),null);window.close();
});
test('owned overlay driver uses normal file row and separator events and waits for read and output receipts',async()=>{
 const {window}=new JSDOM('<aside data-sidebar="right" style="pointer-events:none"><button>Files</button><div id="tree"><div title="/controlled/owned.txt">owned.txt</div></div><div data-local-layer="file-preview-separator"></div><div id="preview"></div></aside>');
 const side=window.document.querySelector('aside'),tree=window.document.querySelector('#tree'),separator=window.document.querySelector('[data-local-layer]');let width=300,open=false,closing=false,closeWaits=0;const calls=[],records=[],events=[];
 const startup=window.document.createElement('div');startup.id='termdock-startup';startup.className='z-modal-panel';const pending=window.document.createElement('span');pending.dataset.startupPending='';startup.append(pending);window.document.body.append(startup);
 side.getBoundingClientRect=()=>({left:open||closing?0:window.innerWidth});
 tree.getBoundingClientRect=()=>({width});separator.getBoundingClientRect=()=>({x:400,y:10,width:8,height:400});
 window.document.querySelector('[title]').onclick=()=>{events.push({type:'controlled-file-read',encrypted:true,owned:true,realFilesystem:false});window.document.querySelector('#preview').innerHTML='<div data-file-preview-line="1">Owned file preview</div>';};
 const pointers=[];for(const type of ['pointerdown','pointermove','pointerup'])separator.addEventListener(type,event=>{pointers.push(type);if(type==='pointermove')width=264;});
 window.termdockPreviewLifecycle={snapshot:()=>({generation:open||closing?2:3,overlayReady:true,overlays:open||closing?[{}]:[],gate:{failed:false,pending:false,queued:false,frameScheduled:false,acknowledged:open||closing?2:3,resuming:false,status:open||closing?'hide-confirmed':'resume-confirmed'}})};
 const context=vm.createContext({window,document:window.document,innerWidth:window.innerWidth,getComputedStyle:window.getComputedStyle.bind(window),PointerEvent:class extends window.MouseEvent{constructor(type,options){super(type,options);Object.defineProperty(this,'pointerId',{value:options.pointerId});}},Error});vm.runInContext(source,context);
 await context.tdNativeReactOverlayCheck({request:async(action,args)=>{calls.push(action);if(action==='menu'){assert.equal(args.id,'toggle-right-sidebar');open=!open;if(!open)closing=true;side.style.pointerEvents=open?'auto':'none';}else if(action==='paste')events.push({type:'input',backend:'owned',data:args.text,bytes:args.text.length,receipt:'controlled-terminal-input-v1'});else assert.equal(action,'inspect');return {hidden:false};},model:async action=>{if(action==='output')events.push({type:'output-ack',epoch:'stream',flowSeq:3,since:3});return {backend:'owned',epoch:'stream',sequence:3,events};},record:(name,value)=>records.push(value),publish:()=>{},until:async(predicate,message)=>{if(message.includes('startup presentation')){assert.equal(await predicate(),false);assert.equal(calls.length,0);pending.remove();startup.hidden=true;assert.equal(await predicate(),true);}if(message.includes('animation did not finish')){assert.equal(await predicate(),false);closeWaits++;closing=false;}assert(await predicate(),message);},capability:()=>({token:'owned',epoch:'document'})});
 assert.deepEqual(pointers,['pointerdown','pointermove','pointerup']);assert.deepEqual(calls,['inspect','menu','inspect','menu','inspect','paste']);assert.equal(records[0].widthAfter,264);assert.equal(records[0].physicalMouseTested,false);assert.equal(records[1].continuedOutputAck,true);assert.equal(closeWaits,1);window.close();
});
test('drawer fully offscreen preserves only exact baseline alert owners with a current clip receipt',()=>{
 const {window}=new JSDOM('<p role="alert">fixed fixture alert</p><aside style="pointer-events:none"></aside>');
 const alert=window.document.querySelector('p'),side=window.document.querySelector('aside');
 alert.getBoundingClientRect=()=>({x:11,y:49,width:277,height:32.5});let closing=true;
 side.getBoundingClientRect=()=>({left:closing?500:window.innerWidth});
 const context=vm.createContext({window,document:window.document,innerWidth:window.innerWidth,getComputedStyle:window.getComputedStyle.bind(window),Error});vm.runInContext(source,context);
 const value={generation:6,overlayReady:true,moving:false,overlays:[alert.getBoundingClientRect()],gate:{failed:false,resuming:false,status:'clip-confirmed',acknowledged:6}};
 const baseline=context.tdNativeReactOverlayBaseline(value);
 assert.equal(context.tdNativeReactOverlayCloseState(side,baseline,value),false,'pointerEvents none while still onscreen is not complete');closing=false;
 assert.equal(context.tdNativeReactOverlayCloseState(side,baseline,value),true,'keep native clipped around the same independent alert');
 assert.equal(context.tdNativeReactOverlayCloseState(side,baseline,{...value,moving:true}),false);
 assert.equal(context.tdNativeReactOverlayCloseState(side,baseline,{...value,gate:{...value.gate,acknowledged:5}}),false);
 assert.equal(context.tdNativeReactOverlayCloseState(side,baseline,{...value,gate:{...value.gate,status:'resume-confirmed'}}),false);
 const replacement=alert.cloneNode(true);replacement.getBoundingClientRect=alert.getBoundingClientRect;alert.replaceWith(replacement);
 assert.equal(context.tdNativeReactOverlayCloseState(side,baseline,value),false,'a replacement alert with identical geometry is a different owner');window.close();
});
test('overlay baseline requires a unique bijection and rejects unknown overlapping candidates',()=>{
 const {window}=new JSDOM('<p role="alert"></p><p role="alert"></p>');
 const rect={x:11,y:49,width:277,height:32.5};for(const n of window.document.querySelectorAll('p'))n.getBoundingClientRect=()=>rect;
 const context=vm.createContext({window,document:window.document,Error});vm.runInContext(source,context);
 assert.throws(()=>context.tdNativeReactOverlayBaseline({overlays:[rect,{...rect,x:600}]}),/ambiguous/);
 window.document.querySelector('p').remove();assert.equal(context.tdNativeReactOverlayBaseline({overlays:[rect]}).length,1);
 assert.throws(()=>context.tdNativeReactOverlayBaseline({overlays:[rect,rect]}),/ambiguous/);
 const menu=window.document.createElement('div');menu.setAttribute('role','menu');menu.getBoundingClientRect=()=>rect;window.document.body.append(menu);
 assert.throws(()=>context.tdNativeReactOverlayBaseline({overlays:[rect]}),/ambiguous/);window.close();
});

test('startup readiness refuses pending layout and visible startup without exempting unknown overlays',()=>{
 const {window}=new JSDOM('<div id="termdock-startup" class="z-modal-panel"><span data-startup-pending></span></div>');
 const context=vm.createContext({window,document:window.document,getComputedStyle:window.getComputedStyle.bind(window),Error});vm.runInContext(source,context);
 const value={generation:2,overlayReady:true,moving:false,overlays:[],gate:{failed:false,pending:false,resuming:false,queued:false,frameScheduled:false,acknowledged:2}};
 assert.equal(context.tdNativeReactOverlayStartupSettled(value),false);
 window.document.querySelector('[data-startup-pending]').remove();assert.equal(context.tdNativeReactOverlayStartupSettled(value),false);
 window.document.getElementById('termdock-startup').hidden=true;
 for(const key of ['pending','queued','frameScheduled','resuming'])assert.equal(context.tdNativeReactOverlayStartupSettled({...value,gate:{...value.gate,[key]:true}}),false);
 assert.equal(context.tdNativeReactOverlayStartupSettled({...value,moving:true}),false);
 assert.equal(context.tdNativeReactOverlayStartupSettled(value),true);
 const unknown=window.document.createElement('div');unknown.className='z-modal-panel';unknown.getBoundingClientRect=()=>({x:0,y:0,width:10,height:10});window.document.body.append(unknown);
 assert.throws(()=>context.tdNativeReactOverlayBaseline({...value,overlays:[unknown.getBoundingClientRect()]}),/ambiguous/);window.close();
});
