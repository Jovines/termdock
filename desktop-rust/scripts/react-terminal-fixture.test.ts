import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {createServer} from 'node:http';
import express from 'express';
import type {WebSocket} from 'ws';
import {createReactTerminalFixture} from './react-terminal-fixture';
class LogicalProbe extends EventEmitter {
 readyState=1;frames:any[]=[];
 send(data:string){this.frames.push(JSON.parse(data));}
 close(){this.readyState=3;this.emit('close');}
 socket(){return this as unknown as WebSocket;}
 input(value:unknown){this.emit('message',JSON.stringify(value));}
}
async function fixture(run:(model:ReturnType<typeof createReactTerminalFixture>,request:(action:string)=>Promise<any>)=>Promise<void>){
 const model=createReactTerminalFixture(),app=express();model.install(app);const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{await run(model,async action=>{const response=await fetch(origin+'/api/terminal/test-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});assert.equal(response.status,200);return response.json();});}
 finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
test('owned backend model replays only the unconsumed suffix and keeps real client ACK fields',async()=>{
 await fixture(async(model,request)=>{
  const first=new LogicalProbe();model.terminal(first.socket(),model.inspect().backend,'c',{});await Promise.resolve();
  assert.equal(first.frames[0].replayChunks[0],'\x1bccontrolled React baseline 中\r\n');
  first.input({type:'output-ack',flowSeq:2,since:2,epoch:'controlled-stream-a'});assert.equal(model.inspect().events.at(-1)?.type,'output-ack');
  await request('disconnect');assert.equal(first.readyState,3);assert(!first.frames.some(frame=>frame.data?.includes('disconnected suffix')));
  const second=new LogicalProbe();model.terminal(second.socket(),model.inspect().backend,'c',{sinceSeq:2,streamEpoch:'controlled-stream-a'});assert.deepEqual(second.frames[0].replayChunks,['controlled disconnected suffix\r\n']);second.close();
 });
});
test('epoch/backend changes stop delivering new output to old socket owners',async()=>{
 await fixture(async(model,request)=>{
  const old=new LogicalProbe();model.terminal(old.socket(),model.inspect().backend,'c',{});await Promise.resolve();const count=old.frames.length;
  await request('backend');await request('output');assert.equal(old.frames.length,count);old.input({type:'input',data:'old'});assert.equal(model.inspect().events.at(-1)?.type,'stale-client-message');
  const next=new LogicalProbe();model.terminal(next.socket(),model.inspect().backend,'c',{sinceSeq:2,streamEpoch:'controlled-stream-a'});assert.equal(next.frames[0].replayOutOfWindow,true);assert(next.frames[0].replayChunks[0].includes('backend B baseline'));old.close();next.close();
 });
});
test('normal input/resize and inventory deletion produce bounded model records without a PTY',async()=>{
 await fixture(async(model,request)=>{
  const socket=new LogicalProbe();model.terminal(socket.socket(),model.inspect().backend,'c',{});await Promise.resolve();socket.input({type:'resize',cols:100,rows:30,seq:7});socket.input({type:'input',data:'owned'});
  assert(socket.frames.some(frame=>frame.type==='resize-ack'&&frame.seq===7));assert(model.inspect().events.some(event=>event.type==='input'&&event.data==='owned'));await request('inventory-delete');assert.equal(model.inspect().inventory.clientSessions.length,0);socket.close();
 });
});
test('opt-in benchmark output has fixed bounded profiles and exposes sequence receipts without a PTY',async()=>{
 assert.throws(()=>createReactTerminalFixture({benchmarkOutput:true}),/encrypted-request verifier/);
 const model=createReactTerminalFixture({benchmarkOutput:true,authorized:()=>true}),app=express();model.install(app);const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const socket=new LogicalProbe();model.terminal(socket.socket(),model.inspect().backend,'owned',{});await Promise.resolve();
  const request=(action:string,extra:Record<string,unknown>={})=>fetch(origin+'/api/terminal/test-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...extra})});
  assert.equal((await request('benchmark-output',{profile:'fast',runId:'invalid'})).status,400);
  const start=await(await request('benchmark-output',{profile:'burst',runId:'paired-1'})).json(),state=start.benchmark;
  assert.equal(state.runId,'paired-1');assert.equal(state.profile,'burst');assert.equal(state.done,false);assert.equal(state.expectedChunks,16);assert.equal(state.expectedBytes,4_193_280);assert.equal(state.epoch,'controlled-stream-a');
  const status=await(await request('benchmark-status')).json();assert.equal(status.benchmark.runId,'paired-1');assert.equal(status.benchmark.done,false);assert.equal(status.benchmark.lastSeq,state.lastSeq);
  assert.equal((await request('benchmark-output',{profile:'burst',runId:'overlap'})).status,409);
  let complete:any=null;const deadline=Date.now()+5000;
  while(Date.now()<deadline){const value=await(await request('benchmark-status')).json();if(value.benchmark.done){complete=value;break;}await new Promise(resolve=>setTimeout(resolve,25));}
  assert(complete,'Controlled burst did not finish');const result=complete.benchmark;
  assert.equal(result.runId,'paired-1');assert.equal(result.bytes,result.expectedBytes);assert.equal(result.chunks,result.expectedChunks);assert.equal(result.lastSeq,complete.sequence);
  const burst=socket.frames.filter(frame=>frame.type==='data'&&frame.seq>state.lastSeq);assert.equal(burst.length,result.expectedChunks);assert.equal(burst.reduce((total,frame)=>total+Buffer.byteLength(frame.data),0),result.expectedBytes);
  socket.input({type:'output-ack',flowSeq:result.lastSeq,since:result.lastSeq,epoch:result.epoch});assert(model.inspect().events.some(event=>event.type==='output-ack'&&event.flowSeq===result.lastSeq&&event.since===result.lastSeq&&event.epoch===result.epoch));
  socket.close();
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('opt-in update model enforces authenticated forwarder semantics and inert responses without a restart',async()=>{
 let authorized=false;const model=createReactTerminalFixture({userFixes:true,authorized:()=>authorized}),app=express();model.install(app);const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  assert.equal((await (await fetch(origin+'/api/terminal/update')).json()).status,'ready');
  assert.equal((await fetch(origin+'/api/terminal/update/restart',{method:'POST'})).status,403);
  authorized=true;assert.equal((await (await fetch(origin+'/api/csrf-token')).json()).csrfToken,'controlled-update-csrf');
  const submit=()=>fetch(origin+'/api/terminal/update/restart',{method:'POST'});
  const failed=await submit();assert.equal(failed.status,503);assert.equal((await failed.json()).error,'Controlled restart failure');
  await fetch(origin+'/api/terminal/test-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'allow-controlled-update'})});
  assert.equal((await (await submit()).json()).status,'restarting');
  assert.deepEqual(model.inspect().events.filter(e=>e.type==='controlled-restart-request').map(e=>[e.encrypted,e.csrfOmitted,e.allowed]),[[false,true,false],[true,true,false],[true,true,true]]);
  assert.equal(createReactTerminalFixture().inspect().userFixes,false);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('interactions filesystem/health/update routes are explicit inert authenticated models and absent by default',async()=>{
 assert.throws(()=>createReactTerminalFixture({interactions:true}),/verifier/);let authorized=false;
 const model=createReactTerminalFixture({interactions:true,authorized:()=>authorized}),app=express();model.install(app);const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const inbox='/api/terminal/operations/collaboration-tasks';assert.equal((await fetch(origin+inbox)).status,403);authorized=true;assert.deepEqual(await (await fetch(origin+inbox)).json(),{tasks:[]});authorized=false;
  const preview='/api/terminal/fs/read?path=%2Fcontrolled%2Fowned.txt&action=view_file';
  assert.equal((await fetch(origin+preview)).status,403);authorized=true;
  const previewResponse=await fetch(origin+preview);assert.equal(previewResponse.status,200);const content=await previewResponse.json();
  assert.equal(content.path,'/controlled/owned.txt');assert.equal(content.content,'Owned file preview\nFixed local fixture content.\nNo user filesystem or PTY.\n');assert.equal(content.size,Buffer.byteLength(content.content));
  assert.equal((await fetch(origin+preview.replace('&action=view_file',''))).status,200);
  assert.equal((await fetch(origin+preview.replace('owned.txt','other.txt'))).status,404);
  assert.equal((await fetch(origin+preview.replace('view_file','other_action'))).status,404);authorized=false;
  const path='/api/terminal/fs/file?path=%2Fcontrolled%2Fowned.txt&confirm=true';assert.equal((await fetch(origin+path,{method:'DELETE'})).status,403);authorized=true;
  const listing=await (await fetch(origin+'/api/terminal/fs/list?path=%2Fcontrolled')).json();assert.equal(listing.entries[0].path,'/controlled/owned.txt');
  const response=await fetch(origin+path,{method:'DELETE'});assert.equal(response.status,503);assert.match((await response.json()).error,/Controlled file deletion/);
  assert.equal((await fetch(origin+'/api/terminal/server-health/dismiss',{method:'POST'})).status,503);
  assert.equal((await (await fetch(origin+'/api/terminal/update')).json()).status,'current');assert.equal((await (await fetch(origin+'/api/terminal/update')).json()).status,'current');
  authorized=false;assert.equal((await fetch(origin+'/api/terminal/update/check',{method:'POST'})).status,403);authorized=true;
  assert.equal((await fetch(origin+'/api/terminal/update/check',{method:'POST',headers:{'X-XSRF-TOKEN':'controlled'}})).status,403);
  const check=await fetch(origin+'/api/terminal/update/check',{method:'POST'});assert.equal(check.status,503);assert.match((await check.json()).error,/Controlled service update check failure/);
  assert.deepEqual(model.inspect().events.filter(e=>e.type==='controlled-update-check').map(e=>[e.method,e.encrypted,e.csrfOmitted,e.realUpdate]),[['POST',false,true,false],['POST',true,false,false],['POST',true,true,false]]);
  const requests=model.inspect().events.filter(e=>e.type==='controlled-file-delete');assert.deepEqual(requests.map(e=>[e.encrypted,e.csrfOmitted,e.realFilesystem]),[[false,true,false],[true,true,false]]);assert.equal(createReactTerminalFixture().inspect().interactions,false);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('native feedback creates a second owned session only on its explicit model action and gives it independent stream ACKs',async()=>{
 assert.throws(()=>createReactTerminalFixture({nativeFeedback:true}),/verifier/);
 const model=createReactTerminalFixture({nativeFeedback:true,interactions:true,authorized:()=>true}),app=express();model.install(app);const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  assert.equal(model.inspect().inventory.clientSessions.length,1);
  const added=await (await fetch(origin+'/api/terminal/test-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'feedback-add-session'})})).json();assert.equal(added.inventory.clientSessions.length,2);
  const opened=await (await fetch(origin+'/api/terminal/session-inventory/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preferredFrontendSessionId:added.extraFrontend,requireExisting:true})})).json();assert.equal(opened.terminalSession.sessionId,added.extraBackend);
  const socket=new LogicalProbe();model.terminal(socket as unknown as WebSocket,added.extraBackend,'owned',{sinceSeq:0});await Promise.resolve();assert.equal(socket.frames[0].streamEpoch,'controlled-stream-second');
  assert.equal(socket.frames[1].type,'data');assert.equal(socket.frames[1].seq,2);assert.equal(model.inspect().events.filter(event=>event.type==='output-ack'&&event.backend===added.extraBackend).length,0);
  const telemetry=model.inspect().events.filter(event=>String(event.type).startsWith('second-frame-'));assert.deepEqual(telemetry.map(event=>[event.type,event.phase]),[['second-frame-send-start','connected'],['second-frame-send-return','connected'],['second-frame-send-start','data'],['second-frame-send-return','data']]);assert(telemetry.every(event=>!('data'in event)&&!('replayChunks'in event)));
  socket.emit('message',JSON.stringify({type:'output-ack',flowSeq:2,since:2,epoch:'controlled-stream-second'}));assert(model.inspect().events.some(event=>event.type==='output-ack'&&event.backend===added.extraBackend&&event.since===2));
  assert.equal(createReactTerminalFixture().inspect().nativeFeedback,false);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('second stream records a closed-before-microtask skip without a false send-return or ACK',async()=>{
 const model=createReactTerminalFixture({nativeFeedback:true,interactions:true,authorized:()=>true}),app=express();model.install(app);const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const added=await(await fetch(origin+'/api/terminal/test-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'feedback-add-session'})})).json();
  const socket=new LogicalProbe();model.terminal(socket.socket(),added.extraBackend,'owned',{});socket.close();await Promise.resolve();
  assert.equal(socket.frames.length,1);const events=model.inspect().events;const skipped=events.find(event=>event.type==='second-frame-skip');assert.equal(skipped?.phase,'data');assert.equal(skipped?.readyState,3);assert.equal(skipped?.reason,'socket-not-open');assert.equal(skipped?.seq,2);
  assert(!events.some(event=>event.type==='second-frame-send-return'&&event.phase==='data'));assert(!events.some(event=>event.type==='output-ack'));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('three native inputs retain backend ownership through first and second session deletion',async()=>{
 let authorized=false;
 const model=createReactTerminalFixture({nativeInput:true,interactions:true,authorized:req=>req.header('X-Controlled-Encrypted')==='yes'}),app=express();model.install(app);const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const request=async(path:string,init:RequestInit={})=>fetch(origin+path,{...init,headers:{...(init.headers as Record<string,string>|undefined),...(authorized?{'X-Controlled-Encrypted':'yes'}:{})}});
 try{
  assert.equal((await request('/api/terminal/test-health')).status,403);
  authorized=true;
  await request('/api/terminal/test-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'feedback-add-session'})});
  const added=await(await request('/api/terminal/test-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'feedback-add-three-sessions'})})).json();
  assert.equal(added.inputRouting,true);
  assert.deepEqual(added.inventory.clientSessions.map((session:any)=>session.backendSessionId),[model.inspect().backend,added.extraBackend,added.thirdBackend]);
  const records=[
   {frontend:added.frontend,backend:model.inspect().backend,socket:new LogicalProbe(),marker:'termdock-input-first'},
   {frontend:added.extraFrontend,backend:added.extraBackend,socket:new LogicalProbe(),marker:'termdock-input-second'},
   {frontend:added.thirdFrontend,backend:added.thirdBackend,socket:new LogicalProbe(),marker:'termdock-input-third'},
  ];
  for(const record of records){model.terminal(record.socket.socket(),record.backend,'owned',{});await Promise.resolve();}
  for(const record of records){
   record.socket.input({type:'focus',focused:true});
   const focus=model.inspect().events.filter(event=>(event.type==='focus'||event.type==='second-client-state')&&event.backend===record.backend&&event.focused===true);
   assert.equal(focus.length,1,`focus true must be recorded for ${record.backend}`);
   record.socket.input({type:'input',data:record.marker});
   const matches=model.inspect().events.filter(event=>event.type==='input'&&event.data===record.marker);
   assert.deepEqual(matches.map(event=>[event.backend,event.frontend,event.bytes,event.receipt]),[[record.backend,record.frontend,Buffer.byteLength(record.marker),'controlled-terminal-input-v1']]);
  }
  const remove=async(record:typeof records[number])=>{
   assert.equal((await request(`/api/terminal/${record.backend}`,{method:'DELETE'})).status,200);
   const response=await request(`/api/terminal/session-inventory/sessions/${record.frontend}`,{method:'DELETE'});assert.equal(response.status,200);
   return response.json();
  };
  let remaining=await remove(records[0]);assert.deepEqual(remaining.clientSessions.map((session:any)=>session.backendSessionId),[records[1].backend,records[2].backend]);
  records[0].socket.input({type:'input',data:'termdock-stale-first'});
  remaining=await remove(records[1]);assert.deepEqual(remaining.clientSessions.map((session:any)=>session.backendSessionId),[records[2].backend]);
  records[1].socket.input({type:'input',data:'termdock-stale-second'});
  const eventOffset=model.inspect().events.length;
  records[2].socket.input({type:'input',data:'termdock-input-third-after-removal'});
  const events=model.inspect().events,tail=events.slice(eventOffset),third=tail.filter(event=>event.type==='input');
  assert.equal(records[2].socket.readyState,1);
  assert.deepEqual(third.map(event=>[event.backend,event.frontend,event.data,event.bytes,event.receipt]),[[records[2].backend,records[2].frontend,'termdock-input-third-after-removal',Buffer.byteLength('termdock-input-third-after-removal'),'controlled-terminal-input-v1']]);
  assert.deepEqual(events.filter(event=>event.type==='stale-client-message'&&event.messageType==='input').map(event=>event.backend),[records[0].backend,records[1].backend]);
  assert.equal(createReactTerminalFixture().inspect().nativeFeedback,false);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('connected telemetry preserves the original unconditional send and propagates its original error',async()=>{
 const model=createReactTerminalFixture({nativeFeedback:true,interactions:true,authorized:()=>true}),app=express();model.install(app);const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const added=await(await fetch(origin+'/api/terminal/test-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'feedback-add-session'})})).json();
  const nonOpen=new LogicalProbe();nonOpen.readyState=3;model.terminal(nonOpen.socket(),added.extraBackend,'owned',{});await Promise.resolve();assert.equal(nonOpen.frames.length,1);assert.equal(nonOpen.frames[0].type,'connected');
  const events=model.inspect().events;assert(events.some(event=>event.type==='second-frame-send-start'&&event.phase==='connected'&&event.readyState===3));assert(!events.some(event=>event.type==='second-frame-skip'&&event.phase==='connected'));assert(events.some(event=>event.type==='second-frame-skip'&&event.phase==='data'&&event.readyState===3));
  const original=Error('owned synthetic send failure');const throwing=new LogicalProbe();throwing.send=()=>{throw original;};const start=model.inspect().events.length;
  assert.throws(()=>model.terminal(throwing.socket(),added.extraBackend,'owned',{}),error=>error===original);
  const tail=model.inspect().events.slice(start);assert(tail.some(event=>event.type==='second-frame-send-error'&&event.phase==='connected'&&event.errorKind==='Error'));assert(!tail.some(event=>event.type==='second-frame-send-return'));assert(!JSON.stringify(tail).includes(original.message));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('manual keyboard mode requires the owned keyboard model and exposes only its fixed inspect flag',()=>{
 assert.throws(()=>createReactTerminalFixture({nativeKeyboardManual:true}),/Manual keyboard requires/);
 const model=createReactTerminalFixture({nativeKeyboardManual:true,nativeKeyboard:true,nativeFeedback:true,interactions:true,authorized:()=>true});
 assert.equal(model.inspect().nativeKeyboardManual,true);assert.equal(createReactTerminalFixture().inspect().nativeKeyboardManual,false);
});

test('overlay check is opt-in and requires the complete owned manual profile',()=>{
 assert.equal(createReactTerminalFixture().inspect().nativeOverlay,false);
 assert.throws(()=>createReactTerminalFixture({nativeOverlay:true}),/owned manual profile/);
 const model=createReactTerminalFixture({nativeOverlay:true,nativeKeyboardManual:true,nativeKeyboard:true,nativeFeedback:true,interactions:true,authorized:()=>true});
 assert.equal(model.inspect().nativeOverlay,true);
});
