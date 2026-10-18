// Invoked only after the ordinary product login and component stream ACK.
// Normal App/FileTree handlers remain mounted; all FS/update receivers are inert.
async function tdNativeReactInteractionClick(root,expression,until,message,observe,readiness) {
 const action=()=>[...root.querySelectorAll('button')].find(node=>expression.test(node.textContent.trim())&&!node.disabled&&node.isConnected);
 await until(()=>{const nodes=[...root.querySelectorAll('button')].filter(node=>expression.test(node.textContent.trim()));observe?.({matching:Math.min(nodes.length,8),disabled:Math.min(nodes.filter(node=>node.disabled).length,8),connected:Math.min(nodes.filter(node=>node.isConnected).length,8)});return action();},message);
 const state=readiness?await readiness():null;observe?.({status:state?.status??null,installCalls:state?.controlledInstallCalls??null});
 const enabled=action();if(!enabled||state&&state.status!=='ready')throw Error(message);enabled.click();
}
function tdNativeReactInteractionFeedback(message) {
 const alert=document.querySelector('[data-preview-feedback][role="alert"]');
 return alert&&alert.textContent.includes(message)?alert:null;
}
function tdNativeReactInteractionServiceCheck(settings) {
 const title=settings.querySelector('#termdock-update-title');
 const runtimeRow=title?.nextElementSibling;
 if(!runtimeRow||title.parentElement?.getAttribute('aria-labelledby')!=='termdock-update-title')return null;
 return [...runtimeRow.querySelectorAll('button')].find(node=>/^(检查更新|再次检查|重试更新|重新尝试|Check for updates|Check again|Retry update|Try again)$/.test(node.textContent.trim())&&!node.disabled&&node.isConnected)??null;
}
async function tdNativeReactInteractionGate({request,model,record,publish,until,pause,nonce,pageEpoch,currentIndex}) {
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 const button=(root,expression)=>[...(root??document).querySelectorAll('button')].find(node=>expression.test(node.textContent.trim())&&!node.disabled);
 const confirmation=()=>document.querySelector('[data-desktop-confirmation]');
 const decide=async approved=>{await until(()=>confirmation(),'Normal page confirmation missing');await until(()=>window.termdockPreviewLifecycle?.snapshot().overlayReady,'Confirmation isolation receipt missing');const buttons=confirmation().querySelectorAll('button');assert(buttons.length===2,'Unexpected normal confirmation actions');buttons[approved?1:0].click();if(approved)buttons[1].click();await until(()=>!confirmation(),'Normal page confirmation did not settle');};
 await request('menu',{id:'toggle-right-sidebar'});
 await until(()=>button(document.querySelector('[data-sidebar="right"]'),/^(文件|Files)$/),'Normal right sidebar file tab missing');button(document.querySelector('[data-sidebar="right"]'),/^(文件|Files)$/).click();
 await until(()=>document.querySelector('[title="/controlled/owned.txt"]'),'Owned file did not reach normal FileTree');
 const deleteControl=async()=>{const row=document.querySelector('[title="/controlled/owned.txt"]');assert(row,'Owned file node absent');const more=[...row.querySelectorAll('button')].find(node=>/^(更多文件操作|More file actions)$/.test(node.title||node.getAttribute('aria-label')||''));assert(more,'Owned row more actions absent');more.click();await until(()=>document.querySelector('button[title="删除文件"],button[title="Delete file"]'),'Normal file delete action absent');return document.querySelector('button[title="删除文件"],button[title="Delete file"]');};
 const requests=data=>data.events.filter(event=>event.type==='controlled-file-delete');let data=await model();const before=requests(data).length;
 (await deleteControl()).click();await decide(false);data=await model();assert(requests(data).length===before,'Cancel issued DELETE');record('normal FileTree Cancel performs no encrypted DELETE',{deleteRequests:0,realFilesystem:false});
 (await deleteControl()).click();await decide(true);await until(()=>document.querySelector('[data-preview-feedback]')?.textContent.includes('Controlled file deletion failure'),'FileTree delete failure feedback not visible in page');data=await model();const deletes=requests(data).slice(before);assert(deletes.length===1&&deletes[0].encrypted&&deletes[0].csrfOmitted&&deletes[0].method==='DELETE'&&deletes[0].realFilesystem===false,'Normal FileTree confirm did not reach exactly one owned encrypted DELETE');assert(document.querySelector('[title="/controlled/owned.txt"]'),'Inert failed deletion removed the file');record('normal FileTree explicit double click makes one encrypted inert DELETE and page error',{request:deletes[0],errorRole:document.querySelector('[data-preview-feedback]').getAttribute('role'),fileStillPresent:true});document.querySelector('[data-preview-feedback] button').click();
 window.dispatchEvent(new CustomEvent('termdock:open-settings'));await until(()=>document.querySelector('[aria-labelledby="settings-dialog-title"]'),'Normal settings absent');const settings=document.querySelector('[aria-labelledby="settings-dialog-title"]');
 const scope=settings.querySelector('[data-terminal-renderer-scope="browser-fallback"]');assert(!scope,'Actual native renderer must hide browser/fallback preferences');record('actual native selected session hides browser renderer preferences',{scopeAbsent:true,staticCapabilityUsed:false});
 const install=()=>button(settings,/^(重启并安装|Restart and install)$/);let actionSamples=0,lastActionSample='';const clickInstall=()=>tdNativeReactInteractionClick(settings,/^(重启并安装|Restart and install)$/,until,'Normal desktop install action is still pending or not ready',value=>{const sample=JSON.stringify(value);if(sample!==lastActionSample&&actionSamples<8){lastActionSample=sample;actionSamples++;publish('normal-install-button-observed',{action:'desktop-install-ready',settingsConnected:settings.isConnected,overlayReady:window.termdockPreviewLifecycle?.snapshot().overlayReady??null,moving:window.termdockPreviewLifecycle?.snapshot().moving??null,...value});}},()=>window.termdockDesktop.desktopUpdateState());await until(()=>install(),'Owned inert ready desktop update missing');let update=await window.termdockDesktop.desktopUpdateState();assert(update.controlledInstallCalls===0&&!update.realOsUpdaterCalled,'Inert desktop receiver not isolated');
 await clickInstall();await decide(false);update=await window.termdockDesktop.desktopUpdateState();assert(update.controlledInstallCalls===0,'Cancel invoked desktop installer');record('normal desktop update confirmation Cancel calls no inert installer',{installCalls:0,realOsUpdaterCalled:false});
 await clickInstall();await decide(true);await until(()=>settings.textContent.includes('Controlled desktop update failure'),'Normal desktop install error absent');update=await window.termdockDesktop.desktopUpdateState();assert(update.controlledInstallCalls===1&&!update.realOsUpdaterCalled,'Explicit desktop confirm called wrong receiver or duplicated');record('normal desktop confirmation double click invokes one inert stub and visible failure',{installCalls:update.controlledInstallCalls,realOsUpdaterCalled:false});
 await clickInstall();await until(()=>confirmation(),'Second normal desktop confirmation absent');publish('controlled-desktop-update-invalidate-ready');let wanted=currentIndex();await until(()=>window.__TD_NATIVE_GATE_STAGE_RECEIPT?.nonce===nonce&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.pageEpoch===pageEpoch&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.index===wanted,'Owned ready invalidation receipt missing');await until(()=>!install(),'Normal App did not observe changed ready state');await decide(true);update=await window.termdockDesktop.desktopUpdateState();assert(update.controlledInstallCalls===1,'Old ready confirmation invoked installer');record('normal App rejects confirmation after actual controlled ready-state event',{installCalls:1,readyChanged:true,realOsUpdaterCalled:false});
 publish('controlled-desktop-update-allow-success');wanted=currentIndex();await until(()=>window.__TD_NATIVE_GATE_STAGE_RECEIPT?.nonce===nonce&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.pageEpoch===pageEpoch&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.index===wanted,'Owned success readiness receipt missing');await until(()=>install(),'Normal App did not observe inert ready state');await clickInstall();await decide(true);await until(async()=>(await window.termdockDesktop.desktopUpdateState()).controlledInstallCalls===2,'Explicit inert successful desktop install absent');record('normal App explicit confirmation reaches inert success receipt',{installCalls:2,realOsUpdaterCalled:false,source:'normal App confirmation and verified bridge to controlled stub'});
 const feedback=async(expected,message)=>{let previous='',samples=0;await until(()=>{const panel=document.querySelector('[data-preview-feedback]'),value={exists:!!panel,role:panel?.getAttribute('role')??null,message:panel?.querySelector('p')?.textContent===expected?expected:null,messageLength:Math.min(panel?.querySelector('p')?.textContent?.length??0,4096),matched:!!tdNativeReactInteractionFeedback(expected)},encoded=JSON.stringify(value);if(encoded!==previous&&samples<8){previous=encoded;samples++;publish('normal-error-feedback-observed',{action:'owned-error-feedback',...value});}return value.matched;},message);};
 const dismiss=button(settings,/^(知道了|Got it)$/);assert(dismiss,'Owned server health dismiss action missing');dismiss.click();await feedback('Failed to dismiss server health','Normal client health feedback predicate did not match');data=await model();const health=data.events.filter(event=>event.type==='controlled-health-dismiss');assert(health.length===1&&health[0].encrypted&&health[0].method==='POST'&&!health[0].realSupervisor,'Owned health receiver mismatch');record('normal health dismissal reports owned failure in page',{role:document.querySelector('[data-preview-feedback]').getAttribute('role'),request:health[0],feedbackSource:'fixed client API error; inert response body is not forwarded',realSupervisor:false});document.querySelector('[data-preview-feedback] button').click();
 const check=tdNativeReactInteractionServiceCheck(settings);assert(check,'Normal service update check action missing');check.click();await feedback('Failed to check for updates','Normal client update feedback predicate did not match');data=await model();const checks=data.events.filter(event=>event.type==='controlled-update-check');assert(checks.length===1&&checks[0].encrypted&&checks[0].method==='POST'&&checks[0].csrfOmitted&&!checks[0].realUpdate,'Owned update check receiver mismatch');record('normal service update check reports owned failure in page',{role:document.querySelector('[data-preview-feedback]').getAttribute('role'),request:checks[0],feedbackSource:'fixed client API error; inert response body is not forwarded',realUpdate:false});document.querySelector('[data-preview-feedback] button').click();
 record('programmatic DOM scope and unobserved presentation',{documentHidden:document.hidden,physicalKeysTested:false,clipboardTouched:false});
}

// Feedback-only branch: normal App settings and normal selected session tabs.
// A real owned RetireAll triggers the ordinary fatal/detach/fallback path. It is
// not a fabricated host event, an OS action, or a second hidden renderer.
// Fixed owned identities only; absent public engine readiness stays unknown.
function tdNativeReactFeedbackSnapshot(frontend,state){
 const buttons=[...document.querySelectorAll('button')].filter(node=>node.textContent.trim()==='Controlled Second'),button=buttons.find(node=>node.isConnected&&!node.disabled);
 const zones=[...document.querySelectorAll('[data-termdock-terminal-dropzone]')].filter(node=>node.dataset.termdockTerminalDropzone==='terminal::'+frontend);
 const lifecycle=window.termdockPreviewLifecycle?.snapshot(),settings=document.querySelector('[aria-labelledby="settings-dialog-title"]');
 const scalar=value=>typeof value==='boolean'?value:null;
 return{documentHidden:document.hidden,secondButtons:Math.min(buttons.length,8),buttonConnected:!!button?.isConnected,buttonDisabled:buttons.length===1?buttons[0].disabled:null,ariaSelected:['true','false'].includes(button?.getAttribute('aria-selected'))?button.getAttribute('aria-selected')==='true':null,selectionIndicator:!!button?.querySelector(':scope > span.absolute.inset-y-2.left-0'),matchingViewports:Math.min(zones.length,8),xtermInMatchingViewport:Math.min(zones.reduce((count,node)=>count+node.querySelectorAll('.xterm').length,0),8),viewportsWithoutXterm:Math.min(zones.filter(node=>!node.querySelector('.xterm')).length,8),engineReady:null,settingsPresent:!!settings,browserRendererControls:settings?!!settings.querySelector('[data-terminal-renderer-controls="browser-fallback"]'):null,overlayReady:scalar(lifecycle?.overlayReady),moving:scalar(lifecycle?.moving),hidden:scalar(lifecycle?.hidden),secondOpen:state?state.events.some(event=>event.type==='terminal-open'&&event.backend===state.extraBackend):null,secondAckExact:state?state.events.some(event=>event.type==='output-ack'&&event.backend===state.extraBackend&&event.flowSeq===2&&event.since===2&&event.epoch==='controlled-stream-second'):null,secondFrameDataReturn:state?state.events.some(event=>event.type==='second-frame-send-return'&&event.backend===state.extraBackend&&event.phase==='data'&&event.seq===2&&event.epoch==='controlled-stream-second'):null};
}
function tdNativeReactFeedbackRemember(buffer,snapshot){
 const key=JSON.stringify(snapshot);if(buffer.lastKey===key)return buffer;
 buffer.lastKey=key;buffer.total++;if(buffer.samples.length===16){buffer.samples.shift();buffer.dropped++;}buffer.samples.push({index:buffer.total,...snapshot});return buffer;
}
async function tdNativeReactFeedbackAwaitSecond({data,model,until,observe,publish}){
 try{await until(async()=>{const state=await model();observe('waiting',state);return state.events.some(event=>event.type==='output-ack'&&event.backend===data.extraBackend&&event.flowSeq===2&&event.since===2&&event.epoch==='controlled-stream-second');},'Second normal component consumption ACK absent');}
 catch(error){publish('feedback-selection-failed',{selection:observe('failed')});throw error;}
}
async function tdNativeReactFeedbackGate({request,model,record,publish,until}) {
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 const settings=()=>document.querySelector('[aria-labelledby="settings-dialog-title"]');
 const controls=()=>settings()?.querySelector('[data-terminal-renderer-controls="browser-fallback"]');
 const open=async()=>{window.dispatchEvent(new CustomEvent('termdock:open-settings'));await until(()=>settings()&&window.termdockPreviewLifecycle?.snapshot().overlayReady,'Normal settings isolation not ready');};
 const close=async()=>{const dialog=settings(),button=[...dialog.querySelectorAll('button')].find(node=>/^(关闭|Close)$/.test(node.getAttribute('aria-label')||'')&&!node.disabled);assert(button,'Normal settings header Close absent');button.click();await until(()=>!settings(),'Normal settings node did not close');};
 const pref=()=>{try{return JSON.parse(localStorage.getItem('termdock-settings')||'{}').rendererMode??null;}catch{return null;}};
 const before=pref();await open();assert(!controls(),'Actual native selected session exposed browser renderer options');record('normal settings hide renderer options for actual native ready session',{controlsAbsent:true,staticCapabilityUsed:false});await close();
 const receipt=await request('retireAll',{generation:'controlled-feedback-fallback'},null);assert(receipt.hidden&&receipt.retired,'Owned fallback detach was not confirmed');
 await until(()=>document.querySelector('.xterm'),'Normal browser fallback did not mount after actual detach');await open();await until(()=>controls(),'Browser fallback preferences did not return');assert(controls().querySelectorAll('button').length===3,'Browser fallback renderer options incomplete');record('normal actual fallback restores three renderer preferences after host detach',{receipt,options:3,preferenceUnchanged:pref()===before,physicalPresentation:false});await close();
 const data=await model('feedback-add-session');
 await until(()=>[...document.querySelectorAll('button')].some(node=>node.textContent.trim()==='Controlled Second'&&!node.disabled),'Normal second owned session tab absent');
 const selection={samples:[],dropped:0,total:0,lastKey:null};
 let lastModel=data;const observe=(phase,state)=>{if(state)lastModel=state;tdNativeReactFeedbackRemember(selection,{phase,...tdNativeReactFeedbackSnapshot(data.extraFrontend,lastModel)});return{samples:selection.samples,dropped:selection.dropped,total:selection.total};};
 const second=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='Controlled Second'&&!node.disabled);observe('before-click',data);second.click();observe('after-click');
 await tdNativeReactFeedbackAwaitSecond({data,model,until,observe,publish});
 await open();await until(()=>!controls(),'Selected second native session did not hide renderer preferences');record('normal session selection uses second native lease instead of first fallback',{secondBackend:data.extraBackend,rendererControlsAbsent:true,selection:observe('acknowledged')});await close();
 await until(()=>[...document.querySelectorAll('button')].some(node=>node.textContent.trim()==='Controlled React'&&!node.disabled),'Normal first session tab absent');[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='Controlled React'&&!node.disabled).click();
 await open();await until(()=>controls(),'Selecting retained fallback did not restore renderer preferences');assert(controls().querySelectorAll('button').length===3&&pref()===before,'Renderer preferences changed or incomplete');record('normal selection back to browser fallback restores saved renderer choices',{options:3,preferenceUnchanged:true});
 record('feedback presentation boundary',{documentHidden:document.hidden,physicalKeysTested:false,systemClipboardTouched:false});
}

// Owned input-only branch. Paste exercises the real engine Input callback and
// encrypted page socket; it does not impersonate an AppKit key or mouse event.
function tdNativeReactInputReceipt(data,backend,marker){
 const matches=data.events.filter(event=>event.type==='input'&&event.data===marker);
 if(matches.some(event=>event.backend!==backend))throw Error('Owned marker reached another backend');
 if(matches.length>1)throw Error('Owned marker was delivered more than once');
 return matches.length===1&&matches[0].receipt==='controlled-terminal-input-v1'&&matches[0].bytes===marker.length;
}
function tdNativeReactInputTab(name){return [...document.querySelectorAll('button.sidebar-session-primary')].find(button=>button.textContent.trim()===name&&button.isConnected&&!button.disabled);}
async function tdNativeReactInputGate({request,model,record,publish,until,capability,gateState}){
 const assert=(value,message)=>{if(!value)throw Error(message);};
 let data=await model();const first={name:'Controlled React',frontend:data.frontend,backend:data.backend,cap:{...capability()}};
 assert(first.cap.token,'Initial owned native capability absent');
 const selected=frontend=>[...document.querySelectorAll('[data-termdock-terminal-dropzone]')].find(zone=>zone.dataset.termdockTerminalDropzone==='terminal::'+frontend&&zone.getAttribute('aria-disabled')==='false'&&!zone.querySelector('.xterm'));
 const select=async session=>{await until(()=>tdNativeReactInputTab(session.name),'Normal owned session tab absent');tdNativeReactInputTab(session.name).click();await until(()=>selected(session.frontend),'Selected native input eligibility did not settle');assert(window.termdockPreviewLifecycle?.snapshot().gate?.failed!==true,'Native isolation gate failed during input selection');};
 const add=async(action,name,frontendKey,backendKey,epoch,previous)=>{
  data=await model(action);const session={name,frontend:data[frontendKey],backend:data[backendKey]};await select(session);
  await until(async()=>{const value=await model();return value.events.some(event=>event.type==='output-ack'&&event.backend===session.backend&&event.flowSeq===2&&event.since===2&&event.epoch===epoch)&&capability()?.token!==previous;},'New selected native stream did not consume its exact backend cursor');
  session.cap={...capability()};assert(session.cap.token,'New owned native capability missing');return session;
 };
 const second=await add('feedback-add-session','Controlled Second','extraFrontend','extraBackend','controlled-stream-second',first.cap.token);
 const third=await add('feedback-add-three-sessions','Controlled Third','thirdFrontend','thirdBackend','controlled-stream-third',second.cap.token);
 assert(new Set([first.cap.token,second.cap.token,third.cap.token]).size===3,'Owned sessions did not use three distinct native capabilities');
 const enter=async(session,marker)=>{
  await select(session);publish('controlled-input-route-start',{route:['Controlled React','Controlled Second','Controlled Third'].indexOf(session.name)+1,bytes:marker.length});
  // One explicit input only. No retry of an unknown business result.
  if(gateState){gateState.inputExpectedToken=session.cap.token;gateState.inputExpectedView='terminal::'+session.frontend;}
  await request('paste',{text:marker},session.cap.token);
  await until(async()=>tdNativeReactInputReceipt(await model(),session.backend,marker),'Native Input did not reach exactly its selected encrypted backend');
  record('owned native paste reaches only selected encrypted backend',{route:['Controlled React','Controlled Second','Controlled Third'].indexOf(session.name)+1,marker,bytes:marker.length,matchingReceipts:1,otherReceipts:0,physicalKeyDown:false});
 };
 for(const [session,marker] of [[first,'td-owned-input-a'],[second,'td-owned-input-b'],[third,'td-owned-input-c'],[first,'td-owned-input-a-return']])await enter(session,marker);
 await select(third);
 for(const session of [first,second]){
  const tab=tdNativeReactInputTab(session.name),close=tab?.parentElement&&[...tab.parentElement.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')==='关闭 '+session.name||button.getAttribute('aria-label')==='Close '+session.name);
  assert(close&&!close.disabled,'Normal owned session close action absent');close.click();
  await until(async()=>{const value=await model();return !value.inventory.clientSessions.some(item=>item.frontendSessionId===session.frontend)&&!tdNativeReactInputTab(session.name);},'Normal close did not remove its owned session');
 }
 await enter(third,'td-owned-input-c-after-delete');
 data=await model();for(const [session,marker] of [[first,'td-owned-input-a'],[second,'td-owned-input-b'],[third,'td-owned-input-c'],[first,'td-owned-input-a-return'],[third,'td-owned-input-c-after-delete']])assert(tdNativeReactInputReceipt(data,session.backend,marker),'Final owned input receipt mismatch');
 record('third native input continues after normal deletion of first two sessions',{remainingSessions:data.inventory.clientSessions.length,firstAbsent:!tdNativeReactInputTab(first.name),secondAbsent:!tdNativeReactInputTab(second.name),physicalKeysTested:false,systemClipboardTouched:false,documentHidden:document.hidden});
}

async function tdNativeReactKeyboardManual({model,request,record,publish,pause,until,currentIndex,capability,gateState,nativeEvents}){
 const owner={...capability()},initial=await model(),header=document.querySelector('[data-termdock-window-header]');
 if(!header)throw Error('Owned visible window header unavailable');
 const label=document.createElement('label'),input=document.createElement('input'),done=document.createElement('button');
 label.textContent='输入检查：';input.setAttribute('aria-label','输入检查');input.placeholder='先输入 a，切回后输入 b';input.style.width='180px';done.textContent='完成输入检查';done.type='button';label.append(input);header.append(label,done);
 const seen={wkA:false,wkB:false,wkAKey:false,wkBKey:false,wkComposing:false,wkProcessKey:false,wkADefaultPrevented:null,wkBDefaultPrevented:null,wkACodeMatches:null,wkBCodeMatches:null,wkAModifiers:0,wkBModifiers:0,wkBeforeInput:0,wkTextInput:0,wkEnter:0,wkTab:0,wkDelete:0};let completed=false,last='',count=0,lastNative=-1,lastInspection='',attachment={hidden:null,focused:null},data=initial,focusRevision=0;
 const focusChanged=()=>{focusRevision++;};window.addEventListener('focus',focusChanged);window.addEventListener('blur',focusChanged);
 const edited=()=>{seen.wkA ||= input.value.includes('a');seen.wkB ||= input.value.includes('b');};
 input.addEventListener('input',edited);input.addEventListener('beforeinput',()=>{seen.wkBeforeInput++;});input.addEventListener('textInput',()=>{seen.wkTextInput++;});input.addEventListener('compositionstart',()=>{seen.wkComposing=true;});input.addEventListener('keydown',event=>{if(event.key==='a'||event.key==='b'){const key=event.key;seen[key==='a'?'wkACodeMatches':'wkBCodeMatches']=event.code===(key==='a'?'KeyA':'KeyB');seen[key==='a'?'wkAModifiers':'wkBModifiers']=(event.shiftKey?1:0)|(event.ctrlKey?2:0)|(event.altKey?4:0)|(event.metaKey?8:0);Promise.resolve().then(()=>{seen[key==='a'?'wkADefaultPrevented':'wkBDefaultPrevented']=event.defaultPrevented;});}seen.wkAKey ||= event.key==='a';seen.wkBKey ||= event.key==='b';seen.wkComposing ||= event.isComposing===true;seen.wkProcessKey ||= event.key==='Process'||event.key==='Unidentified';if(event.key==='Enter')seen.wkEnter++;else if(event.key==='Tab')seen.wkTab++;else if(event.key==='Backspace'||event.key==='Delete')seen.wkDelete++;});done.onclick=()=>{completed=true;};
 publish('manual-keyboard-ready',{ownedInput:true,automaticKeys:false,forcedFirstResponder:false,maximumSeconds:540});
 const armIndex=currentIndex();
 try{await until(()=>window.__TD_NATIVE_MANUAL_COUNTER_INDEX===armIndex,'Owned manual keyboard counters not armed');const end=performance.now()+540000;while(performance.now()<end){
  const owned=nativeEvents().filter(event=>event.token===owner.token&&event.epoch===owner.epoch),native=owned.filter(event=>event.event.type==='input');
  // Waiting is local. Encrypted model reads follow actual input or explicit
  // completion; native inspection follows a bounded change, never the timer.
  if(native.length!==lastNative||completed){if(native.length>0||completed)data=await model();lastNative=native.length;}
  const own=data.events.filter(event=>event.type==='input'&&event.backend===initial.backend),bytes=own.map(event=>event.data).join('');
  const inspection=JSON.stringify([seen,document.hidden,document.activeElement===input,focusRevision,owned.filter(event=>event.event.type==='pointer').length,native.length,completed]);
  if(inspection!==lastInspection&&count<32){attachment=await request('inspect',{},owner.token);lastInspection=inspection;}
  const value={...seen,manualCompleted:completed,wkReadOnly:input.readOnly,wkDisabled:input.disabled,nativeA:bytes.includes('a'),nativeB:bytes.includes('b'),nativeEnter:bytes.includes('\r'),nativeTab:bytes.includes('\t'),nativeDelete:bytes.includes('\x7f'),modelInputCount:own.length,nativeInputCount:native.length,documentHidden:document.hidden,domInputFocused:document.activeElement===input,nativeHidden:attachment.hidden,nativeFocused:attachment.focused,automaticKeys:false,forcedFirstResponder:false};
  gateState.keyboardManual=value;const scalar=JSON.stringify(value);if(scalar!==last){last=scalar;if(count++<32){record('owned user keyboard state',value);publish('manual-keyboard-state',value);}else gateState.keyboardManualDropped=(gateState.keyboardManualDropped||0)+1;}
  if(completed){publish('manual-keyboard-final',{automaticKeys:false,forcedFirstResponder:false});const counterIndex=currentIndex();await until(()=>window.__TD_NATIVE_MANUAL_COUNTER_INDEX===counterIndex,'Owned manual keyboard counters not sampled');if(!value.wkA||!value.wkB||!value.nativeA||!value.nativeB)throw Error('Manual letter comparison incomplete; fixed a/b must reach both WK and native model');return;}
  await pause(250);
 }throw Error('Manual keyboard operation deadline; no automatic keys were sent');
 }finally{window.removeEventListener('focus',focusChanged);window.removeEventListener('blur',focusChanged);label.remove();done.remove();}
}

async function tdNativeReactKeyboardComparison({request,model,record,publish,until,pause,capability,gateState,currentIndex,nativeEvents}){
 const owner={...capability()},initial=await model();gateState.keyboardComparison=[];gateState.keyboardContextFields=['appActive','windowKey','windowMain','responderTarget','responderWK','responderOther','targetWindowMatches','targetVisible','desiredFocus','desiredVisible','inputContextPresent','responderPresent'];
 const input=document.createElement('input');input.setAttribute('data-owned-keyboard-comparison','');input.setAttribute('aria-label','Owned keyboard comparison');
 // An ordinary WK input, in the isolated fixture document only. No product handler replacement.
 document.body.appendChild(input);
 try{for(let caseIndex=0;caseIndex<5;caseIndex++){
  publish('controlled-keyboard-probe-prepare',{caseIndex});let index=currentIndex();
  await until(()=>window.__TD_NATIVE_KEYBOARD_RESULT?.progressIndex===index,'Keyboard comparison preparation absent');
  const preparation={...window.__TD_NATIVE_KEYBOARD_RESULT},wk=caseIndex===0||caseIndex===2;
  await request('layout',{},owner.token);
  if(wk){input.value='';input.focus();}
  const before=nativeEvents().length,prior=(await model()).events.filter(event=>event.type==='input').length;
  publish('controlled-keyboard-probe-send',{caseIndex});index=currentIndex();
  await until(()=>window.__TD_NATIVE_KEYBOARD_RESULT?.progressIndex===index,'Keyboard comparison submission absent');
  const submission={...window.__TD_NATIVE_KEYBOARD_RESULT};let nativeBytes=[],modelMatched=false;
  const deadline=performance.now()+1200;
  while(performance.now()<deadline){
   const value=await model(),received=value.events.filter(event=>event.type==='input').slice(prior);
   nativeBytes=nativeEvents().slice(before).filter(event=>event.token===owner.token&&event.epoch===owner.epoch&&event.event.type==='input').flatMap(event=>Array.from(atob(event.event.base64||''),char=>char.charCodeAt(0)));
   modelMatched=received.length===1&&received[0].backend===initial.backend&&received[0].data==='a'&&received[0].bytes===1;
   if(wk?input.value==='a':modelMatched)break;await pause(20);
  }
  publish('controlled-keyboard-probe-read',{caseIndex});index=currentIndex();
  await until(()=>window.__TD_NATIVE_KEYBOARD_RESULT?.progressIndex===index,'Keyboard comparison read absent');
  const result={case:['wk-initial','native-click-initial','wk-after-activate','native-click-after-activate','native-forced-responder'][caseIndex],prepared:preparation.prepared,submitted:submission.submitted,forcedFirstResponder:caseIndex===4,wkLetterMatched:wk?input.value==='a':null,modelMatched,nativeInputBytes:nativeBytes,contextBefore:submission.contextBefore,contextAfter:submission.contextAfter,stages:window.__TD_NATIVE_KEYBOARD_RESULT.stages,physicalKeysTested:false};
  gateState.keyboardComparison.push(result);record('ordinary WK and native activation comparison',result);
 }}finally{input.remove();}
}

async function tdNativeReactKeyboardGate({request,model,record,publish,until,pause,capability,gateState,currentIndex,nativeEvents}){
 const initial=await model(),owner={...capability()},cases=[['a','a'],['b','b'],['shift-a','A'],['enter','\r'],['tab','\t'],['delete','\x7f']];
 gateState.keyboardCases=[];gateState.inputExpectedToken=owner.token;gateState.inputExpectedView='terminal::'+initial.frontend;
 await tdNativeReactKeyboardComparison({request,model,record,publish,until,pause,capability,gateState,currentIndex,nativeEvents});
 for(let caseIndex=0;caseIndex<cases.length;caseIndex++){
  const [name,expected]=cases[caseIndex];
  await request('layout',{},owner.token); // Normal consumed idle receipt, no synthetic focus.
  const before=nativeEvents().length,old=await model(),prior=old.events.filter(event=>event.type==='input').length;
  publish('controlled-keyboard-case',{caseIndex});const submissionIndex=currentIndex();
  await until(()=>window.__TD_NATIVE_KEYBOARD_RESULT?.progressIndex===submissionIndex,'Owned keyboard dispatch receipt absent');
  const submitted={...window.__TD_NATIVE_KEYBOARD_RESULT};let value,actual='',matched=false;
  const deadline=performance.now()+1200;
  while(performance.now()<deadline){
   value=await model();const inputs=nativeEvents().slice(before).filter(event=>event.token===owner.token&&event.epoch===owner.epoch&&event.event.type==='input');
   actual=inputs.map(event=>atob(event.event.base64||'')).join('');
   const modelInputs=value.events.filter(event=>event.type==='input').slice(prior);
   if(modelInputs.some(event=>event.backend!==initial.backend))throw Error('Owned key reached another backend');
   matched=actual===expected&&modelInputs.length===1&&modelInputs[0].data===expected&&modelInputs[0].bytes===expected.length;
   if(matched)break;await pause(20);
  }
  publish('controlled-keyboard-read',{caseIndex});const readIndex=currentIndex();await until(()=>window.__TD_NATIVE_KEYBOARD_RESULT?.progressIndex===readIndex,'Owned keyboard counter receipt absent');
  const sample={case:name,ok:matched,submitted:submitted.submitted,forcedFirstResponder:submitted.forcedFirstResponder,stages:submitted.submitted?window.__TD_NATIVE_KEYBOARD_RESULT.stages:null,nativeInputBytes:Array.from(actual,char=>char.charCodeAt(0)),modelMatched:matched,physicalKeysTested:false};
  gateState.keyboardCases.push(sample);record('actual AppKit keyDown through product Input and encrypted model',sample);
 }
 if(gateState.keyboardComparison.some(value=>value.wkLetterMatched===false||value.wkLetterMatched===null&&!value.modelMatched))throw Error('Initial/activated WK or native keyboard comparison failed; forced responder is only a control');
 if(gateState.keyboardCases.some(value=>!value.ok))throw Error('Full App keyboard path did not emit every expected owned key');
}

// Keep exact pre-existing alert DOM owners. A sidebar close may not resume
// through an unrelated alert that still requires its native cutout.
function tdNativeReactOverlayStartupSettled(value){
 const startup=document.getElementById('termdock-startup');
 if(startup&&!startup.hidden&&getComputedStyle(startup).display!=='none')return false;
 for(const marker of document.querySelectorAll('[data-startup-pending]')){
  if(!marker.closest('[aria-hidden="true"], [hidden]')&&getComputedStyle(marker).visibility!=='hidden')return false;
 }
 const gate=value?.gate;
 return !!gate&&value.overlayReady===true&&!value.moving&&gate.failed===false&&gate.pending===false&&gate.resuming===false&&gate.queued===false&&gate.frameScheduled===false&&gate.acknowledged===value.generation;
}
function tdNativeReactOverlayBaseline(value){
 const equal=(r,h)=>r.x===h.x&&r.y===h.y&&r.width===h.width&&r.height===h.height;
 const selector='[role="dialog"],[aria-modal="true"],[role="menu"],[role="tooltip"],[role="alert"],.z-modal-panel,.z-modal-content,.z-modal-backdrop,.z-drawer-panel,.z-drawer-content,.z-drawer-backdrop,.z-popover,.z-menu-panel,.z-menu-content,.z-menu-backdrop,.z-toast,.z-sidebar-backdrop';
 const candidates=[...document.querySelectorAll(selector)].filter(node=>node.isConnected&&!node.dataset.nativeRecovery);
 const used=new Set(),owners=[];
 for(const hole of value.overlays){
  const matching=candidates.filter(node=>equal(node.getBoundingClientRect(),hole));
  if(matching.length!==1||matching[0].getAttribute('role')!=='alert'||used.has(matching[0]))throw Error('Owned overlay baseline contains an unclassified or ambiguous owner');
  used.add(matching[0]);owners.push(matching[0]);
 }
 return owners;
}
function tdNativeReactOverlayCloseState(sidebar,baseline,value){
 const rect=sidebar?.getBoundingClientRect(),equal=(r,h)=>r.x===h.x&&r.y===h.y&&r.width===h.width&&r.height===h.height;
 if(!rect||rect.left<innerWidth-0.5||getComputedStyle(sidebar).pointerEvents!=='none'||!value||value.gate?.failed||value.gate?.resuming!==false||value.moving)return false;
 if(!baseline.length)return value.overlays.length===0&&value.gate.status==='resume-confirmed';
 if(value.overlays.length!==baseline.length||!value.overlayReady||value.gate.status!=='clip-confirmed'||value.gate.acknowledged!==value.generation)return false;
 const actual=tdNativeReactOverlayBaseline(value);
 return actual.length===baseline.length&&actual.every(node=>baseline.includes(node))&&baseline.every(node=>node.isConnected&&value.overlays.some(h=>equal(node.getBoundingClientRect(),h)));
}
// Opt-in owned page only: ordinary React handlers, not OS/visual verification.
async function tdNativeReactOverlayCheck({request,model,record,publish,until,capability}){
 const assert=(value,message)=>{if(!value)throw Error(message);},owner={...capability()};
 const current=()=>{const value=capability();assert(value.token===owner.token&&value.epoch===owner.epoch,'Overlay check owner changed');};
 const life=()=>window.termdockPreviewLifecycle?.snapshot();
 const sidebar=()=>document.querySelector('[data-sidebar="right"]');
 const visibleNative=async message=>{let count=0,last;await until(async()=>{if(count>=8)return false;count++;last=await request('inspect',{},owner.token);return last.hidden===false;},message);return last;};
 const shown=()=>sidebar()&&getComputedStyle(sidebar()).pointerEvents!=='none';
 const safe=()=>{const value=life();return value?.overlayReady===true&&value.gate?.failed!==true&&value.gate?.acknowledged===value.generation;};
 const sample=phase=>{current();const value=life();publish('owned-file-overlay-state',{phase,generation:value?.generation??null,acknowledged:value?.gate?.acknowledged??null,overlayReady:value?.overlayReady??null,failed:value?.gate?.failed??null,overlays:value?.overlays?.length??null,syntheticDomEvents:true,visualTested:false});};
 if(shown()){await request('menu',{id:'toggle-right-sidebar'});await until(()=>{const r=sidebar()?.getBoundingClientRect(),v=life();return !shown()&&r?.left>=innerWidth-0.5&&!v?.moving&&v?.gate?.resuming===false;},'Owned sidebar did not finish closing before check');}
 await until(()=>{current();return tdNativeReactOverlayStartupSettled(life());},'Normal startup presentation and native layout did not settle before overlay baseline');
 await visibleNative('Native surface remained hidden after startup settled');
 const baseline=tdNativeReactOverlayBaseline(life());
 await request('menu',{id:'toggle-right-sidebar'});await until(()=>shown()&&safe(),'Normal file drawer did not confirm first safe hide');sample('open-confirmed');
 const files=[...sidebar().querySelectorAll('button')].find(button=>/^(文件|Files)$/.test(button.textContent.trim())&&!button.disabled);assert(files,'Normal Files tab absent');files.click();
 await until(()=>document.querySelector('[title="/controlled/owned.txt"]'),'Owned file row absent');document.querySelector('[title="/controlled/owned.txt"]').click();
 await until(async()=>{const value=await model();return value.events.some(event=>event.type==='controlled-file-read'&&event.encrypted===true&&event.owned===true&&event.realFilesystem===false);},'Normal FilePreview did not read the owned encrypted file');
 await until(()=>[...sidebar().querySelectorAll('[data-file-preview-line]')].some(node=>node.textContent.includes('Owned file preview')),'Normal FilePreview fixed content did not render');
 const separator=sidebar().querySelector('[data-local-layer="file-preview-separator"]');assert(separator,'Normal file preview separator absent');
 const tree=separator.previousElementSibling,before=tree.getBoundingClientRect().width,rect=separator.getBoundingClientRect();assert(rect.width>0&&rect.height>0,'Normal separator has no layout');
 let captureError=false;const error=event=>{if(String(event.message).includes('pointer')||String(event.message).includes('Pointer')||event.error?.name==='NotFoundError')captureError=true;};window.addEventListener('error',error);
 try{for(const [type,x,buttons]of [['pointerdown',rect.x,1],['pointermove',rect.x-36,1],['pointerup',rect.x-36,0]])separator.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',button:0,buttons,clientX:x,clientY:rect.y+20}));}finally{window.removeEventListener('error',error);}
 // Synthetic DOM input may lack an AppKit active pointer. Keep capture refusal
 // explicit while separately checking the real React handler's width update.
 await until(()=>Math.abs(tree.getBoundingClientRect().width-before)>1,'Normal separator handler did not resize the file tree');
 await until(()=>safe(),'Overlay isolation lost after normal separator resize');sample('resized');const resized=await visibleNative('Native surface remained hidden after overlay layout');
 record('normal FilePreview encrypted read and actual separator handler resize',{encryptedOwnedRead:true,contentMatched:true,widthBefore:before,widthAfter:tree.getBoundingClientRect().width,pointerCaptureAccepted:!captureError,nativeHidden:resized.hidden,syntheticDomEvents:true,physicalMouseTested:false,visualTested:false});
 await request('menu',{id:'toggle-right-sidebar'});try{await until(()=>tdNativeReactOverlayCloseState(sidebar(),baseline,life()),'Normal drawer animation did not finish offscreen with confirmed overlay resume');}
 catch(error){const value=life(),rect=sidebar()?.getBoundingClientRect();publish('owned-file-overlay-close-failed',{asideOffscreen:!!rect&&rect.left>=innerWidth-0.5,asideLeft:rect?.left??null,viewportWidth:innerWidth,baselineAlerts:baseline.length,remainingOverlays:value?.overlays?.length??null,generation:value?.generation??null,acknowledged:value?.gate?.acknowledged??null,status:value?.gate?.status??null,resuming:value?.gate?.resuming??null,moving:value?.moving??null,syntheticDomEvents:true});throw error;}
 const closed=await visibleNative('Native surface did not resume after normal drawer close');sample('closed');
 await model('output');
 await until(async()=>{const value=await model();return value.events.some(event=>event.type==='output-ack'&&event.epoch===value.epoch&&event.flowSeq===value.sequence&&event.since===value.sequence);},'Native output did not continue after overlay close');
 const marker='td-owned-overlay-input';current();await request('paste',{text:marker},owner.token);
 await until(async()=>{const value=await model();return tdNativeReactInputReceipt(value,value.backend,marker);},'Native input did not reach only its owned encrypted backend after overlay close');
 record('normal drawer close resumes native input and output',{nativeHidden:closed.hidden,continuedOutputAck:true,controlledNativePasteInput:true,physicalKeysTested:false,syntheticDomEvents:true,visualTested:false});
}
