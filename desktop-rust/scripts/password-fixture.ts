/** Real unchanged HTTP OPAQUE router + page device identity + subsequent Noise. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import express from 'express';
import {WebSocket as NodeSocket,WebSocketServer} from 'ws';
import {IDBFactory} from 'fake-indexeddb';
import {createFederationRuntime} from '../../src/server/federation/runtime.ts';
import {TERMDOCK_PROTOCOL_VERSION,TERMDOCK_CAPABILITIES,getTermdockVersion} from '../../src/server/utils/version.ts';
import {createPasswordLoginRouter} from '../../src/server/federation/passwordLoginRoutes.ts';
import {startPasswordBootstrap,finishPasswordBootstrap} from '../../src/server/federation/passwordBootstrap.ts';
import {getIdentity} from '../../src/lib/federation/deviceIdentity.ts';
process.env.TERMDOCK_PASSWORD='existing-preview-fixture-password';
delete process.env.TERMDOCK_PUBLIC_ORIGIN;
const directory=mkdtempSync(join(tmpdir(),'td-preview-password-'));
const app=express();let publicPort=0,ordinary=0;const origins:string[]=[],wire:Buffer[]=[];
app.get('/',(_req,res)=>res.type('html').send('<html>old service page</html>'));
app.get('/api/auth/open/parameters',(_req,res)=>res.status(403).json({error:'Password required'}));
app.get('/api/auth/status',(_req,res)=>res.json({enabled:true,authenticated:false}));
app.get('/api/meta',(_req,res)=>res.json({product:'termdock',version:getTermdockVersion(),protocolVersion:TERMDOCK_PROTOCOL_VERSION,capabilities:TERMDOCK_CAPABILITIES}));
app.use((req,_res,next)=>{if(req.path.startsWith('/api/auth/password')){origins.push(String(req.headers.origin||''));assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.authorization,undefined);}if(req.path.startsWith('/api/terminal')&&req.socket.localPort===publicPort)ordinary++;next();});
app.get('/api/terminal/:session/health',(req,res)=>res.json({session:req.params.session,output:'encrypted-after-password'}));
const runtime=await createFederationRuntime(app,directory,{terminal(){},control(){}});
app.use('/api/auth/password',createPasswordLoginRouter(()=>runtime));
const server=createServer(app),ws=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{assert.equal(req.headers.origin,`http://${req.headers.host}`);assert.equal(req.headers.cookie,undefined);ws.handleUpgrade(req,socket,head,client=>{client.on('message',data=>wire.push(Buffer.from(data as Buffer)));void runtime.accept(client,{allowOpenAccess:false});});});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target=`http://127.0.0.1:${(server.address() as {port:number}).port}`;publicPort=new URL(target).port as unknown as number;
let integration:any;
try {
 process.stdout.write(JSON.stringify({url:target})+'\n');
 const lines=createInterface({input:process.stdin});const [line]=await once(lines,'line');lines.close();const boot=JSON.parse(line);
 publicPort=(server.address() as {port:number}).port;
 class Storage {
  data=new Map<string,string>();get length(){return this.data.size;}key(index:number){return [...this.data.keys()][index]||null;}
  getItem(key:string){return this.data.get(key)||null;}setItem(key:string,value:string){this.data.set(key,String(value));}removeItem(key:string){this.data.delete(key);}
 }
 const localStorage=new Storage(),sessionStorage=new Storage();
 let finishReload:()=>void;let reloads=0;const reloaded=new Promise<void>(resolve=>finishReload=resolve);
 const location={origin:boot.origin,host:new URL(boot.origin).host,hostname:'127.0.0.1',href:boot.origin+'/',pathname:'/',search:'',hash:'',reload(){reloads++;finishReload();}};
 const events=new EventTarget(),saved:any[]=[];
 const rawFetch=globalThis.fetch;
 class LocalSocket extends NodeSocket { constructor(url:string,protocols?:any){super(url,protocols,{headers:{Origin:boot.origin,Cookie:boot.cookie}});} }
 const window:any={__TD_PREVIEW_BOOT__:{...boot,connection:{id:target,url:target,label:'Old password service'},version:'0.1.0',platform:'linux'},top:null,parent:null,WebSocket:LocalSocket,localStorage,sessionStorage,crypto:globalThis.crypto,location,fetch:async(input:any,init:any={})=>{const url=new URL(typeof input==='string'?input:input.url,boot.origin);return rawFetch(url,{...init,headers:{...init.headers,Cookie:boot.cookie}});},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),__TAURI_INTERNALS__:{invoke:async(_command:any,{op,args}:any)=>{if(op==='connections')return saved;if(op==='saveConnection'||op==='importConnection'){saved.splice(0,saved.length,args.connection);return saved;}throw Error('Unexpected native request '+op);}}};
 window.top=window;window.parent=window;
 const navigator={onLine:true,serviceWorker:Object.assign(new EventTarget(),{controller:null})};
 vm.runInNewContext(readFileSync(new URL('../renderer/bridge.js',import.meta.url),'utf8'),{window,location,navigator,sessionStorage,Request,Response,URL,TypeError,Error,Uint8Array,Promise,Object,Set,String,JSON});
 Object.assign(globalThis,{window,location,Storage,localStorage,sessionStorage,indexedDB:new IDBFactory(),WebSocket:window.WebSocket});
 Object.defineProperty(globalThis,"navigator",{value:navigator,configurable:true});
 Object.defineProperty(globalThis,'fetch',{value:window.fetch,configurable:true,writable:true});
 Object.defineProperty(globalThis,'CloseEvent',{value:class extends Event{constructor(type:string,init:any){super(type);Object.assign(this,init);}},configurable:true});
 integration=await import('../../src/lib/federation/browserIntegration.ts');
 // The same fixture process also hosts the old daemon. Preserve its ordinary
 // private-listener fetch after the page captures its transport wrapper.
 Object.defineProperty(globalThis,'fetch',{value:rawFetch,configurable:true,writable:true});
 integration.installEncryptedFetch();
 const originalIdentity=await getIdentity();
 assert.equal(integration.savedConnection(),null);
 assert.deepEqual(await integration.connectServiceAddress(target),{passwordRequired:true});
 await assert.rejects(integration.connectServiceAddress(target,'wrong-password'));
 assert.equal(runtime.store.authorize({subjectId:originalIdentity.peerId,serviceId:runtime.serviceId,action:'service:*'}).allowed,false);
 assert.equal(integration.savedConnection(),null);
 const login=integration.connectServiceAddress(target,'existing-preview-fixture-password');
 await Promise.race([login,reloaded]);assert.equal(reloads,1); // Existing automatic storage-scope reload, no manual switching.
 assert.equal((await getIdentity()).peerId,originalIdentity.peerId);
 assert.equal(integration.savedConnection().targetPeerId,runtime.serviceId);
 assert.equal(integration.savedConnection().serviceOrigin,target);
 const client=integration.currentSecureClient();assert(client);
 assert.equal((await(await client.fetch('/api/terminal/session/health')).json()).output,'encrypted-after-password');
 assert.equal(ordinary,0);
 assert(origins.filter(Boolean).every(value=>value===target));
 assert(wire.every(bytes=>!bytes.includes(Buffer.from('existing-preview-fixture-password'))&&!bytes.includes(Buffer.from('encrypted-after-password'))));
 // Start/finish remain bound by the unchanged old router. A proof replay must fail.
 const route=`${boot.origin}/__td_route/0/api/auth/password`;
 const headers={Cookie:boot.cookie,'Content-Type':'application/json'};
 const params=await(await rawFetch(route+'/parameters',{headers})).json();
 const state=await startPasswordBootstrap('existing-preview-fixture-password',params.saltHex);
 const started=await(await rawFetch(route+'/start',{method:'POST',headers,body:JSON.stringify({clientIdentity:originalIdentity.peerId,startLoginRequest:state.startLoginRequest})})).json();
 const proof=await finishPasswordBootstrap(state,started,{clientIdentity:originalIdentity.peerId,origin:target});
 const body=JSON.stringify({attemptId:proof.attemptId,finishLoginRequest:proof.finishLoginRequest});
 assert.equal((await rawFetch(route+'/finish',{method:'POST',headers,body})).status,200);
 assert.equal((await rawFetch(route+'/finish',{method:'POST',headers,body})).status,401);
 const plaintext=await rawFetch(route+'/start',{method:'POST',headers,body:JSON.stringify({password:'never-forward',clientIdentity:originalIdentity.peerId,startLoginRequest:'invalid'})});assert.equal(plaintext.status,400);
 assert.equal((await rawFetch(boot.origin+'/api/terminal/fs/upload',{method:'POST',headers,body:'plaintext'})).status,403);
 process.stdout.write(JSON.stringify({ok:true,checks:['unchanged old router','URL-only no peer ID','first load without SW','real OPAQUE wrong password no grant','same IndexedDB device after correct proof','subsequent real Noise business','native Origin=approved upstream','replay denied','no ordinary business HTTP']})+'\n');
} catch(error){console.error(error);process.exitCode=1;}
finally {integration?.invalidateSecureTransport();runtime.close();for(const client of ws.clients)client.terminate();ws.close();server.close();rmSync(directory,{recursive:true,force:true});}
