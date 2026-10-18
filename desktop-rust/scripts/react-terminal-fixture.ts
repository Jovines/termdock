/** Owned protocol model behind the fixed router's real encrypted transport.
 * No PTY, shell, filesystem user data, or production listener exists here. */
import assert from 'node:assert/strict';
import express from 'express';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

export function createReactTerminalFixture(options:{userFixes?:boolean;interactions?:boolean;nativeFeedback?:boolean;nativeInput?:boolean;nativeKeyboard?:boolean;nativeKeyboardManual?:boolean;nativeOverlay?:boolean;benchmarkOutput?:boolean;authorized?:(req:express.Request)=>boolean}={}) {
  assert((!options.userFixes&&!options.interactions&&!options.nativeFeedback&&!options.nativeInput&&!options.nativeKeyboard&&!options.benchmarkOutput)||options.authorized,'User fixes require the fixed router encrypted-request verifier');
  assert(!options.nativeKeyboardManual||options.nativeKeyboard,'Manual keyboard requires the fixed owned keyboard model');
  assert(!options.nativeOverlay||options.nativeKeyboardManual,'Overlay check requires the owned manual profile');
  assert((!options.nativeFeedback&&!options.nativeInput&&!options.nativeKeyboard)||options.interactions,'Native input feedback requires the owned interactions descriptor');
  let frontend = 'controlled-react-panel', creations = 0;
  let backend = 'controlled-react-backend-a', epoch = 'controlled-stream-a';
  let generation = Date.now(), sequence = 1, deleted = false, extraDeleted=false, thirdDeleted=false;
  const journal = [{seq:1,data:'controlled React baseline 中\r\n'}];
  const sockets = new Set<WebSocket>(), socketsByBackend=new Map<string,Set<WebSocket>>(), controls = new Set<WebSocket>();
  const owners = new WeakMap<WebSocket,{backend:string;epoch:string}>();
  const events:Array<Record<string,unknown>> = [];
  const benchmarkProfiles={idle:{durationMs:10_000,chunks:0,chunkBytes:0,intervalMs:0},steady:{durationMs:15_000,chunks:15,chunkBytes:65_600,intervalMs:1_000},burst:{durationMs:2_000,chunks:16,chunkBytes:262_080,intervalMs:125}} as const;
  type BenchmarkProfile=keyof typeof benchmarkProfiles;
  type BenchmarkState={runId:string;profile:BenchmarkProfile;epoch:string;done:boolean;bytes:number;chunks:number;expectedBytes:number;expectedChunks:number;lastSeq:number;startedAt:number;completedAt:number|null;durationMs:number|null};
  let benchmark:BenchmarkState|null=null;
  const feedbackEnabled=options.nativeFeedback===true||options.nativeInput===true;
  let updateAllowed=false,extra=false,third=false;
  const extraFrontend='controlled-react-second',extraBackend='controlled-react-backend-second',extraEpoch='controlled-stream-second';
  const thirdFrontend='controlled-react-third',thirdBackend='controlled-react-backend-third',thirdEpoch='controlled-stream-third';
  const extraSession=()=>({...session(),frontendSessionId:extraFrontend,sessionId:extraFrontend,name:'Controlled Second',backendSessionId:extraBackend,shellTitle:'Controlled Second'});
  const thirdSession=()=>({...session(),frontendSessionId:thirdFrontend,sessionId:thirdFrontend,name:'Controlled Third',backendSessionId:thirdBackend,shellTitle:'Controlled Third'});
  const updateState=(status='ready')=>({status,currentVersion:'1.4.320',latestVersion:'1.4.999',source:'official',checkedAt:1,error:null});
  const log = (value:Record<string,unknown>) => {
    assert(events.length<512,'Controlled fixture event bound exceeded');
    events.push({index:events.length+1,...value});
  };
  const send=(socket:WebSocket,value:unknown)=>socket.send(JSON.stringify(value));
  const trackSocket=(id:string,socket:WebSocket)=>{
    let owned=socketsByBackend.get(id);if(!owned){owned=new Set();socketsByBackend.set(id,owned);}owned.add(socket);
    socket.once('close',()=>{owned!.delete(socket);if(!owned!.size)socketsByBackend.delete(id);});
  };
  const session=()=>({frontendSessionId:frontend,sessionId:frontend,name:'Controlled React',customName:true,backendSessionId:backend,mode:'shell',tmuxSessionName:null,createdAt:1,lastActivity:1,connected:true,live:true,restorable:true,activeProgram:'zsh',cwd:'/controlled',shellTitle:'Controlled React'});
  const inventory=()=>({clientSessions:[...(!deleted?[session()]:[]),...(extra&&!extraDeleted?[extraSession()]:[]),...(third&&!thirdDeleted?[thirdSession()]:[])],tmuxSessions:[],tmuxStatus:{available:false,version:null,reason:'Controlled fixture has no tmux'},updatedAt:generation});
  const broadcast=()=>{
    generation++;
    for(const socket of controls)send(socket,{type:'client-state',seq:generation,state:{sessions:inventory().clientSessions,updatedAt:generation},inventory:inventory()});
  };
  const append=(data:string,deliver=true,record=true)=>{
    const item={seq:++sequence,data};journal.push(item);
    assert(journal.length<=64,'Controlled journal bound exceeded');
    if(deliver)for(const socket of sockets)if(owners.get(socket)?.backend===backend&&owners.get(socket)?.epoch===epoch)send(socket,{type:'data',...item,flowSeq:sequence});
    if(record)log({type:'sent-data',sequence,epoch,bytes:Buffer.byteLength(data)});
  };
  const inspect=()=>({fixture:'actual-old-router-react-terminal-model-v1',userFixes:options.userFixes===true,interactions:options.interactions===true,nativeFeedback:options.nativeFeedback===true,nativeInput:options.nativeInput===true,nativeKeyboard:options.nativeKeyboard===true,nativeKeyboardManual:options.nativeKeyboardManual===true,nativeOverlay:options.nativeOverlay===true,benchmarkOutput:options.benchmarkOutput===true,inputRouting:options.nativeInput===true,extraFrontend,extraBackend,thirdFrontend,thirdBackend,frontend,backend,epoch,sequence,deleted,extraDeleted,thirdDeleted,benchmark,inventory:inventory(),events});
  const benchmarkRow=('TD-BENCH '+ '0123456789ABCDEF'.repeat(4)).padEnd(78,'X')+'\r\n';
  const benchmarkBlock=(bytes:number)=>{
    assert(Number.isSafeInteger(bytes)&&bytes>0&&bytes%Buffer.byteLength(benchmarkRow)===0,'Benchmark block must contain whole fixed-width rows');
    return benchmarkRow.repeat(bytes/Buffer.byteLength(benchmarkRow));
  };
  const runBenchmark=(profile:BenchmarkProfile,runId:string)=>{
    assert(options.benchmarkOutput,'Controlled benchmark output is not enabled');
    assert(/^[a-zA-Z0-9_-]{1,48}$/.test(runId),'Benchmark run id must be bounded ASCII');
    assert(!benchmark||benchmark.done,'A controlled benchmark is already running');
    assert((socketsByBackend.get(backend)?.size??0)>0,'Benchmark requires the controlled terminal socket to be connected');
    const spec=benchmarkProfiles[profile],state:BenchmarkState={runId,profile,epoch,done:false,bytes:0,chunks:0,expectedBytes:spec.chunkBytes*spec.chunks,expectedChunks:spec.chunks,lastSeq:sequence,startedAt:Date.now(),completedAt:null,durationMs:null};
    benchmark=state;log({type:'benchmark-start',runId,profile,epoch:state.epoch,expectedBytes:state.expectedBytes,expectedChunks:state.expectedChunks,durationMs:spec.durationMs});
    const finish=()=>{
      if(benchmark!==state)return;
      state.done=true;state.completedAt=Date.now();state.durationMs=state.completedAt-state.startedAt;
      log({type:'benchmark-complete',runId,profile,epoch:state.epoch,bytes:state.bytes,chunks:state.chunks,lastSeq:state.lastSeq,durationMs:state.durationMs});
    };
    const abort=()=>{state.done=true;state.completedAt=Date.now();state.durationMs=state.completedAt-state.startedAt;log({type:'benchmark-aborted',runId,profile,epoch:state.epoch,currentEpoch:epoch,deleted,bytes:state.bytes,chunks:state.chunks});};
    if(profile==='idle'){const timer=setTimeout(()=>{if(epoch!==state.epoch||deleted||(socketsByBackend.get(backend)?.size??0)===0)abort();else finish();},spec.durationMs);timer.unref();return state;}
    const block=benchmarkBlock(spec.chunkBytes);let sent=0;
    const tick=()=>{
      if(benchmark!==state)return;
      if(epoch!==state.epoch||deleted||(socketsByBackend.get(backend)?.size??0)===0){abort();return;}
      append(block,true,false);sent++;state.bytes+=Buffer.byteLength(block);state.chunks++;state.lastSeq=sequence;
      if(sent===spec.chunks)finish();
      else {const timer=setTimeout(tick,spec.intervalMs);timer.unref();}
    };
    const timer=setTimeout(tick,spec.intervalMs);timer.unref();return state;
  };
  function install(app:express.Express) {
    // Owned model only: this route never installs, restarts, or contacts a service.
    if(options.userFixes){
      app.get('/api/terminal/update',(_req,res)=>res.json(updateState()));
      app.get('/api/csrf-token',(req,res)=>{const encrypted=options.authorized!(req);log({type:'controlled-csrf-read',encrypted});if(!encrypted)return res.status(403).json({error:'Controlled encrypted request required'});res.json({csrfToken:'controlled-update-csrf'});});
      app.post('/api/terminal/update/restart',(req,res)=>{
        // Fixed79 authenticates and marks the inner request, deliberately
        // forwarding no ambient CSRF/auth headers. Keep that real contract.
        const encrypted=options.authorized!(req),csrfOmitted=req.header('X-XSRF-TOKEN')===undefined;
        log({type:'controlled-restart-request',encrypted,csrfOmitted,allowed:updateAllowed});
        if(!encrypted||!csrfOmitted)return res.status(403).json({error:'Controlled authenticated forwarder required'});
        if(!updateAllowed)return res.status(503).json({error:'Controlled restart failure'});
        res.json(updateState('restarting'));
      });
    }
    if(options.interactions){
      // Current React sidebar reads this inventory on mount. An absent route
      // creates a real inline alert and prevents an otherwise empty overlay set.
      app.get('/api/terminal/operations/collaboration-tasks',(req,res)=>{const encrypted=options.authorized!(req);log({type:'controlled-task-inventory',encrypted});if(!encrypted)return res.status(403).json({error:'Controlled encrypted request required'});res.json({tasks:[]});});
      app.get('/api/terminal/server-health',(_req,res)=>res.json({supervised:false,supervisor:null,attention:true,lastIncident:null,lastEvents:[],canEnableSupervision:false}));
      app.post('/api/terminal/server-health/dismiss',(req,res)=>{const encrypted=options.authorized!(req);log({type:'controlled-health-dismiss',encrypted,method:req.method,realSupervisor:false});if(!encrypted)return res.status(403).json({error:'Controlled encrypted request required'});res.status(503).json({error:'Controlled health dismissal failure'});});
      app.get('/api/terminal/update',(req,res)=>{const encrypted=options.authorized!(req);log({type:'controlled-update-read',encrypted,method:req.method,realUpdate:false});if(!encrypted)return res.status(403).json({error:'Controlled encrypted request required'});res.json(updateState('current'));});
      app.post('/api/terminal/update/check',(req,res)=>{const encrypted=options.authorized!(req),csrfOmitted=req.header('X-XSRF-TOKEN')===undefined;log({type:'controlled-update-check',encrypted,method:req.method,csrfOmitted,realUpdate:false});if(!encrypted||!csrfOmitted)return res.status(403).json({error:'Controlled authenticated forwarder required'});res.status(503).json({error:'Controlled service update check failure'});});
      app.get('/api/terminal/fs/list',(req,res)=>{const encrypted=options.authorized!(req);log({type:'controlled-file-list',encrypted,method:req.method});if(!encrypted)return res.status(403).json({error:'Controlled encrypted request required'});assert(req.query.path==='/controlled');res.json({path:'/controlled',entries:[{name:'owned.txt',path:'/controlled/owned.txt',type:'file',modified:'controlled-v1'}]});});
      app.get('/api/terminal/fs/read',(req,res)=>{
        const encrypted=options.authorized!(req),pathMatches=req.query.path==='/controlled/owned.txt',actionAbsent=req.query.action===undefined,actionMatches=req.query.action==='view_file',owned=pathMatches&&(actionAbsent||actionMatches);
        log({type:'controlled-file-read',encrypted,method:req.method,owned,pathMatches,actionAbsent,actionMatches,realFilesystem:false});
        if(!encrypted)return res.status(403).json({error:'Controlled encrypted request required'});
        if(!owned)return res.status(404).json({error:'Owned preview file unavailable'});
        const content='Owned file preview\nFixed local fixture content.\nNo user filesystem or PTY.\n';
        res.json({path:'/controlled/owned.txt',content,size:Buffer.byteLength(content),modified:'controlled-v1',truncated:false,binary:false});
      });
      app.delete('/api/terminal/fs/file',(req,res)=>{const encrypted=options.authorized!(req),csrfOmitted=req.header('X-XSRF-TOKEN')===undefined;assert(req.query.path==='/controlled/owned.txt'&&req.query.confirm==='true');log({type:'controlled-file-delete',encrypted,csrfOmitted,method:req.method,realFilesystem:false});if(!encrypted||!csrfOmitted)return res.status(403).json({error:'Controlled authenticated forwarder required'});res.status(503).json({error:'Controlled file deletion failure'});});
    }
    app.get('/api/terminal/session-inventory',(_req,res)=>res.json(inventory()));
    app.post('/api/terminal/session-inventory/open',express.json(),(req,res)=>{
      if(extra&&req.body.preferredFrontendSessionId===extraFrontend){log({type:'inventory-open',backend:extraBackend,requireExisting:req.body.requireExisting===true});res.json({session:extraSession(),terminalSession:{sessionId:extraBackend,cols:80,rows:24,mode:'shell',cwd:'/controlled'},inventory:inventory(),reused:true});return;}
      if(third&&req.body.preferredFrontendSessionId===thirdFrontend){log({type:'inventory-open',backend:thirdBackend,requireExisting:req.body.requireExisting===true});res.json({session:thirdSession(),terminalSession:{sessionId:thirdBackend,cols:80,rows:24,mode:'shell',cwd:'/controlled'},inventory:inventory(),reused:true});return;}
      if(deleted){
        frontend=req.body.preferredFrontendSessionId??randomUUID();assert(typeof frontend==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(frontend));
        deleted=false;backend=`controlled-react-created-${++creations}`;epoch=`controlled-stream-created-${creations}`;sequence=1;
        journal.splice(0,journal.length,{seq:1,data:'controlled React created baseline\r\n'});
      }
      assert(req.body.preferredFrontendSessionId==null||req.body.preferredFrontendSessionId===frontend,'Only the controlled session may open');
      log({type:'inventory-open',requireExisting:req.body.requireExisting===true});
      res.json({session:session(),terminalSession:{sessionId:backend,cols:80,rows:24,mode:'shell',cwd:'/controlled'},inventory:inventory(),reused:true});
    });
    app.patch('/api/terminal/session-inventory/sessions/:id',express.json(),(req,res)=>{
      assert(req.params.id===frontend||extra&&req.params.id===extraFrontend);log({type:'inventory-update'});res.json(inventory());
    });
    app.delete('/api/terminal/session-inventory/sessions/:id',(req,res)=>{
      if(req.params.id===frontend)deleted=true;
      else if(extra&&req.params.id===extraFrontend)extraDeleted=true;
      else if(third&&req.params.id===thirdFrontend)thirdDeleted=true;
      else return res.status(404).json({error:'Controlled session absent'});
      log({type:'user-inventory-delete',frontend:req.params.id});broadcast();res.json(inventory());
    });
    app.get('/api/terminal/:id/health',(req,res)=>res.json({healthy:(!deleted&&req.params.id===backend)||(extra&&!extraDeleted&&req.params.id===extraBackend)||(third&&!thirdDeleted&&req.params.id===thirdBackend),sessionId:req.params.id,mode:'shell',cwd:'/controlled',clients:sockets.size}));
    app.delete('/api/terminal/:id',(req,res)=>{assert([backend,...(extra?[extraBackend]:[]),...(third?[thirdBackend]:[])].includes(req.params.id));log({type:'user-backend-close',backend:req.params.id});for(const socket of socketsByBackend.get(req.params.id)??[])socket.close(1000,'Controlled close');res.json({success:true});});
    app.get('/api/terminal/test-health',(req,res)=>{
      if((options.userFixes||options.interactions||options.nativeFeedback||options.nativeInput||options.benchmarkOutput)&&!options.authorized?.(req))return res.status(403).json({error:'Controlled encrypted request required'});
      res.json(inspect());
    });
    app.post('/api/terminal/test-health',express.json(),(req,res)=>{
      if((options.userFixes||options.interactions||options.nativeFeedback||options.nativeInput||options.benchmarkOutput)&&!options.authorized?.(req))return res.status(403).json({error:'Controlled encrypted request required'});
      const action=req.body?.action;log({type:'driver-model-action',action});
      if(action==='benchmark-output'){
        if(!options.benchmarkOutput)return res.status(403).json({error:'Controlled benchmark output is not enabled'});
        const profile=req.body?.profile,runId=req.body?.runId;
        if(typeof profile!=='string'||!Object.hasOwn(benchmarkProfiles,profile)||typeof runId!=='string'||!/^[a-zA-Z0-9_-]{1,48}$/.test(runId))return res.status(400).json({error:'Invalid controlled benchmark profile or run id'});
        if(benchmark&&!benchmark.done)return res.status(409).json({error:'A controlled benchmark is already running'});
        if((socketsByBackend.get(backend)?.size??0)===0)return res.status(409).json({error:'Benchmark requires the controlled terminal socket to be connected'});
        runBenchmark(profile as BenchmarkProfile,runId);res.json(inspect());return;
      }
      if(action==='benchmark-status'){
        if(!options.benchmarkOutput)return res.status(403).json({error:'Controlled benchmark output is not enabled'});
        res.json(inspect());return;
      }
      if(action==='disconnect') {append('controlled disconnected suffix\r\n',false);for(const socket of sockets)socket.close(1012,'Controlled reconnect');}
      else if(action==='output')append('controlled later output\r\n');
      else if(action==='epoch') {epoch='controlled-stream-b';sequence=1;journal.splice(0,journal.length,{seq:1,data:'controlled new epoch baseline\r\n'});for(const socket of sockets)socket.close(1012,'Controlled epoch replacement');}
      else if(action==='backend') {backend='controlled-react-backend-b';epoch='controlled-stream-c';sequence=1;journal.splice(0,journal.length,{seq:1,data:'controlled backend B baseline\r\n'});broadcast();}
      else if(action==='exit') {for(const socket of sockets)send(socket,{type:'exit',exitCode:0});}
      else if(action==='inventory-delete') {deleted=true;extraDeleted=true;thirdDeleted=true;broadcast();}
      else if(action==='feedback-add-session'&&(options.nativeFeedback||options.nativeInput)) {extra=true;broadcast();}
      else if(action==='feedback-add-three-sessions'&&options.nativeInput&&extra) {third=true;broadcast();}
      else if(action==='allow-controlled-update'&&options.userFixes)updateAllowed=true;
      else return res.status(400).json({error:'Unsupported controlled fixture action'});
      res.json(inspect());
    });
  }
  function terminal(socket:WebSocket,id:string,_client:string,options:{sinceSeq?:number;streamEpoch?:string}) {
    const controlledExtra=id===extraBackend&&extra&&!extraDeleted?{frontend:extraFrontend,epoch:extraEpoch,name:'Second'}:id===thirdBackend&&third&&!thirdDeleted?{frontend:thirdFrontend,epoch:thirdEpoch,name:'Third'}:null;
    if(feedbackEnabled&&controlledExtra){
      trackSocket(id,socket);
      log({type:'terminal-open',backend:id,frontend:controlledExtra.frontend,since:options.sinceSeq??0,epoch:controlledExtra.epoch,incremental:false});
      const sendSecond=(frame:Record<string,unknown>,phase:'connected'|'data',seq:number)=>{
        const before=socket.readyState,stamp={backend:id,frontend:controlledExtra.frontend,epoch:controlledExtra.epoch,phase,seq,flowSeq:phase==='data'?2:null};
        if(phase==='data'&&before!==1){log({type:'second-frame-skip',...stamp,readyState:before,reason:'socket-not-open'});return;}
        log({type:'second-frame-send-start',...stamp,readyState:before});
        try{send(socket,frame);log({type:'second-frame-send-return',...stamp,readyStateBefore:before,readyStateAfter:socket.readyState});}
        catch(error){log({type:'second-frame-send-error',...stamp,readyState:socket.readyState,errorKind:error instanceof Error?'Error':'non-Error'});throw error;}
      };
      sendSecond({type:'connected',mode:'shell',cwd:'/controlled',activeProgram:'zsh',promptState:'idle',cols:80,rows:24,streamEpoch:controlledExtra.epoch,outputProtocol:2,replayLastSeq:1,replayChunks:[`Controlled ${controlledExtra.name.toLowerCase()} baseline\r\n`]},'connected',1);
      queueMicrotask(()=>sendSecond({type:'data',seq:2,flowSeq:2,data:`Controlled ${controlledExtra.name.toLowerCase()} live\r\n`},'data',2));
      socket.on('message',(raw:unknown)=>{const msg=JSON.parse(String(raw));
        if(msg.type==='ping')send(socket,{type:'pong',qualityProbeId:msg.qualityProbeId,handlerMs:0});
        else if(msg.type==='resize'){log({type:'resize',backend:id,cols:msg.cols,rows:msg.rows});send(socket,{type:'resize-ack',ok:true,cols:msg.cols,rows:msg.rows,seq:msg.seq});}
        else if(msg.type==='input'){
          if(id===extraBackend?extraDeleted:thirdDeleted){log({type:'stale-client-message',backend:id,frontend:controlledExtra.frontend,messageType:'input'});return;}
          assert(typeof msg.data==='string'&&Buffer.byteLength(msg.data)<=256,'Bounded owned input only');log({type:'input',backend:id,frontend:controlledExtra.frontend,data:msg.data,bytes:Buffer.byteLength(msg.data),receipt:'controlled-terminal-input-v1'});
        }
        else if(msg.type==='output-ack'){assert(msg.epoch===controlledExtra.epoch&&msg.since<=2);log({type:'output-ack',backend:id,flowSeq:msg.flowSeq,since:msg.since,epoch:controlledExtra.epoch});}
        else if(['focus','viewing','flow-control','output-subscription'].includes(msg.type))log({type:'second-client-state',backend:id,epoch:controlledExtra.epoch,messageType:msg.type,focused:msg.focused===true,active:msg.active===true,paused:msg.paused===true});
      });return;
    }
    assert(id===backend&&!deleted,'Only controlled existing backend may connect');
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));trackSocket(id,socket);
    owners.set(socket,{backend:id,epoch});
    const since=options.sinceSeq??0;
    const valid=options.streamEpoch===epoch&&since>0&&since<=sequence;
    log({type:'terminal-open',backend:id,since,requestedEpoch:options.streamEpoch??null,epoch,incremental:valid});
    const replay=valid?journal.filter(item=>item.seq>since).map(item=>item.data):['\x1bc'+journal.map(item=>item.data).join('')];
    send(socket,{type:'connected',mode:'shell',cwd:'/controlled',activeProgram:'zsh',promptState:'idle',cols:80,rows:24,streamEpoch:epoch,outputProtocol:2,replayLastSeq:sequence,replayChunks:replay,replayOutOfWindow:since>0&&!valid});
    // A normal data frame gives the production flow-control path a real seq.
    queueMicrotask(()=>{if(socket.readyState===1)append(`controlled connection ${events.filter(item=>item.type==='terminal-open').length}\r\n`);});
    socket.on('message',(raw:unknown)=>{
      const msg=JSON.parse(String(raw));
      if(deleted||owners.get(socket)?.backend!==backend||owners.get(socket)?.epoch!==epoch){log({type:'stale-client-message',backend:id,messageType:msg.type});return;}
      if(msg.type==='ping')send(socket,{type:'pong',qualityProbeId:msg.qualityProbeId,handlerMs:0});
      else if(msg.type==='resize') {log({type:'resize',cols:msg.cols,rows:msg.rows,seq:msg.seq});send(socket,{type:'resize-ack',ok:true,cols:msg.cols,rows:msg.rows,seq:msg.seq});}
      else if(msg.type==='input') {assert(typeof msg.data==='string'&&Buffer.byteLength(msg.data)<=256,'Bounded owned input only');log({type:'input',backend:id,frontend,data:msg.data,bytes:Buffer.byteLength(msg.data),receipt:'controlled-terminal-input-v1'});append('controlled input received\r\n');}
      else if(msg.type==='output-ack') {assert(msg.epoch===epoch&&msg.since<=sequence);log({type:'output-ack',flowSeq:msg.flowSeq,since:msg.since,epoch:msg.epoch});}
      else if(['flow-control','output-subscription','focus','viewing'].includes(msg.type))log({type:msg.type,backend:id,focused:msg.focused===true,active:msg.active,paused:msg.paused});
    });
  }
  function control(socket:WebSocket) {
    controls.add(socket);const timer=setInterval(()=>send(socket,{type:'ping'}),30000);timer.unref();socket.once('close',()=>{clearInterval(timer);controls.delete(socket);});
    broadcast();socket.on('message',(raw:unknown)=>{const msg=JSON.parse(String(raw));if(msg.type==='ping')send(socket,{type:'pong'});});
  }
  return {install,terminal,control,inspect};
}
