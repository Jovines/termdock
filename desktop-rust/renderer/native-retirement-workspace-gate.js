// Opt-in retirement-only receiver. No business socket, terminal text or keys.
(async()=>{
 const nonce=window.__TD_NATIVE_GATE_NONCE,pageEpoch=window.__TD_NATIVE_GATE_EPOCH;
 const interrupted=window.__TD_NATIVE_GATE_INTERRUPTED,handoff=window.__TD_NATIVE_GATE_AUTH_HANDOFF,expectedPeer=window.__TD_NATIVE_GATE_EXPECTED_PEER,expectedServiceOrigin=window.__TD_NATIVE_GATE_EXPECTED_SERVICE_ORIGIN,expectedPageOrigin=window.__TD_NATIVE_GATE_EXPECTED_PAGE_ORIGIN,hostPinVerified=window.__TD_NATIVE_GATE_HOST_PIN_VERIFIED;
 if(window.__TD_NATIVE_GATE_RUNNING)throw Error('Retirement receiver requires a fresh owned epoch; no replay');
 window.__TD_NATIVE_GATE_RUNNING=true;
 const state=window.__TD_NATIVE_GATE_STATE={pageEpoch,steps:[],acks:[],stages:[],lastAction:null,finished:false};let index=0,token;
 const assert=(ok,message)=>{if(!ok)throw Error(message);},pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const waitForPasswordForm=async message=>{const deadline=performance.now()+12000;while(true){if(window.__TD_NATIVE_GATE_EPOCH!==pageEpoch)throw Error('Pairing page epoch changed; no retry');const form=tdNativeReactLoginForm();if(form)return form;if(performance.now()>=deadline)throw Error(message);await pause(25);}};
 const publish=(phase,detail)=>{if(window.__TD_NATIVE_GATE_EPOCH!==pageEpoch||state.cancelled)throw Error('Retirement epoch changed; no retry');if(detail)state.lastAction=detail;if(state.stages.length>=128)state.stages.shift();state.stages.push({pageEpoch,index:++index,phase,detail});tdNativeGateSignal(nonce,'progress',{...state,progressIndex:index,phase});};
 const record=(name,value)=>{assert(state.steps.length<16,'Retirement record bound');state.steps.push({name,value});publish('step-complete');};
 try{
  assert(typeof expectedPeer==='string'&&expectedPeer.length>0&&expectedPeer.length<=256,'Owned verified fixture target is missing');
  assert(typeof expectedServiceOrigin==='string'&&typeof expectedPageOrigin==='string'&&location.origin===expectedPageOrigin,'Owned service/page origin mismatch');
  assert(typeof window.termdockDesktop?.getServiceConnection==='function','Normal owned connection reader unavailable');
  const connection=await window.termdockDesktop.getServiceConnection();
  assert(window.__TD_NATIVE_GATE_EPOCH===pageEpoch,'Pairing page epoch changed while reading connection; no retry');
  assert(connection?.url===expectedServiceOrigin,'Owned service connection origin mismatch');
  assert(!connection.targetPeerId||connection.targetPeerId===expectedPeer,'A different target is selected; receiver setup refused');
  assert(!handoff||!!interrupted,'Pairing handoff without an observed page epoch is rejected');
  const storedTarget=()=>{try{return JSON.parse(sessionStorage.getItem('termdock-secure-target-v1')||'null');}catch{return null;}};
  const targetMatches=target=>target?.targetPeerId===expectedPeer&&target?.url===expectedServiceOrigin;
  if(interrupted){
   const previous=handoff?.previous,selected=storedTarget();
   const checks={nonce:handoff?.nonce===nonce,oldEpoch:handoff?.oldEpoch===interrupted.pageEpoch,newEpoch:handoff?.oldEpoch!==pageEpoch,peer:handoff?.targetPeerId===expectedPeer,serviceOrigin:handoff?.url===expectedServiceOrigin,previousEpoch:!!previous&&previous.pageEpoch===handoff?.oldEpoch,previousPhase:previous?.phase==='normal-login-form-submit-ready',stepsEmpty:Array.isArray(previous?.steps)&&previous.steps.length===0,acksEmpty:Array.isArray(previous?.acks)&&previous.acks.length===0,selectedTarget:targetMatches(selected),hostPin:hostPinVerified===true};
   assert(Object.values(checks).every(Boolean),'Normal pairing handoff did not establish the exact owned target pin: '+Object.keys(checks).filter(key=>!checks[key]).join(','));
   assert(Array.isArray(previous.stages)&&previous.stages.length<=128,'Pairing handoff stage evidence exceeded its bound');
   state.stages.push(...previous.stages);index=Number.isSafeInteger(previous.progressIndex)?previous.progressIndex:previous.stages.at(-1)?.index??0;
   publish('normal-pairing-target-pin-verified',{source:'normal authenticated connection save',oldEpoch:handoff.oldEpoch});
  }else{
   const selected=storedTarget();
   if(!targetMatches(selected)){
    assert(!selected?.targetPeerId,'A different target is selected; receiver setup refused');
    assert(typeof tdNativeReactLoginForm==='function','Normal owned authorization form helper unavailable');
    await new Promise((resolve,reject)=>{const deadline=performance.now()+12000;const poll=()=>{if(window.__TD_NATIVE_GATE_EPOCH!==pageEpoch)return reject(Error('Pairing page epoch changed; no retry'));if(tdNativeReactLoginForm()||[...document.querySelectorAll('button')].some(button=>button.textContent==='接受邀请'))return resolve();if(performance.now()>=deadline)return reject(Error('Normal owned authorization form unavailable'));setTimeout(poll,25);};poll();});
    const invitation=[...document.querySelectorAll('button')].find(button=>button.textContent==='接受邀请');let form=tdNativeReactLoginForm();if(invitation){invitation.click();publish('normal-invitation-button-clicked');form=await waitForPasswordForm('Normal visible enabled password form absent');}else if(!form)form=await waitForPasswordForm('Normal visible enabled password form absent');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(form.input,'preview-bundle-test-password');form.input.dispatchEvent(new Event('input',{bubbles:true}));
    const deadline=performance.now()+12000;while(true){const current=tdNativeReactLoginForm();if(current?.input===form.input&&current.form===form.form&&current.submit)break;if(performance.now()>=deadline)throw Error('Normal password form did not become submittable');await pause(25);}
    publish('normal-login-form-submit-ready');
    const receiptDeadline=performance.now()+12000;while(!(window.__TD_NATIVE_GATE_STAGE_RECEIPT?.nonce===nonce&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.pageEpoch===pageEpoch&&window.__TD_NATIVE_GATE_STAGE_RECEIPT?.index===index)){if(window.__TD_NATIVE_GATE_EPOCH!==pageEpoch)throw Error('Pairing page epoch changed before submit receipt; no retry');if(performance.now()>=receiptDeadline)throw Error('Normal pairing submit receipt absent');await pause(25);}
    const current=tdNativeReactLoginForm();assert(current?.form===form.form,'Normal password form changed before submit');form.form.requestSubmit(current.submit);return;
   }
  }
  assert(targetMatches(storedTarget()),'Verified target pin does not match the owned fixture');
  assert(hostPinVerified===true,'Owned current host pin not verified');
  const bridge=window.termdockDesktop?.nativeTerminal;assert(bridge?.available,'Normal native capability unavailable');
  const request=tdNativeGateRequester(bridge,()=>token,pause,(phase,detail)=>publish(phase,{action:detail.action,attempt:detail.attempt,token:detail.token,error:detail.error}));
  const base={view:'owned-retirement-receiver',session:'controlled-no-PTY',device:'controlled-device',fontSize:13,viewportWidth:innerWidth,viewportHeight:innerHeight,options:{columns:80,rows:24,history:0,palette:{ansi:Array.from({length:16},(_,i)=>[i*15,i*15,i*15]),foreground:[206,205,195],background:[28,27,26],cursor:[206,205,195],selection:[64,62,60]},font:{family:'JetBrainsMonoNL NFM',features:['+liga'],letter_spacing:1,extra_height_percent:5,weight:400,weight_bold:700,contrast:450,bold_is_bright:true}}};
  const create=async()=>{const value=await request('create',base);assert(value.epoch===pageEpoch&&value.token,'Fresh receiver stamp missing');token=value.token;const layout=await request('layout');assert(layout.complete&&layout.token===token&&layout.epoch===pageEpoch,'Receiver layout not confirmed');return value;};
  const retire=cap=>request('retireView',{view:base.view,token:cap});
  await create();const first=token,current=await retire(first);assert(current.detached===true&&current.disposition==='current'&&current.token===first&&current.epoch===pageEpoch,'Current retirement mismatch');record('actual current token detaches its surface',current);
  const absent=await retire(first);assert(absent.detached===true&&absent.disposition==='absent'&&absent.token===first&&absent.epoch===pageEpoch,'Absent retirement mismatch');record('actual absent surface is idempotently detached',absent);
  let unknownAbsent=false;try{await retire('00000000-0000-4000-8000-000000000002');}catch(error){unknownAbsent=tdNativeGateExpectedRejection(error);}assert(unknownAbsent,'Unknown token was accepted for an absent view');record('actual unknown absent owner stays rejected',{unknownAbsentRejected:true});
  await create();const previous=token;await create();assert(previous!==token,'Living rebind did not rotate token');
  const superseded=await retire(previous);assert(superseded.detached===false&&superseded.disposition==='superseded'&&superseded.token===previous&&superseded.replacementToken===token&&superseded.epoch===pageEpoch,'Known old binding falsely detached a replacement');const alive=await request('inspect');assert(alive.mainThread&&alive.surfaces===1,'Known stale retirement removed current surface');record('actual known old token only identifies its living replacement',{receipt:superseded,currentSurfaceCount:alive.surfaces,oldSurfaceDetachedClaimed:false});
  let unknown=false;try{await retire('00000000-0000-4000-8000-000000000001');}catch(error){unknown=tdNativeGateExpectedRejection(error);}assert(unknown&&(await request('inspect')).surfaces===1,'Unknown token removed current surface');record('actual unknown token remains rejected',{unknownRejected:true,currentSurfaceCount:1});
  const final=await retire(token);assert(final.detached===true&&final.disposition==='current'&&final.token===token,'Final exact detach missing');record('actual receiver final exact detach',final);state.finished=true;tdNativeGateSignal(nonce,'result',{...state,ok:true,progressIndex:index,parserAndHostOnly:true,physicalKeysTested:false,systemClipboardTouched:false});
 }catch(error){if(state.cancelled||window.__TD_NATIVE_GATE_EPOCH!==pageEpoch)return;state.finished=true;tdNativeGateSignal(nonce,'result',{...state,ok:false,progressIndex:index,error:String(error)});}
})();
