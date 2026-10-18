/** Test-only real Node/Noise peer. Isolated directories and listeners, no daemon. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import vm from 'node:vm';
import express from 'express';
import { WebSocket as NodeSocket, WebSocketServer } from 'ws';
import { createFederationRuntime } from '../../src/server/federation/runtime.ts';
import { createIdentity } from '../../src/server/federation/secureProtocol.ts';
import { RelayRouter } from '../../src/server/federation/relay.ts';
import { connect } from '../../src/lib/federation/secureClient.ts';
import { createRelaySocketFactory } from '../../src/lib/federation/relaySocket.ts';
const dirs: string[] = [], cleanups: Array<() => void> = [], wire: Buffer[] = [];
let ordinaryBusinessRequests=0;
async function peer(options: object = {}) {
  const dir=mkdtempSync(join(tmpdir(),'td-preview-noise-')); dirs.push(dir);
  let publicPort = 0;
  const app=express(); app.get('/',(_req,res)=>res.type('html').send('<html>existing service frontend</html>'));
  app.get('/api/meta',(_req,res)=>res.json({product:'termdock'}));
  app.use((req,_res,next)=>{ if(req.path.startsWith('/api/terminal') && req.socket.localPort === publicPort) ordinaryBusinessRequests++; next(); });
  app.get('/api/terminal/:session/health',(req,res)=>res.json({session:req.params.session,output:'private-output-unique'}));
  app.post('/api/terminal/fs/upload',async(req,res)=>{let size=0;for await(const chunk of req)size+=chunk.length;res.json({bytes:size});});
  const runtime=await createFederationRuntime(app,dir,{terminal(socket){socket.on('message',data=>socket.send(String(data)));},control(){}},options);
  const server=createServer(app), ws=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{
    if(req.url?.startsWith('/api/federation/secure')) {
      const ownOrigin=`http://${req.headers.host}`;
      if(req.headers.origin!==undefined) assert.equal(req.headers.origin,ownOrigin);
      assert.equal(req.headers.cookie,undefined); assert.equal(req.headers.authorization,undefined);
      ws.handleUpgrade(req,socket,head,s=>{s.on('message',data=>wire.push(Buffer.from(data as Buffer)));void runtime.accept(s,{allowOpenAccess:req.headers.origin===ownOrigin});});
    }
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as {port:number}).port; publicPort = port;
  cleanups.push(()=>{runtime.close();for(const socket of ws.clients)socket.terminate();ws.close();server.close();});
  return {runtime,server,ws,url:`http://127.0.0.1:${port}`,code:JSON.parse(readFileSync(join(dir,'pairing.json'),'utf8')).pairingCode};
}
try {
  const target=await peer();
  const tickets=new Map<string,{subject:string;target:string}>();
  const entry=await peer({hasRouteGrant:(_subject:string,id:string)=>id===target.runtime.serviceId,issueRouteTicket:(subject:string,id:string)=>{
    const token=crypto.randomUUID();tickets.set(token,{subject,target:id});return{routeToken:token,expiresAt:Date.now()+30000};
  }});
  const router=new RelayRouter<{subject:string;target:string}>({authenticate:context=>context as {subject:string;target:string},allowRegister:()=>false,allowRoute:(p,id)=>p.target===id});
  router.registerDirect(target.runtime.serviceId,async()=>{
    const socket=new NodeSocket(`${target.url.replace('http:','ws:')}/api/federation/secure`);await once(socket,'open');return socket;
  });
  cleanups.push(()=>router.close());
  entry.server.on('upgrade',(req,socket,head)=>{
    const url=new URL(req.url!,entry.url);if(url.pathname!=='/api/federation/relay')return;
    const ticket=tickets.get(url.searchParams.get('routeToken')||'');
    assert(ticket);assert.equal(req.headers.origin,undefined);
    entry.ws.handleUpgrade(req,socket,head,ws=>{void router.attach(ws,ticket).then(ok=>{if(ok)ws.send(JSON.stringify({type:'ready'}));});});
  });
  process.stdout.write(JSON.stringify({targetUrl:target.url,targetPeerId:target.runtime.serviceId,entryUrl:entry.url,entryPeerId:entry.runtime.serviceId})+'\n');
  const lines=createInterface({input:process.stdin});
  const [line]=await once(lines,'line');lines.close();
  const boot=JSON.parse(line);
  const events=new EventTarget();
  class LocalSocket extends NodeSocket {
    constructor(url:string,protocols?:string|string[]) { super(url,protocols,{headers:{Origin:boot.origin,Cookie:boot.cookie}}); }
  }
  const context={window:null as unknown,location:{origin:boot.origin,pathname:'/',hash:''},navigator:{},sessionStorage:{setItem(){}},URL,Request,Response,Uint8Array,Promise,Object,Set,String,JSON,TypeError,Error};
  const window={__TD_PREVIEW_BOOT__:{...boot,connection:{url:entry.url,serviceOrigin:target.url,targetPeerId:target.runtime.serviceId,entryServiceId:entry.runtime.serviceId,label:'target'},version:'0.1.0',platform:'linux'},top:null as unknown,WebSocket:LocalSocket,fetch:globalThis.fetch,addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)};
  window.top=window;context.window=window;vm.runInNewContext(readFileSync(new URL('../renderer/bridge.js',import.meta.url),'utf8'),context);
  Object.defineProperty(globalThis,'WebSocket',{value:window.WebSocket,configurable:true});
  Object.defineProperty(globalThis,'CloseEvent',{value:class extends Event{code:number;reason:string;wasClean:boolean;constructor(type:string,init:any){super(type);Object.assign(this,init);}},configurable:true});
  // Match the production open-service contract: a fresh device needs no
  // password or persisted grant, but the selected service's Origin is required.
  const openIdentity=await createIdentity();
  const openClient=await connect({url:`${target.url.replace('http:','ws:')}/api/federation/secure`,targetPeerId:target.runtime.serviceId,identity:openIdentity});
  const openPermissions=await openClient.request({type:'permissions'});
  assert.equal(openPermissions.fullService,true);assert(Array.isArray(openPermissions.grants));assert.equal(openPermissions.grants.length,0);
  assert.equal((await(await openClient.fetch('/api/terminal/open/health')).json()).session,'open');
  openClient.close();
  const originless=await connect({url:`${target.url.replace('http:','ws:')}/api/federation/secure`,targetPeerId:target.runtime.serviceId,identity:openIdentity,socketFactory:url=>new NodeSocket(url) as unknown as WebSocket});
  assert.equal((await originless.request({type:'permissions'})).fullService,false);
  originless.close();
  const identity=await createIdentity();
  const direct=await connect({url:`${target.url.replace('http:','ws:')}/api/federation/secure`,targetPeerId:target.runtime.serviceId,identity,pairingCode:target.code});
  const response=await direct.fetch('/api/terminal/one/health');assert.equal((await response.json()).output,'private-output-unique');
  const upload=await direct.fetch('/api/terminal/fs/upload',{method:'POST',body:new Uint8Array(128*1024)});assert.equal((await upload.json()).bytes,128*1024);
  const socket=direct.openSocket('/api/terminal/one/ws');
  await new Promise<void>((resolve,reject)=>{socket.addEventListener('open',()=>resolve(),{once:true});socket.addEventListener('error',()=>reject(Error('socket failed')),{once:true});});
  const output=new Promise<MessageEvent>(resolve=>socket.addEventListener('message',event=>resolve(event as MessageEvent),{once:true}));
  socket.send(JSON.stringify({type:'input',data:'private-input-unique'}));assert.equal(JSON.parse((await output).data).data,'private-input-unique');socket.close();direct.close();
  const entryClient=await connect({url:`${entry.url.replace('http:','ws:')}/api/federation/secure`,targetPeerId:entry.runtime.serviceId,identity,pairingCode:entry.code});
  const ticket=await entryClient.request({type:'route-ticket',serviceId:target.runtime.serviceId});
  const relay=await connect({url:`${entry.url.replace('http:','ws:')}/api/federation/relay?routeToken=${ticket.routeToken}`,targetPeerId:target.runtime.serviceId,identity,socketFactory:createRelaySocketFactory(target.runtime.serviceId)});
  assert.equal((await(await relay.fetch('/api/terminal/two/health')).json()).session,'two');
  relay.close();entryClient.close();
  const reconnect=await connect({url:`${target.url.replace('http:','ws:')}/api/federation/secure`,targetPeerId:target.runtime.serviceId,identity});
  assert.equal((await(await reconnect.fetch('/api/terminal/reconnected/health')).json()).session,'reconnected');reconnect.close();
  assert(!Buffer.concat(wire).includes(Buffer.from('private-input-unique')));assert(!Buffer.concat(wire).includes(Buffer.from('private-output-unique')));
  // The private listener handles business after decryption; the public Node
  // frontend listener and loopback boundary must never receive business HTTP.
  assert.equal(ordinaryBusinessRequests,0);
  await assert.rejects(window.fetch(`${boot.origin}/api/terminal/one/health`));
  process.stdout.write(JSON.stringify({ok:true,checks:['real Noise direct','encrypted terminal input/output','streamed encrypted upload','entry secure route ticket','target Noise over relay','same device reconnect','no plaintext business fallback']})+'\n');
} catch(error) { console.error(error);process.exitCode=1; }
finally { for(const close of cleanups.reverse())close();for(const dir of dirs)rmSync(dir,{recursive:true,force:true}); }
