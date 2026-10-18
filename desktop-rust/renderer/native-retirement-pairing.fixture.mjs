// Invoked by the Rust generated-script test. Real DOM/helper/Preview bridge and
// clientScope serialization; authentication and native receipts are owned models.
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {transformSync} from 'esbuild';
const [scriptPath,statePath,stage]=process.argv.slice(2),state=JSON.parse(fs.readFileSync(statePath,'utf8'));
const dom=new JSDOM(stage==='first'?'<button type="button">接受邀请</button>':'',{url:state.ownerOrigin+'/',runScripts:'outside-only'}),w=dom.window;
try{
 const calls=[],history=new Set();let active=null,serial=0,savedConnection,submitted=false,snapshot;
 for(const [key,value] of Object.entries(state.storage||{}))w.sessionStorage.setItem(key,value);
 w.HTMLElement.prototype.getBoundingClientRect=function(){return{x:0,y:0,width:this.isConnected?120:0,height:24};};
 w.TextEncoder=TextEncoder;w.Request=Request;w.Response=Response;w.fetch=async()=>{throw Error('Unexpected business fetch');};w.WebSocket=class{};
 w.__TD_PREVIEW_BOOT__={origin:state.ownerOrigin,origins:[state.serviceOrigin],defaultRoute:0,connection:state.connection,nativeTerminal:true,platform:'darwin',version:'0.1.0'};
 w.__TAURI_INTERNALS__={invoke:async(_command,{op,args})=>{
  if(op==='saveConnection'){savedConnection=args.connection;return null;}
  if(op!=='nativeTerminal')throw Error('Unexpected bridge operation');calls.push(args.action);
  if(args.action==='create'){if(active)history.add(active);active=`owned-${++serial}`;return{token:active,epoch:'new-page'};}
  if(args.action==='layout')return{complete:true,token:active,epoch:'new-page'};
  if(args.action==='inspect')return{surfaces:active?1:0,mainThread:true};
  if(args.action==='retireView'){
   const base={token:args.token,epoch:'new-page',view:args.view};
   if(!active){if(!history.has(args.token))throw Error('Unknown absent owner');return{...base,detached:true,disposition:'absent'};}
   if(args.token===active){history.add(active);active=null;return{...base,detached:true,disposition:'current'};}
   if(history.has(args.token))return{...base,detached:false,disposition:'superseded',replacementToken:active};
   throw Error('Unknown owner');
  }
  throw Error('Unexpected native operation');
 }};
 w.eval(fs.readFileSync(new URL('./bridge.js',import.meta.url),'utf8'));
 const scopeSource=fs.readFileSync(new URL('../../src/lib/federation/clientScope.ts',import.meta.url),'utf8');
 w.module={exports:{}};w.exports=w.module.exports;w.eval(transformSync(scopeSource,{loader:'ts',format:'cjs',target:'es2020'}).code);const scope=w.module.exports;
 const observer=new w.MutationObserver(()=>{if(!w.__TD_NATIVE_GATE_WIRE)return;const wire=JSON.parse(w.__TD_NATIVE_GATE_WIRE);snapshot=wire.data;if(wire.kind==='progress'&&snapshot.phase==='normal-login-form-submit-ready')w.__TD_NATIVE_GATE_STAGE_RECEIPT={nonce:wire.nonce,pageEpoch:snapshot.pageEpoch,index:snapshot.progressIndex};});
 observer.observe(w.document.head,{subtree:true,childList:true,characterData:true});
 if(stage==='first'){
  w.document.querySelector('button').addEventListener('click',()=>w.setTimeout(()=>{w.document.body.innerHTML='<form><input type="password"><button>登录并连接</button></form>';},10));
  w.document.addEventListener('submit',event=>{event.preventDefault();void(async()=>{await w.termdockDesktop.saveServiceConnection(state.acceptedConnection);scope.saveSelectedTarget(state.acceptedConnection);submitted=true;})();});
 }
 const receipt=w.eval(fs.readFileSync(scriptPath,'utf8'));
 if(!receipt.evalCompleted)throw Error('Generated script evaluation failed');
 const deadline=Date.now()+2000;while(stage==='first'?!(submitted||snapshot?.finished):!snapshot?.finished){if(Date.now()>deadline)throw Error('Generated receiver did not settle');await new Promise(resolve=>setTimeout(resolve,5));}
 process.stdout.write(JSON.stringify({snapshot,savedConnection,submitted,calls,active,storage:Object.fromEntries(Array.from({length:w.sessionStorage.length},(_,i)=>{const key=w.sessionStorage.key(i);return[key,w.sessionStorage.getItem(key)];})),bridgePeerPresent:!!(await w.termdockDesktop.getServiceConnection()).targetPeerId,bootRemoved:!Object.hasOwn(w,'__TD_PREVIEW_BOOT__'),ownerDiffersFromService:state.ownerOrigin!==state.serviceOrigin}));
 observer.disconnect();
}finally{w.close();}
