// Only the visible enabled password input and its own form can be submitted.
// Invitation forms use HTML's default submit button type.
function tdNativeReactLoginForm(){
 const visible=element=>element?.isConnected&&!element.disabled&&!element.closest('[hidden],[inert]')&&element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0&&getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
 const input=[...document.querySelectorAll('input[type=password]')].find(visible);
 const form=input?.form;
 const submit=form&&[...form.querySelectorAll('button,input')].find(element=>element.form===form&&element.type==='submit'&&visible(element));
 return input&&form?{input,form,submit}:null;
}
// Private owned service-window comparison before login can mount a native view.
// Fixed counters only; no text or IME candidates leave the document.
async function tdNativeReactWKBeforeNative({publish,pause,current}){
 const box=document.createElement('section'),input=document.createElement('input'),done=document.createElement('button');
 box.dataset.ownedWkBeforeNative='true';input.setAttribute('aria-label','原生初始化前输入检查');input.placeholder='固定 a 和空格';done.type='button';done.textContent='完成原生初始化前检查';box.append(input,done);(tdNativeReactLoginForm()?.form??document.body).prepend(box);
 const seen={keyA:false,modifiers:null,defaultPrevented:null,beforeInput:0,inputEvents:0,compositionStart:0,compositionEnd:0,composing:false};let completed=false,last='',publications=0;
 input.addEventListener('keydown',event=>{if(event.code!=='KeyA')return;seen.keyA=true;seen.modifiers=(event.shiftKey?1:0)|(event.ctrlKey?2:0)|(event.altKey?4:0)|(event.metaKey?8:0);Promise.resolve().then(()=>{seen.defaultPrevented=event.defaultPrevented;});});
 input.addEventListener('beforeinput',()=>{seen.beforeInput++;});input.addEventListener('input',()=>{seen.inputEvents++;});input.addEventListener('compositionstart',()=>{seen.compositionStart++;seen.composing=true;});input.addEventListener('compositionend',()=>{seen.compositionEnd++;seen.composing=false;});done.onclick=()=>{completed=true;};
 const sample=()=>({...seen,committed:input.value.length>0&&!seen.composing,length:Math.min(input.value.length,256),readOnly:input.readOnly,disabled:input.disabled,documentHidden:document.hidden,inputFocused:document.activeElement===input,completed,automaticKeys:false,forcedFirstResponder:false,nativeInitialized:false});
 try{const end=performance.now()+300000;while(performance.now()<end){current();const value=sample(),key=JSON.stringify(value);if(key!==last){last=key;if(publications++<16)publish('service-wk-before-native',value);}
  if(completed){if(!value.committed||value.inputEvents===0)throw Error('Service WK did not commit text before native initialization');return value;}
  await pause(100);
 }throw Error('Owned service WK comparison timed out before native initialization');}finally{box.remove();}
}
function tdNativeReactSettingsClose(){
 const visible=element=>element?.isConnected&&!element.disabled&&!element.closest('[hidden],[inert]')&&element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0&&getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
 const panels=[...document.querySelectorAll('[role="dialog"][aria-labelledby="settings-dialog-title"]')].filter(visible);
 if(panels.length!==1)return null;
 const panel=panels[0],title=panel.querySelector('#settings-dialog-title'),header=title?.parentElement?.parentElement;
 const buttons=header&&[...header.children].filter(element=>element.tagName==='BUTTON'&&/^(关闭|Close)$/.test(element.getAttribute('aria-label')||'')&&element.closest('[role="dialog"]')===panel&&visible(element));
 return buttons?.length===1?{panel,button:buttons[0]}:null;
}
// Only fixed semantic identities and scalar state; never DOM text, arbitrary IDs,
// history payloads or URLs. The same overlay classes are used by the lifecycle.
function tdNativeReactOverlayEvidence(){
 const layers=['z-modal-panel','z-modal-content','z-modal-backdrop','z-drawer-panel','z-drawer-content','z-drawer-backdrop','z-popover','z-menu-panel','z-menu-content','z-menu-backdrop','z-toast','z-sidebar-backdrop'];
 const selector=['[role="dialog"]','[aria-modal="true"]','[role="menu"]','[role="tooltip"]','[role="alert"]',...layers.map(layer=>'.'+layer)].join(',');
 const items=[];let count=0;
 for(const node of document.querySelectorAll(selector)){
  if(node.dataset?.nativeRecovery)continue;
  const style=getComputedStyle(node),rect=node.getBoundingClientRect();if(style.display==='none'||node.getAttribute('aria-hidden')==='true'||!rect.width||!rect.height)continue;
  count++;if(items.length===8)continue;
  const role=node.getAttribute('role'),labelledby=node.getAttribute('aria-labelledby'),scalar=value=>Number.isFinite(value)&&Math.abs(value)<=1000000?value:null;
  const side=node.getAttribute('data-sidebar-backdrop'),opacity=style.opacity===''?NaN:Number(style.opacity);let animations=[],animationsReadable=typeof node.getAnimations==='function';try{if(animationsReadable)animations=node.getAnimations({subtree:true});}catch{animationsReadable=false;}
  items.push({source:node.closest('[aria-label="协作待处理事项"]')?'task-inbox':node.hasAttribute('data-update-restart-error')?'update-restart':node.closest('[data-sidebar="right"]')?'right-sidebar':node.getAttribute('role')==='alert'?'other-alert':'other-overlay',tag:['BUTTON','DIV','SECTION'].includes(node.tagName)?node.tagName:'other',role:['dialog','menu','tooltip','alert'].includes(role)?role:null,layers:layers.filter(layer=>node.classList.contains(layer)),labelledby:labelledby==='settings-dialog-title'?labelledby:labelledby?'other':null,settingsOwner:node.matches('[role="dialog"][aria-labelledby="settings-dialog-title"]'),hasSettingsTitle:!!node.querySelector('#settings-dialog-title'),startupRoot:node===document.getElementById('termdock-startup'),sidebarBackdrop:['left','right'].includes(side)?side:null,opacity:Number.isFinite(opacity)&&opacity>=0&&opacity<=1?opacity:null,pointerEvents:['none','auto'].includes(style.pointerEvents)?style.pointerEvents:'other',hidden:node.hidden===true,ariaHidden:node.getAttribute('aria-hidden')==='true',animationsReadable,animations:animations.slice(0,4).map(animation=>({playState:['running','paused','idle','finished'].includes(animation.playState)?animation.playState:'other',pending:animation.pending===true})),animationsTruncated:animations.length>4,visibility:['visible','hidden','collapse'].includes(style.visibility)?style.visibility:'other',geometry:{x:scalar(rect.x),y:scalar(rect.y),width:scalar(rect.width),height:scalar(rect.height)}});
 }
 const milestone=name=>window.performance?.getEntriesByName?.('termdock:startup:'+name,'mark')?.length>0;
 const startupMilestones={viewportReady:milestone('foreground-viewport-ready'),contentReady:milestone('foreground-content-ready'),presented:milestone('initial-viewport-presented')};
 const startupTerminals=[];
 for(const node of document.querySelectorAll('[data-owned-terminal-startup]')){
  if(startupTerminals.length===4)break;
  try{const value=JSON.parse(node.getAttribute('data-owned-terminal-startup'));startupTerminals.push(Object.fromEntries(['active','viewportReady','streamReady','contentReady','sizeReady'].map(key=>[key,typeof value?.[key]==='boolean'?value[key]:null])));}catch{}
 }
 const overlay=window.history.state?.__termdockOverlay;
 const panel=document.querySelector('[role="dialog"][aria-labelledby="settings-dialog-title"]'),rect=panel?.getBoundingClientRect(),style=panel&&getComputedStyle(panel);
 const markers=document.querySelectorAll('[data-startup-pending]');
 return{count,items,truncated:count>items.length,startupMilestones,startupTerminals,startupPendingMarkers:Math.min(32,markers.length),startupPendingMarkersTruncated:markers.length>32,settingsPresent:!!panel,settingsVisible:!!(panel?.isConnected&&rect.width&&rect.height&&style.display!=='none'&&style.visibility==='visible'),historyOverlay:['settings','left-sidebar','right-sidebar','right-sidebar-repo-picker','right-sidebar-file-preview','markdown-outline','markdown-image-lightbox'].includes(overlay)?overlay:null};
}
// Opt-in DOM driver over the ordinary signed workspace bundle. No React or
// terminal implementation is imported/replaced; native events are real IPC.
(async()=>{
 const nonce=window.__TD_NATIVE_GATE_NONCE,pageEpoch=window.__TD_NATIVE_GATE_EPOCH;
 const prior=window.__TD_NATIVE_GATE_STATE;
 if(window.__TD_NATIVE_GATE_RUNNING){
  if(prior?.pageEpoch!==pageEpoch){prior.cancelled=true;tdNativeGateSignal(nonce,'result',{ok:false,pageEpoch,progressIndex:0,steps:prior.steps,acks:prior.acks,stages:prior.stages,error:'Existing React driver crossed page epoch; unknown pending result; no retry'});}
  return;
 }
 window.__TD_NATIVE_GATE_RUNNING=true;
 const state=window.__TD_NATIVE_GATE_STATE={pageEpoch,steps:[],acks:[],stages:[],lastAction:null,finished:false,cancelled:false};
 const {steps,acks,stages}=state;let index=0,dropped=0,cap=null,events=[],unsubscribe,stopCloseObservation,settingsClose=null,presentationPending=[];
 const assert=(value,error)=>{if(!value)throw Error(error);};
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const current=()=>{assert(!state.cancelled,'Old page driver cancelled');};
 const publish=(phase,detail)=>{
  current();if(detail)state.lastAction=detail;if(stages.length===128){stages.shift();dropped++;}
  stages.push({pageEpoch,index:++index,phase,detail});
  tdNativeGateSignal(nonce,'progress',{pageEpoch,progressIndex:index,phase,lastAction:state.lastAction,steps,acks,stages,stageDropped:dropped});
 };
 const until=async(test,error)=>{const end=performance.now()+12000;while(!(await test())){current();assert(performance.now()<end,error);await pause(25);}};
 const record=(name,value)=>{assert(steps.length<64,'React step evidence bound exceeded');steps.push({name,value});publish('step-complete');};
 const lifecycleState=()=>{
  const value=window.termdockPreviewLifecycle?.snapshot();if(!value)return null;
  return{overlayReady:value.overlayReady,moving:value.moving,hidden:value.hidden,focused:value.focused,generation:value.generation,overlays:value.overlays.length,gate:value.gate?{status:value.gate.status,pending:value.gate.pending,resuming:value.gate.resuming,queued:value.gate.queued,frameScheduled:value.gate.frameScheduled,acknowledged:value.gate.acknowledged,nativePanels:value.gate.nativePanels,failed:value.gate.failed}:null};
 };
 const marker='termdock-react-gate-reload';
 try{
  const interrupted=window.__TD_NATIVE_GATE_INTERRUPTED;delete window.__TD_NATIVE_GATE_INTERRUPTED;
  const handoff=window.__TD_NATIVE_GATE_AUTH_HANDOFF;delete window.__TD_NATIVE_GATE_AUTH_HANDOFF;
  if(interrupted){
   const selected=JSON.parse(sessionStorage.getItem('termdock-secure-target-v1')||'null');
   assert(handoff&&handoff.nonce===nonce&&handoff.oldEpoch===interrupted.pageEpoch&&handoff.oldEpoch!==pageEpoch&&handoff.previous.phase==='normal-login-form-submit-ready'&&handoff.previous.steps.length===0&&handoff.previous.acks.length===0&&selected?.targetPeerId===handoff.targetPeerId&&selected?.url===handoff.url,'Unexpected page epoch interrupted React driver; no retry');
   steps.push(...handoff.previous.steps);acks.push(...handoff.previous.acks);stages.push(...handoff.previous.stages);dropped=handoff.previous.stageDropped??0;
  }
  const reload=JSON.parse(sessionStorage.getItem(marker)||'null');
  if(reload){assert(reload.steps.length<=64&&reload.acks.length<=128&&reload.stages.length<=128,'Reload evidence bound exceeded');steps.push(...reload.steps);acks.push(...reload.acks);stages.push(...reload.stages);dropped=reload.stageDropped;}
  publish('react-driver-entered',{workerControlled:!!navigator.serviceWorker?.controller,reload:!!reload,authorizationHandoff:handoff?{oldEpoch:handoff.oldEpoch,newEpoch:pageEpoch,targetPeerId:handoff.targetPeerId}:null});
  const benchmarkRenderer=window.__TD_PREVIEW_BENCH_RENDERER;
  const benchmarking=benchmarkRenderer==='browser'||benchmarkRenderer==='native';
  await until(()=>window.termdockDesktop?.nativeTerminal,'Actual terminal bridge unavailable');
  const native=window.termdockDesktop.nativeTerminal;
  assert(native.available===(!benchmarking||benchmarkRenderer==='native'),'Renderer capability does not match the owned comparison');
  unsubscribe=native.available?native.subscribe(payload=>{
   if(state.cancelled)return;assert(events.length<4096,'React native events bound exceeded');events.push(payload);
   if(payload.epoch!==pageEpoch)return;
   if(['ready','ack','resize'].includes(payload.event.type))cap={token:payload.token,epoch:payload.epoch};
   if(payload.event.type==='ack'&&!benchmarking){
    assert(acks.length<128,'Actual React ACK bound exceeded');acks.push({step:state.lastAction?.action??'component output',token:payload.token,epoch:payload.epoch,sequence:payload.event.sequence,event:{...payload.event}});publish('actual-component-consumption-ack');
   }
  }):undefined;
  const request=tdNativeGateRequester(native,()=>cap?.token,pause,(phase,detail)=>publish(phase,{action:detail.action,attempt:detail.attempt,token:detail.token,sequence:detail.sequence,error:detail.error}));
  const model=async action=>{
   if(!benchmarking)publish('encrypted-model-request',{action:action??'inspect'});
   const response=await Promise.race([window.fetch('/api/terminal/test-health',action?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(typeof action==='string'?{action}:action)}:{}),pause(12000).then(()=>{throw Error('Encrypted fixture request timed out; no retry');})]);
   assert(response.ok,'Controlled encrypted fixture unavailable');const data=await response.json();assert(data.fixture==='actual-old-router-react-terminal-model-v1','Incorrect fixture response');return data;
  };
  const viewport=()=>document.querySelector('[data-termdock-terminal-dropzone].terminal-viewport-container');
  const inspect=()=>request('inspect');
  const copy=async()=>{const original={...cap},start=events.length;await request('copy',{selection:false},original.token);const matches=e=>e.token===original.token&&e.epoch===original.epoch&&e.event.type==='selection';await until(()=>events.slice(start).some(matches),'Actual component viewport text missing');return events.slice(start).find(matches).event.text;};
  const flow=async()=>{
   let observed;await until(async()=>{observed=await model();return observed.events.some(e=>e.type==='output-ack'&&e.since===observed.sequence&&e.flowSeq===observed.sequence&&e.epoch===observed.epoch);},'Component did not confirm the current stream cursor');return observed;
  };
  if(!reload&&!handoff){
   await until(()=>document.querySelector('input[type=password]')||[...document.querySelectorAll('button')].some(button=>button.textContent==='接受邀请'),'Normal authorization UI absent');
   const invitation=[...document.querySelectorAll('button')].find(button=>button.textContent==='接受邀请');if(invitation){invitation.click();publish('normal-invitation-button-clicked');}
   await until(()=>tdNativeReactLoginForm(),'Normal visible enabled password form absent');
   if(window.__TD_NATIVE_GATE_SERVICE_WK_BEFORE_NATIVE===true){assert(!cap&&!viewport()&&acks.length===0,'Pre-native service comparison already has a native receiver');await tdNativeReactWKBeforeNative({publish,pause,current});}
   const login=tdNativeReactLoginForm(),input=login.input;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'preview-bundle-test-password');input.dispatchEvent(new Event('input',{bubbles:true}));
   await until(()=>{const current=tdNativeReactLoginForm();return current?.input===input&&current.form===login.form&&current.submit;},'Normal form did not accept its controlled password');publish('normal-login-form-submit-ready');await until(()=>window.__TD_NATIVE_GATE_STAGE_RECEIPT?.nonce===nonce&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.pageEpoch===pageEpoch&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.index===index,'Normal login submit receipt absent');assert(tdNativeReactLoginForm()?.form===login.form,'Normal password form replaced before submit');login.form.requestSubmit(tdNativeReactLoginForm().submit);
  }
  await until(()=>viewport()&&(benchmarkRenderer==='browser'?document.querySelector('.xterm'):cap),'Production terminal renderer did not mount');
  if(benchmarking){
   let data=await flow();
   assert(!document.hidden,'Visible renderer comparison cannot run in a hidden document');
   await until(()=>{
    const startup=document.getElementById('termdock-startup');
    return (!startup||startup.hidden||getComputedStyle(startup).display==='none')&&!document.querySelector('[data-startup-pending]');
   },'Renderer comparison startup did not finish');
   if(benchmarkRenderer==='native')await until(async()=>!(await inspect()).hidden,'Native renderer is hidden');
   assert(benchmarkRenderer==='browser'?!!document.querySelector('.xterm'):!document.querySelector('.xterm'),'Unexpected second renderer');
   const attachment=benchmarkRenderer==='native'?await inspect():null;
   if(attachment)assert(attachment.sibling&&attachment.mainThread&&attachment.surfaces===1,'Native comparison attachment invalid');
   const geometry=viewport().getBoundingClientRect();assert(geometry.width>0&&geometry.height>0,'Renderer viewport has no area');
   if(benchmarkRenderer==='browser')await until(()=>viewport().dataset.ownedRendererMetrics,'Actual xterm options were not observed');
   const rendererOptions=benchmarkRenderer==='browser'?JSON.parse(viewport().dataset.ownedRendererMetrics):{renderer:'native',fontFamily:attachment.metrics.font.family,fontSize:attachment.metrics.cssFontSize,history:attachment.metrics.history};
   if(benchmarkRenderer==='browser')assert(!state.finished&&!state.cancelled&&rendererOptions.nonce===nonce&&rendererOptions.epoch===pageEpoch,'Xterm measurement belongs to a stale owned page');
   assert(rendererOptions.fontSize===13&&rendererOptions.history===1000,'Renderer font size or scrollback differs from the controlled workload');
   const grid=data.events.filter(event=>event.type==='resize').at(-1);
   assert(grid&&grid.cols>0&&grid.rows>0,'Actual renderer grid was not confirmed');
   record('owned renderer comparison ready',{renderer:benchmarkRenderer,visible:true,dpr:devicePixelRatio,viewport:{width:geometry.width,height:geometry.height},rendererOptions,grid:{cols:grid.cols,rows:grid.rows},windowCount:null,sessions:data.inventory?.clientSessions?.length,attachment,noPTY:true,physicalInputTested:false});
   let hiddenDuringRun=false;const visibilityChanged=()=>{if(document.hidden)hiddenDuringRun=true;};
   document.addEventListener('visibilitychange',visibilityChanged);
   try{for(const profile of ['idle','steady','burst']){
    const runId=`${benchmarkRenderer}-${profile}`;
    const startTimeMs=performance.now();
    publish('benchmark-phase-start',{renderer:benchmarkRenderer,profile,runId,startTimeMs});
    await model({action:'benchmark-output',profile,runId});
    const start=startTimeMs;
    // This is the measured idle interval, not a readiness workaround: no
    // business probes run while the fixture's independent idle timer elapses.
    if(profile==='idle')await pause(10000);
    while(true){
     current();assert(!hiddenDuringRun&&!document.hidden,'Renderer comparison became hidden');
     assert(performance.now()-start<120000,'Renderer comparison phase timed out');
     data=await model();
     if(data.benchmark?.runId===runId&&data.benchmark.done){
      const b=data.benchmark;
      assert(b.epoch===data.epoch&&b.lastSeq===data.sequence&&b.bytes===b.expectedBytes&&b.chunks===b.expectedChunks,'Benchmark output changed epoch or did not complete its exact workload');
      if(data.events.some(e=>e.type==='output-ack'&&e.since===b.lastSeq&&e.flowSeq===b.lastSeq&&e.epoch===b.epoch))break;
     }
     await pause(250);
    }
    const endTimeMs=performance.now();
    record('owned renderer comparison phase complete',{renderer:benchmarkRenderer,profile,startTimeMs,endTimeMs,elapsedMs:endTimeMs-start,benchmark:data.benchmark,streamCursor:{epoch:data.epoch,sequence:data.sequence},visible:!document.hidden});
   }}finally{document.removeEventListener('visibilitychange',visibilityChanged);}
   state.finished=true;tdNativeGateSignal(nonce,'result',{ok:true,pageEpoch,progressIndex:index,steps,acks,stages,benchmarkRenderer,noPTY:true,actualReactBundle:true,physicalInputTested:false});unsubscribe?.();return;
  }
  let data=await flow();const attachment=await inspect();assert(attachment.sibling&&attachment.mainThread&&attachment.surfaces===1,'Actual component native attachment invalid');assert(!document.querySelector('.xterm'),'Second xterm renderer mounted');
  record('normal signed bundle TerminalView to NativeViewport with real consumed stream cursor',{attachment,viewportKey:viewport().dataset.termdockTerminalDropzone,streamAck:data.events.filter(e=>e.type==='output-ack').at(-1),nativeAckCount:acks.length,workerControlled:!!navigator.serviceWorker?.controller});
  if(data.interactions){
   if(data.nativeOverlay){const titlebar=await tdNativeGateTitlebarDoubleClick(window,document,()=>cap);record(`actual owned-header titlebar ${titlebar.action}`,{...titlebar,syntheticDomEvents:true,physicalDoubleClickTested:false,visualTested:false});await tdNativeReactOverlayCheck({request,model,record,publish,until,capability:()=>cap});}
   else if(data.nativeKeyboardManual){state.inputObservation=true;await tdNativeReactKeyboardManual({request,model,record,publish,pause,until,currentIndex:()=>index,capability:()=>cap,gateState:state,nativeEvents:()=>events});}
   else if(data.nativeKeyboard){state.inputObservation=true;await tdNativeReactKeyboardGate({request,model,record,publish,until,pause,capability:()=>cap,gateState:state,currentIndex:()=>index,nativeEvents:()=>events});}
   else if(data.nativeInput){state.inputObservation=true;await tdNativeReactInputGate({request,model,record,publish,until,capability:()=>cap,gateState:state});}
   else if(data.nativeFeedback)await tdNativeReactFeedbackGate({request,model,record,publish,until});
   else await tdNativeReactInteractionGate({request,model,record,publish,until,pause,nonce,pageEpoch,currentIndex:()=>index});
   state.finished=true;tdNativeGateSignal(nonce,'result',{ok:true,pageEpoch,progressIndex:index,steps,acks,stages,stageDropped:dropped,keyboardManual:state.keyboardManual,keyboardManualDropped:state.keyboardManualDropped??0,keyboardContextFields:state.keyboardContextFields,keyboardComparison:state.keyboardComparison,keyboardCases:state.keyboardCases??null,inputDiagnostics:state.inputDiagnostics??null,inputDiagnosticsDropped:state.inputDiagnosticsDropped??0,actualWK:true,actualReactBundle:true,interactionsOnly:true,noPTY:true,noClipboard:true,realFilesystem:false,realOsUpdaterCalled:false,pending:['physical keys/IME/visible glyphs/system clipboard/OS update','context changes and CSRF guards independently covered by component/API regressions']});unsubscribe?.();return;
  }
  if(data.userFixes){
   const menu=window.__TD_NATIVE_GATE_SERVICE_MENU;assert(menu?.pageEpoch===pageEpoch&&menu.matched,'Actual native service menu did not match its identity grouping');record('actual native service menu identity grouping preserves stored aliases',menu);
   // Actual numerical scale/coordinate checks, separate from visible GUI parity.
   // The model's restart endpoint has no restart/install implementation.
   const measure=async phase=>{
    const value=await inspect(),m=value.metrics;assert(m?.live&&m.created&&m.firstRect,'Actual native geometry unavailable');
    const header=document.querySelector('[data-session-sidebar-header]'),rect=header?.getBoundingClientRect();
    const ctx=document.createElement('canvas').getContext('2d');ctx.font=`${m.cssFontSize}px "Termdock Mono", monospace`;const glyph=ctx.measureText('M');
    const headerCenter=rect?(rect.top+rect.height/2)*m.hostZoom:null;
    record('actual geometry measured '+phase,{phase,pageEpoch,token:cap.token,timeMs:performance.now(),documentHidden:document.hidden,dpr:devicePixelRatio,visualViewportScale:visualViewport?.scale??null,viewportCSS:{width:innerWidth,height:innerHeight},headerCSS:rect?{top:rect.top,height:rect.height,center:rect.top+rect.height/2}:null,headerCenterWKPoints:headerCenter,buttonCenterDeltaPoints:m.window.buttons.map(button=>button.present&&headerCenter!==null?button.wkPoints.centerTop-headerCenter:null),cssCanvas:{family:'Termdock Mono, monospace',fontSize:m.cssFontSize,width:glyph.width,fontBoxAscent:glyph.fontBoundingBoxAscent??null,fontBoxDescent:glyph.fontBoundingBoxDescent??null,fontsStatus:document.fonts.status,kind:'CSS canvas reference, not an xterm renderer'},metrics:m,attachment:{hidden:value.hidden,focused:value.focused,sibling:value.sibling},open:data.events.filter(e=>e.type==='terminal-open').at(-1)});
    // Preserve the earliest real sample before checking it; never wait away a
    // mismatch. Cached create/firstRect retain their actual living-surface scope.
    for(const [kind,sample] of Object.entries({created:m.created,firstRect:m.firstRect,live:m.live})){
     assert(sample.requestedBackingScale===sample.windowBackingScale,phase+' '+kind+' requested/window scale mismatch');
     assert(sample.layerContentsScale===sample.requestedBackingScale,phase+' '+kind+' layer scale mismatch');
     for(const dimension of ['width','height'])assert(Math.abs(sample.enginePixels[dimension]-sample.layerPoints[dimension]*sample.layerContentsScale)<=1&&Math.abs(sample.enginePixels[dimension]-sample.viewPoints[dimension]*sample.requestedBackingScale)<=1,phase+' '+kind+' physical geometry mismatch');
    }
    if(!m.window.fullscreen&&headerCenter!==null)for(const button of m.window.buttons)if(button.present)assert(Math.abs(button.wkPoints.centerTop-headerCenter)<=0.5,phase+' traffic-light/header center mismatch');
   };
   await measure(reload?'first-consumed-after-WK-reload':'first-consumed');
   await Promise.race([document.fonts.ready,pause(12000).then(()=>{throw Error('Owned page font loading deadline');})]);
   await measure(reload?'fonts-ready-after-WK-reload':'fonts-ready');
   if(!reload){
    const returned=window.confirm('Controlled Preview confirmation probe; no service operation');
    record('actual legacy WK confirm return with no business action',{returned});
    window.dispatchEvent(new CustomEvent('termdock:open-settings'));
    await until(()=>document.querySelector('[aria-labelledby="settings-dialog-title"] input[type=range][min="8"][max="32"]'),'Normal font size control absent');
    const fontRange=document.querySelector('[aria-labelledby="settings-dialog-title"] input[type=range][min="8"][max="32"]'),originalFont=Number(fontRange.value),fontControls=fontRange.parentElement.querySelectorAll('button');
    assert(originalFont<32&&fontControls.length===2,'Controlled default font fixture changed');
    fontControls[1].click();await until(async()=>(await inspect()).metrics.cssFontSize===originalFont+1,'Normal font increase did not reach native receiver');await measure('normal-font-increase');
    fontControls[0].click();await until(async()=>(await inspect()).metrics.cssFontSize===originalFont,'Normal font restore did not reach native receiver');await measure('normal-font-restored');
    const updateButton=()=>[...document.querySelectorAll('[role="dialog"][aria-labelledby="settings-dialog-title"] button')].find(button=>!button.disabled&&/^(重启并完成更新|Restart and finish update)$/.test(button.textContent.trim()));
    await until(()=>updateButton(),'Normal settings update button absent');
    const dialog=()=>document.querySelector('[data-desktop-confirmation="true"]');
    const open=async()=>{const button=updateButton();assert(button,'Normal update button unavailable');button.click();button.click();await until(()=>dialog(),'Ordinary Preview confirmation DOM absent');await until(()=>lifecycleState()?.overlayReady,'Confirmation native hide receipt absent');return dialog();};
    const buttons=panel=>{const items=[...panel.querySelectorAll('button')];assert(items.length===2,'Confirmation controls missing');return items;};
    let panel=await open();let controls=buttons(panel);const style=getComputedStyle(panel),bounds=panel.getBoundingClientRect(),settings=document.querySelector('[aria-labelledby="settings-dialog-title"]');
    assert(style.position==='fixed'&&bounds.width>0&&bounds.height>0&&Number(style.zIndex)>Number(getComputedStyle(settings).zIndex),'Production confirmation CSS missing or below settings');
    record('ordinary confirmation DOM and native hide receipt',{zIndex:style.zIndex,width:bounds.width,height:bounds.height,controlCount:controls.length,overlayReady:lifecycleState().overlayReady,documentHidden:document.hidden});
    controls[0].click();await until(()=>!dialog(),'Cancel did not remove confirmation');data=await model();assert(!data.events.some(e=>e.type==='controlled-restart-request'),'Cancel sent a restart request');record('normal update cancel sends no request',{requests:0});
    panel=await open();controls=buttons(panel);controls[1].click();controls[1].click();
    await until(()=>document.querySelector('[data-update-restart-error]')?.textContent.includes('Controlled restart failure'),'Normal update failure feedback absent');data=await model();let requests=data.events.filter(e=>e.type==='controlled-restart-request');assert(requests.length===1&&requests[0].encrypted&&requests[0].csrfOmitted,'Confirm did not issue exactly one authorized page request');
    record('normal update confirm issues one encrypted fixture request and shows failure',{requests,feedbackPresent:true,csrfObservation:'page adapter provides local channel token; API guards/header covered separately, no server GET required'});
    await model('allow-controlled-update');panel=await open();buttons(panel)[1].click();await until(async()=>{data=await model();return data.events.filter(e=>e.type==='controlled-restart-request').length===2;},'Second explicit confirmation did not reach owned model');
    assert(data.events.filter(e=>e.type==='controlled-restart-request').at(-1).allowed,'Owned success model not enabled');await until(()=>document.querySelector('[aria-labelledby="settings-dialog-title"]')?.textContent.includes('正在重启，网页将自动重连…')||document.querySelector('[aria-labelledby="settings-dialog-title"]')?.textContent.includes('Restarting; this page will reconnect automatically…'),'Normal update state did not apply the inert success response');
    record('second explicit confirmation succeeds against inert restart model',{requests:data.events.filter(e=>e.type==='controlled-restart-request'),realRestart:false});
    const close=tdNativeReactSettingsClose();assert(close,'Owned settings close absent');close.button.click();await until(()=>!close.panel.isConnected,'Owned settings did not close');
    await measure('after-normal-confirmation-layout');
    publish('reload-requested');await until(()=>window.__TD_NATIVE_GATE_STAGE_RECEIPT?.nonce===nonce&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.pageEpoch===pageEpoch&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.index===index,'Baseline reload receipt absent');
    sessionStorage.setItem(marker,JSON.stringify({pageEpoch,steps,acks,stages,stageDropped:dropped,userFixes:true,token:cap.token}));location.reload();return;
   }
   assert(reload.userFixes&&reload.pageEpoch!==pageEpoch,'Actual baseline WK reload identity missing');sessionStorage.removeItem(marker);
   record('actual baseline reload identity',{oldEpoch:reload.pageEpoch,newEpoch:pageEpoch,oldToken:reload.token,newToken:cap.token,open:data.events.filter(e=>e.type==='terminal-open').at(-1)});
   state.finished=true;tdNativeGateSignal(nonce,'result',{ok:true,pageEpoch,progressIndex:index,steps,acks,stages,stageDropped:dropped,keyboardManual:state.keyboardManual,keyboardManualDropped:state.keyboardManualDropped??0,keyboardContextFields:state.keyboardContextFields,keyboardComparison:state.keyboardComparison,keyboardCases:state.keyboardCases??null,inputDiagnostics:state.inputDiagnostics??null,inputDiagnosticsDropped:state.inputDiagnosticsDropped??0,actualWK:true,actualReactBundle:true,noPTY:true,noClipboard:true,scope:'update confirmation and numerical layer/traffic-light correction',pending:['visible glyph/GUI parity, physical keys/IME/clipboard','actual non-Retina/backing transition and fullscreen/zoom/OS window resize','runtime service-target change; guarded by affected component/API tests']});unsubscribe?.();return;
  }
  if(reload){
   assert(pageEpoch!==reload.pageEpoch,'Real WK reload did not change epoch');
   assert(data.events.filter(e=>e.type==='terminal-open').at(-1).since>0,'Reload did not retain the confirmed native baseline');
   assert((await copy()).includes('controlled backend B baseline'),'Actual React reload lost visible terminal state');sessionStorage.removeItem(marker);
   record('actual WK reload through the normal React bundle preserves confirmed baseline and VT',{oldEpoch:reload.pageEpoch,newEpoch:pageEpoch,open:data.events.filter(e=>e.type==='terminal-open').at(-1)});
   const before=cap.token;await model('exit');await until(async()=>(await copy()).includes('Process exited'),'Backend exit final text absent');assert(cap.token===before,'Backend exit destroyed the viewable receiver');record('normal backend exit preserves final VT and error text',{token:before,processExited:true});
   if(![...document.querySelectorAll('button.sidebar-session-primary')].some(button=>button.textContent.includes('Controlled React')&&button.getBoundingClientRect().width>0))window.dispatchEvent(new CustomEvent('termdock:native-command',{detail:'toggle-left-sidebar'}));
   await until(()=>[...document.querySelectorAll('button[aria-label]')].some(button=>/关闭|Close/.test(button.getAttribute('aria-label'))&&button.getAttribute('aria-label').includes('Controlled React')),'Normal session close button absent');
   [...document.querySelectorAll('button[aria-label]')].find(button=>/关闭|Close/.test(button.getAttribute('aria-label'))&&button.getAttribute('aria-label').includes('Controlled React')).click();
   await until(async()=>{data=await model();return data.events.some(e=>e.type==='user-inventory-delete');},'Normal user close did not reach encrypted inventory');
   let stale=false;await until(async()=>{try{await request('inspect',{},before);}catch(error){tdNativeGateExpectedRejection(error);stale=true;}return stale;},'User close retained the old native capability');record('normal DOM user close retires its actual capability',{previousToken:before,deleted:true});
   if(!viewport()){window.dispatchEvent(new CustomEvent('termdock:native-command',{detail:'new-session'}));}
   await until(()=>viewport()&&cap.token!==before,'Normal new session did not mount');await flow();assert((await inspect()).surfaces===1,'Normal close/create leaked a native receiver');
   const inventoryToken=cap.token;await model('inventory-delete');
   await until(async()=>{try{await request('inspect',{},inventoryToken);return false;}catch(error){tdNativeGateExpectedRejection(error);return true;}},'External inventory deletion retained the receiver');record('accepted external inventory deletion retires actual receiver',{previousToken:inventoryToken});
   state.finished=true;tdNativeGateSignal(nonce,'result',{ok:true,pageEpoch,progressIndex:index,steps,acks,stages,stageDropped:dropped,keyboardManual:state.keyboardManual,keyboardManualDropped:state.keyboardManualDropped??0,keyboardContextFields:state.keyboardContextFields,keyboardComparison:state.keyboardComparison,keyboardCases:state.keyboardCases??null,inputDiagnostics:state.inputDiagnostics??null,inputDiagnosticsDropped:state.inputDiagnosticsDropped??0,actualWK:true,actualReactBundle:true,noPTY:true,noClipboard:true,pending:['search editable native entry','real keys/IME/visual/clipboard/notifications/performance','durable damaged cache/fresh renderer after process restart','ordinary real shell/tmux']});unsubscribe?.();return;
  }
  assert((await copy()).includes('controlled React baseline 中'),'Encrypted output did not reach native VT');
  await pause(300);await request('paste',{text:'controlled-ui-input'});await until(async()=>{data=await model();return data.events.some(e=>e.type==='input'&&e.data==='controlled-ui-input');},'Actual native Input did not reach normal encrypted stream');await flow();record('actual native input callback traverses TerminalView encrypted stream',{input:data.events.find(e=>e.type==='input'&&e.data==='controlled-ui-input')});
  const opens=data.events.filter(e=>e.type==='terminal-open').length;await model('disconnect');await until(async()=>{data=await model();return data.events.filter(e=>e.type==='terminal-open').length>opens;},'Controlled stream did not reconnect');await flow();const text=await copy();assert(text.split('controlled disconnected suffix').length===2,'Reconnect suffix duplicated or absent');assert(text.split('controlled React baseline').length===2,'Reconnect replay duplicated baseline');record('same backend normal stream reconnect has no duplicate/gap',{open:data.events.filter(e=>e.type==='terminal-open').at(-1),streamAck:data.events.filter(e=>e.type==='output-ack').at(-1)});
  publish('normal-settings-open-intent',{action:'settings-overlay',dom:tdNativeReactOverlayEvidence()});window.dispatchEvent(new CustomEvent('termdock:open-settings'));
  await until(()=>window.termdockPreviewLifecycle.snapshot().overlays.length>0,'Normal settings overlay absent');let previousGate='',gateReports=0;
  await until(()=>{const value=lifecycleState(),encoded=JSON.stringify(value);if(encoded!==previousGate&&gateReports<16){previousGate=encoded;gateReports++;publish('normal-overlay-gate-observed',{action:'settings-overlay',lifecycle:value});}return value?.overlayReady&&!value.moving;},'Normal overlay hide receipt did not settle');
  await until(async()=>!(await inspect()).focused,'Normal overlay left native as first responder');record('normal DOM settings overlay releases native focus',{overlayReady:window.termdockPreviewLifecycle.snapshot().overlayReady,nativeFocused:false});
  // The real Settings drawer owns the close control, not a driver hide command.
  await until(()=>tdNativeReactSettingsClose(),'Normal settings owned close control absent');const close=tdNativeReactSettingsClose();assert(close?.panel.isConnected&&close.button.isConnected,'Normal settings close control replaced');
  settingsClose={owner:'settings-dialog-title',buttonTag:close.button.tagName,buttonType:close.button.type,ariaLabel:close.button.getAttribute('aria-label'),enabled:!close.button.disabled,clickInvoked:false,popStates:0};const pop=()=>{settingsClose.popStates=Math.min(16,settingsClose.popStates+1);};window.addEventListener('popstate',pop);stopCloseObservation=()=>window.removeEventListener('popstate',pop);
  publish('normal-settings-close-intent',{action:'settings-close',control:{...settingsClose},dom:tdNativeReactOverlayEvidence(),lifecycle:lifecycleState()});settingsClose.clickInvoked=true;close.button.click();publish('normal-settings-close-click-returned',{action:'settings-close',control:{...settingsClose},dom:tdNativeReactOverlayEvidence(),lifecycle:lifecycleState()});
  let previousClose='',closeReports=0;await until(()=>{const value={dom:tdNativeReactOverlayEvidence(),control:{...settingsClose},lifecycle:lifecycleState()},encoded=JSON.stringify(value);if(encoded!==previousClose&&closeReports<16){previousClose=encoded;closeReports++;publish('normal-settings-close-observed',{action:'settings-close',...value});}return !close.panel.isConnected&&!value.dom.settingsPresent;},'Normal settings dialog did not leave the DOM');stopCloseObservation();stopCloseObservation=null;
  record('normal settings header closes its own DOM dialog',{control:{...settingsClose},dom:tdNativeReactOverlayEvidence()});
  const afterSettings=lifecycleState();publish('normal-global-layers-after-settings-close',{action:'global-layers',lifecycle:afterSettings,dom:tdNativeReactOverlayEvidence()});
  if(afterSettings?.hidden){presentationPending=['visible document and presentation frames','global overlay release and actual native visibility','subsequent DOM focus/visible workspace gates'];throw Error('Visible presentation unavailable: document is hidden; global layers and native visibility remain unverified');}
  await until(()=>window.termdockPreviewLifecycle.snapshot().overlays.length===0,'Global overlays remain after settings closed');
  await until(async()=>!(await inspect()).hidden,'Component did not resume native visibility');record('normal overlay close restores actual native visibility',await inspect());
  // Existing session menu -> rename dialog supplies a normal DOM text input;
  // the settings drawer itself has range/toggle controls, not a text field.
  const row=()=>[...document.querySelectorAll('button.sidebar-session-primary')].find(button=>button.textContent.includes('Controlled React')&&button.getBoundingClientRect().width>0);
  if(!row())window.dispatchEvent(new CustomEvent('termdock:native-command',{detail:'toggle-left-sidebar'}));
  await until(()=>row(),'Normal controlled session row absent');const bounds=row().getBoundingClientRect();row().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:bounds.x+20,clientY:bounds.y+10}));
  const rename=()=>[...document.querySelectorAll('.z-menu-panel button')].find(button=>/重命名|Rename/i.test(button.textContent));await until(()=>rename(),'Normal session rename menu absent');rename().click();
  await until(()=>document.querySelector('[role=dialog] input[type=text]'),'Normal rename editable absent');const editable=document.querySelector('[role=dialog] input[type=text]');editable.focus();
  await until(async()=>!(await inspect()).focused,'DOM editable left native as first responder');record('normal session rename editable releases actual native first responder',{editableTag:editable.tagName,nativeFocused:false});
  const cancel=[...editable.closest('[role=dialog]').querySelectorAll('button')].find(button=>/取消|Cancel/i.test(button.textContent));assert(cancel,'Normal rename cancel control absent');cancel.click();
  await until(async()=>!(await inspect()).hidden,'Normal rename dismissal did not resume native visibility');
  await model('epoch');await flow();assert((await copy()).includes('controlled new epoch baseline'),'Stream epoch authoritative baseline absent');record('normal component stream epoch replacement',{streamAck:(await model()).events.filter(e=>e.type==='output-ack').at(-1)});
  await model('backend');await until(async()=>{data=await model();return data.events.some(e=>e.type==='terminal-open'&&e.backend==='controlled-react-backend-b');},'Normal inventory did not bind new backend identity');await flow();const changed=await copy();assert(changed.includes('controlled backend B baseline')&&!changed.includes('controlled React baseline'),'Old backend output leaked into replacement surface');record('same frontend normal inventory backend identity isolates output',{backend:data.backend,token:cap.token});
  publish('reload-requested');await until(()=>window.__TD_NATIVE_GATE_STAGE_RECEIPT?.nonce===nonce&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.pageEpoch===pageEpoch&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.index===index,'React reload receipt absent');
  sessionStorage.setItem(marker,JSON.stringify({pageEpoch,steps,acks,stages,stageDropped:dropped}));location.reload();
 }catch(error){stopCloseObservation?.();if(state.cancelled)return;state.finished=true;tdNativeGateSignal(nonce,'result',{ok:false,pageEpoch,progressIndex:index,steps,acks,stages,stageDropped:dropped,keyboardManual:state.keyboardManual,keyboardManualDropped:state.keyboardManualDropped??0,keyboardContextFields:state.keyboardContextFields,keyboardComparison:state.keyboardComparison,keyboardCases:state.keyboardCases??null,inputDiagnostics:state.inputDiagnostics??null,inputDiagnosticsDropped:state.inputDiagnosticsDropped??0,lastAction:state.lastAction,lifecycle:lifecycleState(),settingsDOM:tdNativeReactOverlayEvidence(),settingsClose,pending:presentationPending,error:String(error)});unsubscribe?.();}
})();
