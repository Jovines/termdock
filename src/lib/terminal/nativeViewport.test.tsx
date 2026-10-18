// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,render,waitFor,fireEvent} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {TerminalController,TerminalViewportProps} from '../components/terminal/TerminalViewport';
import {FLEXOKI_DARK} from './theme';
const copyModel=vi.hoisted(()=>({target:{targetPeerId:'target-a'},client:null as {closed:boolean}|null,request:vi.fn()}));
vi.mock('./api',()=>({sendTmuxAction:copyModel.request}));
vi.mock('../federation/browserIntegration',()=>({currentSecureClient:()=>copyModel.client}));
const host=vi.hoisted(()=>{const listeners=new Set<(value:any)=>void>();return{available:true,request:vi.fn(),listeners,cached:null as any,subscribe:(fn:(value:any)=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);}};});
vi.mock('../desktop/nativeBridge',()=>({getTermdockDesktopBridge:()=>({nativeTerminal:host}),subscribeNativeFileDrops:()=>()=>{}}));
vi.mock('../federation/deviceIdentity',()=>({getIdentity:async()=>({peerId:'device-a'})}));
vi.mock('../federation/clientScope',()=>({selectedTarget:()=>copyModel.target}));
vi.mock('../collaboration/inputTarget',()=>({routeCollaborationInput:()=>false}));
vi.mock('./nativeSnapshotCache',()=>({readNativeSnapshot:async()=>host.cached,deleteNativeSnapshot:async()=>true,nativeSnapshotRevision:()=>0,tagNativeSnapshot:(value:any)=>value,writeNativeSnapshot:async()=>true}));
vi.mock('./clipboardImage',()=>({readTerminalClipboardFiles:vi.fn(),readTerminalClipboardImage:vi.fn(),uploadTerminalClipboardFiles:vi.fn(),uploadTerminalClipboardImage:vi.fn(),TerminalClipboardVideoError:class extends Error{}}));
vi.mock('./sessionFontSize',()=>({setSessionFontSize:vi.fn()}));
import * as clipboard from './clipboardImage';
import {NativeTerminalViewport} from './nativeViewport';
import {closeNativeSession,registerNativeLease,retireNativeLease,hideNativeLease} from './nativeLifetime';
let serial=0,latestToken='',creates:Array<Record<string,any>>,writes:Array<Record<string,any>>,restoreMode='none',retain=false,lastRect='',lifeState:any,lifeListeners:Set<(value:any)=>void>;
const emit=(token:string,event:Record<string,unknown>)=>host.listeners.forEach(fn=>fn({token,epoch:'page-a',event}));
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function props():TerminalViewportProps{return{sessionKey:'frontend-panel',sessionId:'frontend-id',backendSessionId:null,chunks:[],onInput:vi.fn(async()=>true),onResize:vi.fn(),onReadyChange:vi.fn(),onWriteProgress:vi.fn(),theme:FLEXOKI_DARK,terminalSettings:{fontFamily:'Termdock Mono',fontSize:13,rendererMode:'auto',fontWeight:'normal',fontWeightBold:'bold',letterSpacing:1,lineHeight:1.05,minimumContrastRatio:4.5,drawBoldTextInBrightColors:true,unicodeVersion:'11',customGlyphs:true,rescaleOverlappingGlyphs:false,fontLigatures:true,enableImages:true,smoothScrolling:true}};}
beforeEach(()=>{
 copyModel.target={targetPeerId:'target-a'};copyModel.client=null;copyModel.request.mockReset();
 serial=0;latestToken='';creates=[];writes=[];restoreMode='none';retain=false;lastRect='';lifeState={hidden:false,focused:true,overlays:[],viewport:{width:innerWidth,height:innerHeight,scale:1},generation:0,overlayReady:true};lifeListeners=new Set();host.cached=null;host.listeners.clear();host.request.mockReset();
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:400,bottom:300,width:400,height:300,toJSON(){}});
 window.termdockPreviewLifecycle={snapshot:()=>lifeState,subscribe:(fn:(value:any)=>void)=>{lifeListeners.add(fn);fn(lifeState);return()=>lifeListeners.delete(fn);},nativePanels:vi.fn()};
 host.request.mockImplementation(async(args:Record<string,any>)=>{
  if(args.action==='create'){creates.push(args);if(!retain)lastRect='';latestToken=`token-${++serial}`;return{token:latestToken,epoch:'page-a',sequence:retain?1:0,baseline:retain?{seq:41,epoch:'stream-a'}:null,reused:retain};}
  if(args.action==='localReset'){const previous=args.token;latestToken=`token-${++serial}`;lastRect='';const last=writes.filter(write=>write.token===previous).at(-1);return{token:latestToken,epoch:'page-a',sequence:0,baseline:last?.cursor??null,reused:false,dimensions:{cols:80,rows:24}};}
  if(args.action==='capture')return{version:1,engine:'controlled',data:'neutral',cursor:args.cursor,owner:{session:'backend-a'},options:{},font_size:13,data_sha256:'0'.repeat(64)};
  if(args.action==='visible')return{visible:args.visible};
  if(args.action==='retireView')return{detached:true,view:args.view,token:args.token,epoch:'page-a',disposition:'current'};
  if(args.action==='write'){writes.push(args);return{pending:args.sequence};}
  if(args.action==='restore'){
   if(restoreMode==='ipc')throw new Error('invalid snapshot');
   if(restoreMode==='async'){latestToken=`token-${++serial}`;const failedToken=latestToken;setTimeout(()=>emit(failedToken,{type:'fatal',message:'invalid engine metadata'}),0);return{token:latestToken,epoch:'page-a',sequence:1,baseline:{seq:40,epoch:'stream-a'},reused:false};}
   return null;
  }
  if(args.action==='layout'){if(restoreMode==='async'&&serial===2)throw new Error('invalid engine metadata');return{complete:true,token:args.token,epoch:'page-a',dimensions:{cols:80,rows:24}};}
  if(args.action==='rect'){const next=JSON.stringify([args.x,args.y,args.width,args.height]);if(next===lastRect)return{rectApplied:true};lastRect=next;}
  if(['focus','rect'].includes(args.action)){const token=args.token;setTimeout(()=>{emit(token,{type:'resize',cols:80,rows:24});emit(token,{type:'ready',position:{x:0,y:0,rows:24}});},0);}
  return null;
 });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();delete window.termdockPreviewLifecycle;});
it('forwards cursor visibility and renderer blink policy at creation and on preference changes',async()=>{
 const p={...props(),cursorVisible:false,terminalSettings:{...props().terminalSettings,rendererMode:'auto' as const}},ref=React.createRef<TerminalController>();
 const view=render(<NativeTerminalViewport {...p} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});
 expect(creates[0].options).toMatchObject({cursor_visible:false,cursor_blink:true});
 view.rerender(<NativeTerminalViewport {...p} cursorVisible={true} terminalSettings={{...p.terminalSettings,rendererMode:'webgl'}} ref={ref}/>);
 await waitFor(()=>expect(host.request.mock.calls.some(([args])=>args.action==='cursor'&&args.visible===true&&args.blink===false)).toBe(true));
});
it('applies preferences changed during create before the first container layout',async()=>{
 const p=props(),ref=React.createRef<TerminalController>(),normal=host.request.getMockImplementation()!;
 let release!:(value:any)=>void;
 host.request.mockImplementation(async(args:any)=>args.action==='create'?new Promise(resolve=>{release=resolve;}):normal(args));
 const view=render(<NativeTerminalViewport {...p} ref={ref}/>);
 let preparing!:Promise<unknown>;
 await act(async()=>{preparing=ref.current!.prepareNativeSession!('backend-a');await tick();});
 view.rerender(<NativeTerminalViewport {...p} terminalSettings={{...p.terminalSettings,fontSize:20,fontFamily:'Changed Font',rendererMode:'webgl'}} cursorVisible={false} onTmuxScroll={vi.fn()} theme={{...p.theme,foreground:p.theme.red}} ref={ref}/>);
 await act(async()=>{latestToken='token-1';release({token:latestToken,epoch:'page-a',sequence:0,baseline:null,reused:false});await preparing;});
 const actions=host.request.mock.calls.map(([args])=>args);
 const firstRect=actions.findIndex(args=>args.action==='rect');
 expect(firstRect).toBeGreaterThan(0);
 expect(actions.slice(0,firstRect)).toEqual(expect.arrayContaining([
  expect.objectContaining({action:'fontSize',size:20}),
  expect.objectContaining({action:'font',font:expect.objectContaining({family:'Changed Font'})}),
  expect.objectContaining({action:'cursor',visible:false,blink:false}),
  expect.objectContaining({action:'history',history:0}),
  expect.objectContaining({action:'palette'}),
 ]));
});
it('keeps newer preference effects after reconciliation already waiting on the host',async()=>{
 const p=props(),ref=React.createRef<TerminalController>(),normal=host.request.getMockImplementation()!;
 let releaseCreate!:(value:any)=>void,releaseSize!:(value:unknown)=>void;
 host.request.mockImplementation(async(args:any)=>{
  if(args.action==='create')return new Promise(resolve=>{releaseCreate=resolve;});
  if(args.action==='fontSize'&&args.size===20)return new Promise(resolve=>{releaseSize=resolve;});
  return normal(args);
 });
 const view=render(<NativeTerminalViewport {...p} ref={ref}/>);let preparing!:Promise<unknown>;
 await act(async()=>{preparing=ref.current!.prepareNativeSession!('backend-a');await tick();});
 view.rerender(<NativeTerminalViewport {...p} terminalSettings={{...p.terminalSettings,fontSize:20,fontFamily:'First Font'}} ref={ref}/>);
 await act(async()=>{latestToken='token-1';releaseCreate({token:latestToken,epoch:'page-a',sequence:0,baseline:null,reused:false});await tick();});
 expect(releaseSize).toBeTypeOf('function');
 view.rerender(<NativeTerminalViewport {...p} terminalSettings={{...p.terminalSettings,fontSize:21,fontFamily:'Latest Font'}} ref={ref}/>);
 await act(async()=>{releaseSize(null);await preparing;});
 const actions=host.request.mock.calls.map(([args])=>args),beforeRect=actions.slice(0,actions.findIndex(args=>args.action==='rect'));
 expect(beforeRect.filter(args=>args.action==='fontSize').at(-1)?.size).toBe(21);
 expect(beforeRect.filter(args=>args.action==='font').at(-1)?.font.family).toBe('Latest Font');
});
for(const intent of ['focus','blur'] as const)it(`normal parent ${intent} before prepare preserves native initialization and real consumption`,async()=>{
 const p=props(),fallback=vi.fn(),ref=React.createRef<TerminalController>(),focusChanged=vi.fn();
 function Parent(){React.useLayoutEffect(()=>{ref.current![intent]();},[]);return <NativeTerminalViewport {...p} ref={ref} onInputFocusChange={focusChanged} onNativeRendererFailed={fallback}/>;}
 const view=render(<Parent/>);
 await act(async()=>{await tick();});
 expect(host.request).not.toHaveBeenCalled();expect(fallback).not.toHaveBeenCalled();
 expect(focusChanged.mock.calls).toEqual(intent==='blur'?[[false]]:[]);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 expect(creates).toHaveLength(1);expect(ref.current!.renderer!()).toBe('native');
 // Feed via a new props object without remounting the prepared viewport.
 p.chunks=[{id:1,data:'after normal focus intent'}];view.rerender(<Parent/>);
 await waitFor(()=>expect(writes).toHaveLength(1));expect(p.onWriteProgress).not.toHaveBeenCalled();
 act(()=>emit('old-token',{type:'ack',sequence:1}));expect(p.onWriteProgress).not.toHaveBeenCalled();
 act(()=>emit(latestToken,{type:'ack',sequence:1}));expect(p.onWriteProgress).toHaveBeenCalledWith(1);
 expect(fallback).not.toHaveBeenCalled();expect(host.request.mock.calls.some(([a])=>a.action==='closeView')).toBe(false);
});
it('a real prepared focus failure still waits for exact retirement before fallback',async()=>{
 const p=props(),fallback=vi.fn(),ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...p} ref={ref} onNativeRendererFailed={fallback}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});
 const normal=host.request.getMockImplementation()!;let detach!:(value:unknown)=>void;
 host.request.mockImplementation(async(a:any)=>{if(a.action==='focus')throw Error('actual focus host failure');if(a.action==='retireView')return await new Promise(resolve=>{detach=resolve;});return normal(a);});
 await act(async()=>{ref.current!.focus();await tick();});
 expect(detach).toBeTypeOf('function');expect(fallback).not.toHaveBeenCalled();
 await act(async()=>{detach({detached:true,view:'frontend-panel',token:latestToken,epoch:'page-a',disposition:'current'});await tick();});
 expect(fallback).toHaveBeenCalledTimes(1);
});
it('geometry readiness precedes backend creation; output advances only on the matching native consumption ACK',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} ref={ref}/>);
 expect(p.onReadyChange).toHaveBeenCalledWith(true);expect(creates).toHaveLength(0);expect(ref.current!.renderer!()).toBe('native-pending');
 await act(async()=>{expect(await ref.current!.prepareNativeSession!('backend-a')).toBeNull();});
 expect(creates[0]).toMatchObject({view:'frontend-panel',session:'backend-a',device:'device-a'});expect(creates[0]).not.toHaveProperty('target');
 expect(ref.current!.renderer!()).toBe('native');
 view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:1,data:'中\x1b[?1049h界'}]} nativeCursor={{seq:41,epoch:'stream-a'}}/>);
 await waitFor(()=>expect(writes).toHaveLength(1));expect(p.onWriteProgress).not.toHaveBeenCalled();
 act(()=>emit('old-token',{type:'ack',sequence:1}));expect(p.onWriteProgress).not.toHaveBeenCalled();
 act(()=>emit(latestToken,{type:'ack',sequence:1}));expect(p.onWriteProgress).toHaveBeenCalledWith(1);
});
it('same PTY reconnect resets only the page chunk baseline and uses the host-confirmed consumed stream cursor',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});const old=latestToken;
 view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:1,data:'old'}]} nativeCursor={{seq:41,epoch:'stream-a'}}/>);await waitFor(()=>expect(writes).toHaveLength(1));act(()=>emit(old,{type:'ack',sequence:1}));
 retain=true;await act(async()=>{expect(await ref.current!.prepareNativeSession!('backend-a')).toEqual({seq:41,epoch:'stream-a'});});
 view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:2,data:'incremental'}]} nativeCursor={{seq:42,epoch:'stream-a'}}/>);await waitFor(()=>expect(writes).toHaveLength(2));expect(writes[1]).toMatchObject({sequence:2,replay:false});
 act(()=>emit(old,{type:'ack',sequence:2}));expect(p.onWriteProgress).toHaveBeenCalledTimes(1);act(()=>emit(latestToken,{type:'ack',sequence:2}));expect(p.onWriteProgress).toHaveBeenCalledWith(2);
});
it('switching backend identity invalidates queued output, ACKs and split input decoder state',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});const old=latestToken;
 act(()=>emit(old,{type:'input',base64:btoa(String.fromCharCode(0xe4,0xb8))}));
 view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:1,data:'old PTY'},{id:2,data:'old unsent'}]}/>);await waitFor(()=>expect(writes).toHaveLength(1));
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-b');});
 act(()=>emit(old,{type:'ack',sequence:1}));await tick();expect(writes).toHaveLength(1);expect(p.onWriteProgress).not.toHaveBeenCalled();
 act(()=>emit(latestToken,{type:'input',base64:btoa('B')}));expect(p.onInput).toHaveBeenLastCalledWith('B',{skipModifierTransform:true});expect(creates.at(-1)?.session).toBe('backend-b');
});
for(const mode of ['ipc','async'])it(`damaged durable ${mode} restore returns to a fresh receiver and same-PTY authoritative recovery`,async()=>{
 const p=props(),ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...p} ref={ref}/>);restoreMode=mode;
 host.cached={savedAt:Date.now(),version:1,engine:'td3',data:'bad',cursor:{seq:40,epoch:'stream-a'}};
 await act(async()=>{expect(await ref.current!.prepareNativeSession!('backend-a')).toBeNull();});expect(creates).toHaveLength(2);expect(creates.every(create=>create.session==='backend-a')).toBe(true);expect(ref.current!.renderer!()).toBe('native');
});
it('stream replacement discards an unfinished parser by replacing only the surface and rejects old-epoch ACK',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});const old=latestToken;
 view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:1,data:'\x1b]0;unfinished'}]}/>);await waitFor(()=>expect(writes).toHaveLength(1));
 act(()=>ref.current!.prepareScreenReplacement());view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:2,data:'authoritative'}]} nativeCursor={{seq:1,epoch:'stream-b'}}/>);
 await waitFor(()=>expect(writes).toHaveLength(2));expect(creates).toHaveLength(2);expect(writes[1]).toMatchObject({sequence:1,replay:true,cursor:{seq:1,epoch:'stream-b'}});
 act(()=>emit(old,{type:'ack',sequence:1}));expect(p.onWriteProgress).not.toHaveBeenCalled();act(()=>emit(latestToken,{type:'ack',sequence:1}));expect(p.onWriteProgress).toHaveBeenCalledWith(2);
});
it('a native failure permits the original renderer only after a matching actual detach receipt',async()=>{
 const p=props(),fallback=vi.fn(),ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...p} onNativeRendererFailed={fallback} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 const normal=host.request.getMockImplementation()!;let detach!:(value:unknown)=>void;
 host.request.mockImplementation(async(args:Record<string,any>)=>args.action==='retireView'?await new Promise(resolve=>{detach=resolve;}):normal(args));
 act(()=>emit(latestToken,{type:'fatal',message:'engine failure'}));expect(fallback).not.toHaveBeenCalled();expect(ref.current!.renderer!()).toBe('native-pending');
 await act(async()=>{detach({detached:true,view:'frontend-panel',epoch:'page-a',token:latestToken,disposition:'current'});await tick();});expect(fallback).toHaveBeenCalledTimes(1);
});
it('unrelated Ready cannot replace completion of a changed layout barrier',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...p} ref={ref}/>);
 const normal=host.request.getMockImplementation()!;let complete!:(value:unknown)=>void,layouts=0;
 host.request.mockImplementation(async(args:any)=>{if(args.action==='layout'&&++layouts===2)return await new Promise(resolve=>{complete=resolve;});return normal(args);});
 let done=false;const pending=ref.current!.prepareNativeSession!('backend-a').then(()=>{done=true;});
 await waitFor(()=>expect(complete).toBeTypeOf('function'));act(()=>emit(latestToken,{type:'ready'}));await tick();expect(done).toBe(false);
 await act(async()=>{complete({complete:true,token:latestToken,epoch:'page-a',dimensions:{cols:80,rows:24}});await pending;});expect(done).toBe(true);
});
it('search autofocus stays in WK through overlay hide/clip/show and leaves native unfocused',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...p} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});await tick();
 act(()=>emit(latestToken,{type:'search',text:''}));await waitFor(()=>expect(document.activeElement?.getAttribute('aria-label')).toBe('搜索终端'));
 await waitFor(()=>expect(host.request.mock.calls.filter(([args])=>args.action==='focus').at(-1)?.[0].focused).toBe(false));
 act(()=>{document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));});
 await act(async()=>{await tick();});
 await waitFor(()=>expect(host.request.mock.calls.filter(([args])=>args.action==='focus').at(-1)?.[0].focused).toBe(true));
});

it('same-generation overlay motion sends atomic rect and clip without a per-frame visibility toggle',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...p} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});host.request.mockClear();
 lifeState={...lifeState,moving:true,generation:8,overlays:[{x:30,y:40,width:90,height:80}]};
 act(()=>lifeListeners.forEach(listener=>listener(lifeState)));
 await waitFor(()=>expect(host.request.mock.calls.some(([args])=>args.action==='rect'&&args.generation==='8')).toBe(true));
 const layout=host.request.mock.calls.find(([args])=>args.action==='rect'&&args.generation==='8')![0];
 expect(layout.holes).toEqual([[30,40,90,80]]);expect(host.request.mock.calls.some(([args])=>args.action==='visible')).toBe(false);
});

it('first overlay preparation holds an existing visible surface until its atomic native cutout ACK',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...p} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});host.request.mockClear();
 lifeState={...lifeState,generation:9,overlayReady:false,overlays:[{x:30,y:40,width:90,height:80}]};
 act(()=>lifeListeners.forEach(listener=>listener(lifeState)));await tick();
 expect(host.request).not.toHaveBeenCalled();
 lifeState={...lifeState,overlayReady:true};act(()=>lifeListeners.forEach(listener=>listener(lifeState)));
 await waitFor(()=>expect(host.request.mock.calls.some(([args])=>args.action==='rect'&&args.generation==='9')).toBe(true));
 expect(host.request.mock.calls.some(([args])=>args.action==='visible'&&args.visible===false)).toBe(false);
});

it('local clear waits for consumed old partial sequences, rotates owner and feeds only the new chunk floor',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});const old=latestToken;
 view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:1,data:'\x1b]0;unfinished'},{id:2,data:'old tail'}]} nativeCursor={{seq:2,epoch:'stream-a'}}/>);
 await waitFor(()=>expect(writes).toHaveLength(1));act(()=>ref.current!.clear());
 view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:1,data:'\x1b]0;unfinished'},{id:2,data:'old tail'},{id:3,data:'suffix'}]} nativeCursor={{seq:3,epoch:'stream-a'}}/>);
 expect(host.request.mock.calls.some(([a])=>a.action==='localReset')).toBe(false);
 act(()=>emit(old,{type:'ack',sequence:1}));await waitFor(()=>expect(writes).toHaveLength(2));expect(host.request.mock.calls.some(([a])=>a.action==='localReset')).toBe(false);
 act(()=>emit(old,{type:'ack',sequence:2}));await waitFor(()=>expect(writes).toHaveLength(3));expect(latestToken).not.toBe(old);
 expect(atob(writes[2].base64)).toBe('suffix');expect(writes[2]).toMatchObject({token:latestToken,sequence:1,replay:false,cursor:{seq:3,epoch:'stream-a'}});
 act(()=>emit(old,{type:'ack',sequence:1}));expect(p.onWriteProgress).toHaveBeenCalledTimes(2);
 act(()=>emit(latestToken,{type:'ack',sequence:1}));expect(p.onWriteProgress).toHaveBeenLastCalledWith(3);
 expect(creates).toHaveLength(1);expect(host.request.mock.calls.filter(([a])=>a.action==='localReset')).toHaveLength(1);
});
it('AppKit line-edit keys use the existing owned page input and unknown Command never sends terminal bytes',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 for(const [key,keyCode,data] of [['\r',36,'\r'],['\x7f',51,'\x15'],['\uf728',117,'\x0b'],['\uf702',123,'\x01'],['\uf703',124,'\x05']] as const){act(()=>emit(latestToken,{type:'shortcut',key,keyCode,modifiers:8}));expect(p.onInput).toHaveBeenLastCalledWith(data,{skipModifierTransform:true});}
 const before=(p.onInput as any).mock.calls.length;act(()=>emit(latestToken,{type:'shortcut',key:'q',keyCode:12,modifiers:8}));act(()=>emit(latestToken,{type:'shortcut',key:'\r',keyCode:36,modifiers:9}));expect(p.onInput).toHaveBeenCalledTimes(before);
});
it('native paste callback cleans Unicode and mixed newlines once without submitting Enter',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 act(()=>emit(latestToken,{type:'pasteText',text:'a\u00a0\u200b中\r\nb\n'}));expect(p.onInput).toHaveBeenLastCalledWith('\x1b[200~a 中\rb\r\x1b[201~',{skipModifierTransform:true});
});
for(const status of ['Empty','TooLarge','Unreadable'])it(`copy ${status} is nonfatal and keeps the current receiver for output and layout`,async()=>{
 const p=props(),fallback=vi.fn(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} onNativeRendererFailed={fallback} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});const token=latestToken,normal=host.request.getMockImplementation()!;
 host.request.mockImplementation(async(args:any)=>args.action==='copy'?{status}:normal(args));
 await act(async()=>{expect(await ref.current!.copySelectionOrViewport()).toBe(false);});expect(view.getByRole('alert')).toBeTruthy();expect(fallback).not.toHaveBeenCalled();expect(latestToken).toBe(token);expect(ref.current!.renderer!()).toBe('native');
 view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:1,data:'continued'}]}/>);await waitFor(()=>expect(writes).toHaveLength(1));act(()=>emit(token,{type:'ack',sequence:1}));expect(p.onWriteProgress).toHaveBeenCalledWith(1);
});
it('search close ends the owned engine search and rejects a late query result before focus restoration',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});act(()=>emit(latestToken,{type:'search',text:''}));
 let result!:(value:any)=>void;const normal=host.request.getMockImplementation()!;host.request.mockImplementation(async(args:any)=>args.action==='search'&&args.direction===0?await new Promise(resolve=>{result=resolve;}):args.action==='search'?{total:0,selected:-1}:normal(args));
 fireEvent.change(view.getByLabelText('搜索终端'),{target:{value:'old'}});await waitFor(()=>expect(result).toBeTypeOf('function'));fireEvent.click(view.getByLabelText('关闭终端搜索'));
 expect(host.request.mock.calls.some(([a])=>a.action==='search'&&a.direction===2)).toBe(false);
 await act(async()=>{result({total:99,selected:0});await tick();});await waitFor(()=>expect(view.queryByLabelText('搜索终端')).toBeNull());
 expect(view.queryByText('99')).toBeNull();expect(host.request.mock.calls.filter(([a])=>a.action==='search'&&a.direction===2)).toHaveLength(1);
 act(()=>emit(latestToken,{type:'search',text:'new'}));expect(view.getByLabelText('搜索终端')).toBeTruthy();
});

it('backend transition waits for local reset capability and rejects old input while the new backend props are active',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} backendSessionId="backend-a" ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});const old=latestToken;
 view.rerender(<NativeTerminalViewport {...p} backendSessionId="backend-a" ref={ref} chunks={[{id:1,data:'old'}]} nativeCursor={{seq:1,epoch:'stream-a'}}/>);await waitFor(()=>expect(writes).toHaveLength(1));act(()=>ref.current!.clear());
 view.rerender(<NativeTerminalViewport {...p} backendSessionId="backend-b" ref={ref} chunks={[{id:2,data:'new'}]}/>);act(()=>emit(old,{type:'input',base64:btoa('old input')}));expect(p.onInput).not.toHaveBeenCalled();
 const transition=ref.current!.prepareNativeSession!('backend-b');await tick();expect(creates).toHaveLength(1);act(()=>emit(old,{type:'ack',sequence:1}));await act(async()=>{await transition;});expect(creates.at(-1)?.session).toBe('backend-b');expect(writes).toHaveLength(1);
});
it('late native terminal shortcuts are inert while a real DOM editable owns focus',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});act(()=>emit(latestToken,{type:'search',text:''}));view.getByLabelText('搜索终端').focus();
 act(()=>emit(latestToken,{type:'shortcut',key:'\r',keyCode:36,modifiers:8}));act(()=>emit(latestToken,{type:'shortcut',key:'k',keyCode:40,modifiers:2}));expect(p.onInput).not.toHaveBeenCalled();expect(host.request.mock.calls.some(([a])=>a.action==='localReset')).toBe(false);
});
it('a real prepare rebind registers after the old retirement receipt and still consumes new output',async()=>{
 const {retireNativeLease}=await import('./nativeLifetime');
 const p=props(),ref=React.createRef<TerminalController>(),notice=vi.fn();window.addEventListener('termdock:native-cleanup-error',notice);
 const view=render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});const old=latestToken;
 view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:1,data:'before-gap'}]} nativeCursor={{seq:41,epoch:'stream-a'}}/>);await waitFor(()=>expect(writes).toHaveLength(1));act(()=>emit(old,{type:'ack',sequence:1}));
 const original=host.request.getMockImplementation()!;let release!:(value:any)=>void,created!:(value:any)=>void;const hostCreated=new Promise<any>(resolve=>{created=resolve;});retain=true;
 host.request.mockImplementation(async(args:any)=>{
  if(args.action==='create'){const result=await original(args);created(result);return await new Promise(resolve=>{release=resolve;});}
  if(args.action==='retireView'&&args.token===old)return{view:args.view,token:old,epoch:'page-a',detached:false,disposition:'superseded',replacementToken:latestToken};
  return original(args);
 });
 await act(async()=>{
  const preparing=ref.current!.prepareNativeSession!('backend-a');const fresh=await hostCreated;
  const retiring=retireNativeLease('frontend-panel',old);await Promise.resolve();await Promise.resolve();release(fresh);
  await preparing;await expect(retiring).resolves.toBe('superseded');
 });
 expect(ref.current!.renderer!()).toBe('native');expect(notice).not.toHaveBeenCalled();
 view.rerender(<NativeTerminalViewport {...p} ref={ref} chunks={[{id:2,data:'live-after-gap'}]} nativeCursor={{seq:42,epoch:'stream-a'}}/>);await waitFor(()=>expect(writes).toHaveLength(2));
 expect(writes[1]).toMatchObject({token:latestToken,sequence:2,cursor:{seq:42,epoch:'stream-a'}});
 act(()=>emit(old,{type:'ack',sequence:2}));expect(p.onWriteProgress).toHaveBeenCalledTimes(1);
 act(()=>emit(latestToken,{type:'ack',sequence:2}));expect(p.onWriteProgress).toHaveBeenCalledWith(2);window.removeEventListener('termdock:native-cleanup-error',notice);
});
for(const split of [false,true])it(`three ${split?'visible split panes':'tabs'} reject queued inactive focus and route native input only to the selected session`,async()=>{
 const refs=[0,1,2].map(()=>React.createRef<TerminalController>()),ps=[0,1,2].map(i=>({...props(),sessionKey:`terminal::input-front-${split}-${i}`,sessionId:`input-front-${split}-${i}`,backendSessionId:`input-back-${i}`}));
 let active=0;const removed=new Set<number>();const ui=()=> <>{ps.map((p,i)=>removed.has(i)?null:<NativeTerminalViewport key={p.sessionKey} {...p} ref={refs[i]} autoFocus={active===i} inputActive={active===i} isLayoutVisible={split||active===i}/>)}</>;
 const view=render(ui()),tokens:string[]=[];
 for(let i=0;i<3;i++)await act(async()=>{await refs[i].current!.prepareNativeSession!(`input-back-${i}`);tokens[i]=latestToken;});
 for(const next of [1,2,0]){
  const previous=active,original=host.request.getMockImplementation()!;let unblock!:()=>void,started!:()=>void;const start=new Promise<void>(resolve=>{started=resolve;});
  host.request.mockImplementation(async(args:any)=>{if(args.action==='checkpoint'&&args.token===tokens[previous]){started();await new Promise<void>(resolve=>{unblock=resolve;});return null;}return original(args);});
  const prior=refs[previous].current!.saveNativeCursor!({seq:1,epoch:'input-stream'});await start;
  refs[previous].current!.focus();host.request.mockClear();active=next;view.rerender(ui());refs[next].current!.focus();
  await act(async()=>{unblock();await prior;await tick();});
  await waitFor(()=>expect(host.request.mock.calls.some(([a]:any)=>a.action==='focus'&&a.focused===true&&a.token===tokens[next])).toBe(true));
  expect(host.request.mock.calls.some(([a]:any)=>a.action==='focus'&&a.focused===true&&a.token===tokens[previous])).toBe(false);
  refs[previous].current!.blur();await act(tick);expect(host.request.mock.calls.some(([a]:any)=>a.action==='focus'&&a.focused===false&&a.token===tokens[previous])).toBe(true);
  ps.forEach(p=>(p.onInput as any).mockClear());
  await act(async()=>{tokens.forEach((token,i)=>emit(token,{type:'input',base64:btoa(`input-${i}`)}));});
  ps.forEach((p,i)=>{if(i===active)expect(p.onInput).toHaveBeenCalledWith(`input-${i}`,{skipModifierTransform:true});else expect(p.onInput).not.toHaveBeenCalled();});
  host.request.mockImplementation(original);
 }
 active=2;view.rerender(ui());
 for(const i of [0,1]){
  await act(async()=>{await closeNativeSession(ps[i].sessionId!);});
  removed.add(i);view.rerender(ui());await act(tick);
 }
 host.request.mockClear();refs[2].current!.focus();await act(tick);
 expect(view.container.querySelector('[data-termdock-terminal-dropzone]')?.getAttribute('aria-disabled')).toBe('false');
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='focus'&&a.focused===true&&a.token===tokens[2])).toBe(true);
 ps.forEach(p=>(p.onInput as any).mockClear());await act(async()=>{tokens.forEach((token,i)=>emit(token,{type:'input',base64:btoa(`after-delete-${i}`)}));});
 expect(ps[0].onInput).not.toHaveBeenCalled();expect(ps[1].onInput).not.toHaveBeenCalled();expect(ps[2].onInput).toHaveBeenCalledWith('after-delete-2',{skipModifierTransform:true});
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='retireView'&&a.token===tokens[2])).toBe(false);
});
it('a current native pointer releases the old DOM editable and restores normal explicit focus',async()=>{
 vi.stubGlobal('PointerEvent',MouseEvent);
 const p=props(),ref=React.createRef<TerminalController>(),failed=vi.fn();
 const view=render(<><input aria-label="previous field"/><NativeTerminalViewport {...p} ref={ref} inputActive onNativeRendererFailed={failed}/></>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 const input=view.getByLabelText('previous field');await act(async()=>{input.focus();await tick();});expect(document.activeElement).toBe(input);
 act(()=>emit('old-token',{type:'pointer'}));expect(document.activeElement).toBe(input);
 const start=host.request.mock.calls.length;act(()=>emit(latestToken,{type:'pointer'}));
 await waitFor(()=>expect(document.activeElement).not.toBe(input));
 await waitFor(()=>expect(host.request.mock.calls.slice(start).some(([value])=>value.action==='focus'&&value.focused===true)).toBe(true));expect(failed).not.toHaveBeenCalled();
});
it('native pointer waits for current input eligibility and a newer DOM focus cancels the old intent',async()=>{
 vi.stubGlobal('PointerEvent',MouseEvent);
 const p=props(),ref=React.createRef<TerminalController>();
 const Page=({active}:{active:boolean})=><><input aria-label="first field"/><input aria-label="new field"/><NativeTerminalViewport {...p} ref={ref} inputActive={active} autoFocus={false}/></>;
 const view=render(<Page active={false}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 const first=view.getByLabelText('first field'),next=view.getByLabelText('new field');
 await act(async()=>{first.focus();await tick();});const start=host.request.mock.calls.length;
 act(()=>emit(latestToken,{type:'pointer'}));await act(async()=>{await tick();});expect(document.activeElement).toBe(first);
 expect(host.request.mock.calls.slice(start).some(([value])=>value.action==='focus'&&value.focused===true)).toBe(false);
 view.rerender(<Page active/>);await waitFor(()=>expect(document.activeElement).not.toBe(first));
 await waitFor(()=>expect(host.request.mock.calls.slice(start).some(([value])=>value.action==='focus'&&value.focused===true)).toBe(true));
 view.rerender(<Page active={false}/>);await act(async()=>{first.focus();await tick();});act(()=>emit(latestToken,{type:'pointer'}));
 await act(async()=>{next.focus();await tick();});const after=host.request.mock.calls.length;view.rerender(<Page active/>);await act(async()=>{await tick();await tick();});
 expect(document.activeElement).toBe(next);expect(host.request.mock.calls.slice(after).some(([value])=>value.action==='focus'&&value.focused===true)).toBe(false);
});

for(const failed of [false,true])it(`atomic rect show invalidates earlier hide proof before replacement retirement (host failure ${failed})`,async()=>{
 const normal=host.request.getMockImplementation()!;let retired!:(value:unknown)=>void;
 host.request.mockImplementation(async(a:any)=>{
  if(a.action==='retireView'&&a.token==='proof-old')return new Promise(resolve=>{retired=resolve;});
  if(a.action==='visible'&&a.visible===false)return {visible:false,epoch:'page-a'};
  if(failed&&a.action==='rect'&&a.generation==='71')throw Error('Owned atomic layout failure');
  return normal(a);
 });
 registerNativeLease('frontend-panel','proof-old',host as any,'page-a');const pending=retireNativeLease('frontend-panel','proof-old');
 const expected=expect(pending).rejects.toThrow('Native retirement replacement was not confirmed');
 const ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...props()} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});const token=latestToken;
 await hideNativeLease('frontend-panel',token);
 lifeState={...lifeState,generation:71,overlays:[{x:20,y:30,width:80,height:60}]};
 act(()=>{for(const listener of lifeListeners)listener(lifeState);});
 await waitFor(()=>expect(host.request.mock.calls.some(([a])=>a.action==='rect'&&a.generation==='71')).toBe(true));
 retired({view:'frontend-panel',token:'proof-old',epoch:'page-a',detached:false,disposition:'superseded',replacementToken:token});await expected;
});
it('late hide after atomic rect cannot release the current replacement guard',async()=>{
 const normal=host.request.getMockImplementation()!;let hidden!:(value:unknown)=>void;
 const ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...props()} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});
 host.request.mockImplementation(async(a:any)=>a.action==='visible'&&a.visible===false?new Promise(resolve=>{hidden=resolve;}):normal(a));
 const pending=hideNativeLease('frontend-panel',latestToken);const guard=window.termdockPreviewLifecycle!.nativePanels as ReturnType<typeof vi.fn>;guard.mockClear();
 lifeState={...lifeState,generation:72,overlays:[{x:20,y:30,width:80,height:60}]};act(()=>{for(const listener of lifeListeners)listener(lifeState);});
 await waitFor(()=>expect(host.request.mock.calls.some(([a])=>a.action==='rect'&&a.generation==='72')).toBe(true));
 hidden({visible:false,epoch:'page-a'});await pending;expect(guard).not.toHaveBeenCalledWith(false);
});

it('explicit current CmdC reads only the bound tmux selection and copies its confirmed UTF8 text',async()=>{
 const p={...props(),onTmuxScroll:vi.fn()},ref=React.createRef<TerminalController>(),writeText=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 copyModel.request.mockResolvedValue({success:true,selection:{status:'copied',paneId:'%17',text:'选区',bytes:6}});
 render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 act(()=>emit(latestToken,{type:'shortcut',key:'c',keyCode:8,modifiers:8}));
 await waitFor(()=>expect(writeText).toHaveBeenCalledWith('选区'));expect(copyModel.request).toHaveBeenCalledWith('backend-a',{action:'copy-selection'});expect(p.onInput).not.toHaveBeenCalled();
});
for(const change of ['target','inactive','unmount'] as const)it(`late tmux copy cannot write clipboard after ${change}`,async()=>{
 const p={...props(),onTmuxScroll:vi.fn()},ref=React.createRef<TerminalController>(),writeText=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 let finish!:(value:unknown)=>void;copyModel.request.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
 const view=render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 act(()=>emit(latestToken,{type:'shortcut',key:'c',keyCode:8,modifiers:8}));expect(copyModel.request).toHaveBeenCalledTimes(1);
 if(change==='target')copyModel.target={targetPeerId:'target-a'};else if(change==='inactive')view.rerender(<NativeTerminalViewport {...p} inputActive={false} ref={ref}/>);else view.unmount();
 await act(async()=>{finish({success:true,selection:{status:'copied',paneId:'%1',text:'old',bytes:3}});await tick();});expect(writeText).not.toHaveBeenCalled();expect(p.onInput).not.toHaveBeenCalled();
});
it('empty tmux selection preserves clipboard and unsupported service reports failure without sending CtrlC',async()=>{
 const p={...props(),onTmuxScroll:vi.fn()},ref=React.createRef<TerminalController>(),writeText=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 copyModel.request.mockResolvedValue({success:true,selection:{status:'empty',paneId:'%1',text:'',bytes:0}});
 const view=render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 await act(async()=>{emit(latestToken,{type:'shortcut',key:'c',keyCode:8,modifiers:8});await tick();});expect(writeText).not.toHaveBeenCalled();
 copyModel.request.mockResolvedValue({success:true});await act(async()=>{emit(latestToken,{type:'shortcut',key:'c',keyCode:8,modifiers:8});await tick();});
 expect(view.getByRole('alert').textContent).toContain('did not confirm');expect(writeText).not.toHaveBeenCalled();expect(p.onInput).not.toHaveBeenCalled();
});
it('typed copy failures report copying rather than rejected terminal input and never retire the renderer',async()=>{
 const p=props(),ref=React.createRef<TerminalController>(),failed=vi.fn();const view=render(<NativeTerminalViewport {...p} ref={ref} onNativeRendererFailed={failed}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 act(()=>emit(latestToken,{type:'copyFailed',status:'TooLarge'}));expect(view.getByRole('alert').textContent).toContain('Copy exceeds');expect(failed).not.toHaveBeenCalled();expect(p.onInput).not.toHaveBeenCalled();
});

for(const message of ['Tmux selection exceeds the 256 KiB copy limit','Tmux selection read failed','Tmux selection target changed while copying'])it(`tmux CmdC error preserves the clipboard: ${message}`,async()=>{
 const p={...props(),onTmuxScroll:vi.fn()},ref=React.createRef<TerminalController>(),writeText=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});copyModel.request.mockRejectedValue(new Error(message));
 const view=render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 await act(async()=>{emit(latestToken,{type:'shortcut',key:'c',keyCode:8,modifiers:8});await tick();});expect(view.getByRole('alert').textContent).toContain(message);expect(writeText).not.toHaveBeenCalled();expect(p.onInput).not.toHaveBeenCalled();
});

it('a newer same-owner CmdC completion supersedes an older pending result',async()=>{
 const p={...props(),onTmuxScroll:vi.fn()},ref=React.createRef<TerminalController>(),writeText=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 let finish!:(v:unknown)=>void;copyModel.request.mockReturnValueOnce(new Promise(r=>{finish=r;})).mockResolvedValueOnce({success:true,selection:{status:'copied',paneId:'%1',text:'new',bytes:3}});
 const view=render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 act(()=>emit(latestToken,{type:'shortcut',key:'c',modifiers:8}));
 await act(async()=>{emit(latestToken,{type:'shortcut',key:'c',modifiers:8});await tick();});
 await act(async()=>{finish({success:true,selection:{status:'copied',paneId:'%1',text:'old',bytes:3}});await tick();});
 expect(writeText.mock.calls).toEqual([['new']]);expect(view.queryByRole('alert')).toBeNull();
});
it('recognized clipboard file upload failure never falls back to image or text',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 vi.mocked(clipboard.readTerminalClipboardFiles).mockResolvedValueOnce({paths:[],files:[new File(['x'],'owned.txt')]});vi.mocked(clipboard.uploadTerminalClipboardFiles).mockRejectedValueOnce(new Error('owned upload failed'));vi.mocked(clipboard.readTerminalClipboardImage).mockClear();
 await act(async()=>{expect(await ref.current!.pasteClipboardText!()).toBe(false);});
 expect(view.getByRole('alert').textContent).toContain('owned upload failed');expect(clipboard.readTerminalClipboardImage).not.toHaveBeenCalled();expect(host.request.mock.calls.some(([a])=>a.action==='clipboardText')).toBe(false);expect(p.onInput).not.toHaveBeenCalled();
});
it('an empty final text read preserves the original clipboard file read failure',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();const view=render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 vi.mocked(clipboard.readTerminalClipboardFiles).mockRejectedValueOnce(new Error('owned file unavailable'));vi.mocked(clipboard.readTerminalClipboardImage).mockResolvedValueOnce(null);const normal=host.request.getMockImplementation()!;host.request.mockImplementation(a=>a.action==='clipboardText'?Promise.resolve(''):normal(a));
 await act(async()=>{expect(await ref.current!.pasteClipboardText!()).toBe(false);});expect(view.getByRole('alert').textContent).toContain('owned file unavailable');expect(p.onInput).not.toHaveBeenCalled();
});
it('ordinary selection events do not invalidate an in-flight paste operation',async()=>{
 const p=props(),ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 vi.mocked(clipboard.readTerminalClipboardFiles).mockResolvedValueOnce({paths:[],files:[new File(['x'],'owned.txt')]});let finish!:(v:string[])=>void;vi.mocked(clipboard.uploadTerminalClipboardFiles).mockReturnValueOnce(new Promise(r=>{finish=r;}));
 let pending!:Promise<boolean>;act(()=>{pending=ref.current!.pasteClipboardText!();});await waitFor(()=>expect(finish).toBeTypeOf('function'));
 act(()=>emit(latestToken,{type:'selection',text:'mouse selection'}));
 await act(async()=>{finish(['/tmp/owned.txt']);expect(await pending).toBe(true);});expect(p.onInput).toHaveBeenCalledTimes(1);
});
it('late typed-copy selection cannot write clipboard after a newer paste begins',async()=>{
 const p=props(),ref=React.createRef<TerminalController>(),writeText=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});const normal=host.request.getMockImplementation()!;host.request.mockImplementation(a=>a.action==='copy'?Promise.resolve({status:'Copied'}):normal(a));
 let copied!:Promise<boolean>;act(()=>{copied=ref.current!.copySelectionOrViewport!();});await waitFor(()=>expect(host.request.mock.calls.some(([a])=>a.action==='copy')).toBe(true));
 vi.mocked(clipboard.readTerminalClipboardFiles).mockResolvedValueOnce({paths:['/tmp/new'],files:[]});await act(async()=>{await ref.current!.pasteClipboardText!();});
 await act(async()=>{emit(latestToken,{type:'selection',text:'old copied text'});expect(await copied).toBe(false);});expect(writeText).not.toHaveBeenCalled();
});

it('restores logical focus only from current actual responder events after suspension',async()=>{
 const p=props(),changed=vi.fn(),ref=React.createRef<TerminalController>();
 const view=render(<NativeTerminalViewport {...p} inputActive={true} onInputFocusChange={changed} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 act(()=>emit(latestToken,{type:'focusChanged',focused:true,revision:1}));expect(changed).toHaveBeenLastCalledWith(true);
 view.rerender(<NativeTerminalViewport {...p} inputActive={false} onInputFocusChange={changed} ref={ref}/>);
 act(()=>ref.current!.blur());expect(changed).toHaveBeenLastCalledWith(false);
 act(()=>emit(latestToken,{type:'focusChanged',focused:true,revision:2}));expect(changed).toHaveBeenLastCalledWith(false);
 view.rerender(<NativeTerminalViewport {...p} inputActive={true} onInputFocusChange={changed} ref={ref}/>);
 await act(async()=>{await tick();});expect(changed).toHaveBeenLastCalledWith(false);
 act(()=>emit(latestToken,{type:'focusChanged',focused:true,revision:4}));expect(changed).toHaveBeenLastCalledWith(true);
 const count=changed.mock.calls.length;
 act(()=>{emit(latestToken,{type:'focusChanged',focused:false,revision:3});emit('old-token',{type:'focusChanged',focused:false,revision:5});});expect(changed).toHaveBeenCalledTimes(count);
 act(()=>emit(latestToken,{type:'focusChanged',focused:false,revision:5}));expect(changed).toHaveBeenLastCalledWith(false);
 const input=document.createElement('input');document.body.append(input);act(()=>input.focus());
 act(()=>emit(latestToken,{type:'focusChanged',focused:true,revision:6}));expect(changed).toHaveBeenLastCalledWith(false);input.remove();
});

it.each(['offscreen','overflow','hidden'])('preparing a %s pane never submits an invalid native rectangle',async(mode)=>{
 const p=props(),fallback=vi.fn(),ref=React.createRef<TerminalController>();
 let bounds={x:0,y:0,left:0,top:0,right:400,bottom:300,width:400,height:300,toJSON(){}};
 if(mode==='offscreen')bounds={...bounds,x:-400,left:-400,right:0};
 if(mode==='overflow')bounds={...bounds,width:innerWidth+100,right:innerWidth+100};
 vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(()=>bounds);
 const view=render(<NativeTerminalViewport {...p} isLayoutVisible={mode!=='hidden'} onNativeRendererFailed={fallback} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='rect')).toBe(false);expect(fallback).not.toHaveBeenCalled();
 bounds={...bounds,x:0,left:0,width:400,right:400};
 view.rerender(<NativeTerminalViewport {...p} isLayoutVisible onNativeRendererFailed={fallback} ref={ref}/>);
 act(()=>lifeListeners.forEach(fn=>fn(lifeState)));await tick();
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='rect'&&a.width===400&&a.x===0)).toBe(true);
});

it('resamples the rectangle after an asynchronous failed restore and window resize',async()=>{
 const p=props(),ref=React.createRef<TerminalController>(),normal=host.request.getMockImplementation()!;
 let width=400;vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(()=>({x:0,y:0,left:0,top:0,right:width,bottom:200,width,height:200,toJSON(){}}));
 host.cached={savedAt:Date.now(),version:1,engine:'td3',data:'bad',cursor:{seq:40,epoch:'stream-a'}};
 host.request.mockImplementation(async(args:any)=>{
  if(args.action==='restore'){width=240;vi.stubGlobal('innerWidth',300);throw Error('invalid snapshot');}
  if(args.action==='rect')expect(args.x+args.width).toBeLessThanOrEqual(args.viewportWidth);
  return normal(args);
 });
 render(<NativeTerminalViewport {...p} ref={ref}/>);await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='rect'&&a.width===240&&a.viewportWidth===300)).toBe(true);
});

it('a rejected in-flight control from the previous initialization cannot fail the new terminal',async()=>{
 const p=props(),ref=React.createRef<TerminalController>(),fallback=vi.fn();
 render(<NativeTerminalViewport {...p} onNativeRendererFailed={fallback} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');});
 const old=latestToken,normal=host.request.getMockImplementation()!;let rejectOld!:(error:Error)=>void;
 host.request.mockImplementation(async(args:any)=>args.action==='focus'&&args.focused===false&&args.token===old?new Promise((_resolve,reject)=>{rejectOld=reject;}):normal(args));
 await act(async()=>{ref.current!.blur();await tick();});
 await act(async()=>{
  const next=ref.current!.prepareNativeSession!('backend-b');await tick();
  rejectOld(Error('Native capability belongs to another window/page/target'));
  await next;
 });
 expect(fallback).not.toHaveBeenCalled();expect(ref.current!.renderer!()).toBe('native');
 expect(creates.at(-1)!.session).toBe('backend-b');
});

it('supersedes a busy resize instead of replaying queued obsolete rectangles',async()=>{
 const p=props(),ref=React.createRef<TerminalController>(),normal=host.request.getMockImplementation()!;
 let width=400;
 vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(()=>({x:0,y:0,left:0,top:0,right:width,bottom:300,width,height:300,toJSON(){}}));
 render(<NativeTerminalViewport {...p} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});
 const seen:number[]=[];
 host.request.mockImplementation(async(a:any)=>{
  if(a.action==='rect'){
   seen.push(a.width);
   if(a.width===390)throw Error('pending batch or callbacks must be drained');
  }
  return normal(a);
 });
 await act(async()=>{width=390;lifeState={...lifeState,generation:1};lifeListeners.forEach(fn=>fn(lifeState));await tick();});
 await act(async()=>{width=370;lifeState={...lifeState,generation:2};lifeListeners.forEach(fn=>fn(lifeState));width=340;lifeState={...lifeState,generation:3};lifeListeners.forEach(fn=>fn(lifeState));await new Promise(resolve=>setTimeout(resolve,45));});
 expect(seen).toContain(340);expect(seen).not.toContain(370);
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='fontSize')).toBe(false);
});

it('resamples stale host geometry without hiding or focusing the old rectangle',async()=>{
 const p=props(),ref=React.createRef<TerminalController>(),normal=host.request.getMockImplementation()!;
 render(<NativeTerminalViewport {...p} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});
 host.request.mockClear();let attempts=0;
 host.request.mockImplementation(async(a:any)=>a.action==='rect'&&++attempts===1?{rectApplied:false,staleGeometry:true}:normal(a));
 await act(async()=>{lifeState={...lifeState,generation:11};lifeListeners.forEach(fn=>fn(lifeState));await new Promise(resolve=>setTimeout(resolve,60));});
 expect(attempts).toBeGreaterThanOrEqual(2);
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='visible'&&a.visible===false)).toBe(false);
});

it('does not blank a visible pane when the viewport resizes one frame before flex layout',async()=>{
 vi.stubGlobal('innerWidth',400);let width=400;
 vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(()=>({x:0,y:0,left:0,top:0,right:width,bottom:300,width,height:300,toJSON(){}}));
 const ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...props()} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});
 host.request.mockClear();
 await act(async()=>{
  vi.stubGlobal('innerWidth',350);lifeState={...lifeState,generation:12};lifeListeners.forEach(fn=>fn(lifeState));
  width=350;await new Promise(resolve=>setTimeout(resolve,60));
 });
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='visible'&&a.visible===false)).toBe(false);
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='rect'&&a.width===350&&a.viewportWidth===350)).toBe(true);
});

it('keeps a resizing pane clipped and visible across several stale flex callbacks',async()=>{
 vi.stubGlobal('innerWidth',400);let width=400;
 vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(()=>({x:0,y:0,left:0,top:0,right:width,bottom:300,width,height:300,toJSON(){}}));
 const ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...props()} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});
 host.request.mockClear();
 await act(async()=>{vi.stubGlobal('innerWidth',350);lifeListeners.forEach(fn=>fn(lifeState));await new Promise(resolve=>setTimeout(resolve,70));});
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='visible'&&a.visible===false)).toBe(false);
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='rect'&&a.width===350&&a.viewportWidth===350)).toBe(true);
 await act(async()=>{width=350;lifeListeners.forEach(fn=>fn(lifeState));await tick();});
});
it('retries a presented pending grid on the next frame without hiding or focusing it',async()=>{
 const ref=React.createRef<TerminalController>();render(<NativeTerminalViewport {...props()} ref={ref}/>);
 await act(async()=>{await ref.current!.prepareNativeSession!('backend-a');await tick();});
 const normal=host.request.getMockImplementation()!;let pending=true;
 host.request.mockClear();host.request.mockImplementation(async(a:any)=>a.action==='rect'&&pending?{rectApplied:false,layoutPending:true}:normal(a));
 await act(async()=>{lifeState={...lifeState,generation:20};lifeListeners.forEach(fn=>fn(lifeState));await new Promise(resolve=>setTimeout(resolve,55));});
 expect(host.request.mock.calls.filter(([a]:any)=>a.action==='rect').length).toBeGreaterThan(1);
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='visible'||a.action==='focus')).toBe(false);
 await act(async()=>{pending=false;await new Promise(resolve=>setTimeout(resolve,55));});
 expect(host.request.mock.calls.some(([a]:any)=>a.action==='focus')).toBe(true);
});
