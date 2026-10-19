// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const host=vi.hoisted(()=>({listeners:new Set<(value:any)=>void>(),request:vi.fn(),token:'',serial:0,writes:[] as any[]}));
vi.mock('../terminal/TerminalViewport',async()=>({TerminalViewport:(await import('../../terminal/nativeViewport')).NativeTerminalViewport}));
vi.mock('../../desktop/nativeBridge',()=>{const nativeTerminal={available:true,request:host.request,subscribe:(listener:any)=>{host.listeners.add(listener);return()=>host.listeners.delete(listener);}};return{getTermdockDesktopBridge:()=>({nativeTerminal}),subscribeNativeFileDrops:()=>()=>{}};});
vi.mock('../../federation/deviceIdentity',()=>({getIdentity:async()=>({peerId:'controlled-device'})}));
vi.mock('../../federation/browserIntegration',()=>({secureSocket:(url:string)=>new WebSocket(url)}));
vi.mock('../../terminal/nativeSnapshotCache',()=>({readNativeSnapshot:async()=>null,writeNativeSnapshot:async()=>{},deleteNativeSnapshot:async()=>true,nativeSnapshotRevision:()=>0,tagNativeSnapshot:(value:any)=>value}));
vi.mock('../../utils/terminalSnapshotCache',()=>({readTerminalSnapshot:async()=>null,writeTerminalSnapshot:async()=>{}}));
vi.mock('../../terminal/api',async original=>({...await original<any>(),getSettings:async()=>({}),openSessionInventoryEntry:vi.fn(async()=>({})),updateSessionInventoryEntry:vi.fn(async()=>({}))}));
import {TerminalView} from './TerminalView';
import {I18nProvider} from '../../i18n';
import {useTerminalStore} from '../../stores/useTerminalStore';
import {getAppliedTerminalCursor} from '../../terminal/api';
class Socket {
 static OPEN=1;static CONNECTING=0;static CLOSED=3;static sockets:Socket[]=[];
 readyState=0;onopen:(()=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;onclose:((event:CloseEvent)=>void)|null=null;onerror:(()=>void)|null=null;sent:any[]=[];
 constructor(readonly url:string){Socket.sockets.push(this);}
 send(raw:string){this.sent.push(JSON.parse(raw));}
 close(){this.readyState=3;}
 event(value:any){this.onmessage?.(new MessageEvent('message',{data:JSON.stringify(value)}));}
}
const emit=(sequence:number,token=host.token)=>host.listeners.forEach(listener=>listener({token,epoch:'controlled-page',event:{type:'ack',sequence}}));
beforeEach(()=>{
 host.listeners.clear();host.writes=[];host.serial=0;host.token='';host.request.mockReset();Socket.sockets=[];sessionStorage.clear();localStorage.clear();
 vi.stubGlobal('WebSocket',Socket);vi.stubGlobal('fetch',vi.fn(()=>new Promise(()=>{})));
 // Deliberately never deliver an animation frame; timers and native receipts run.
 vi.stubGlobal('requestAnimationFrame',vi.fn(()=>1));vi.stubGlobal('cancelAnimationFrame',vi.fn());
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:400,bottom:300,width:400,height:300,toJSON(){}});
 Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
 window.termdockPreviewLifecycle={snapshot:()=>({hidden:false,focused:true,overlays:[],viewport:{width:innerWidth,height:innerHeight,scale:1},generation:0,overlayReady:true}),subscribe:()=>()=>{},nativePanels:vi.fn()};
 host.request.mockImplementation(async(args:any)=>{
  if(args.action==='create'){host.token=`controlled-${++host.serial}`;return{token:host.token,epoch:'controlled-page',sequence:0,baseline:null,reused:false};}
  if(args.action==='layout')return{complete:true,token:args.token,epoch:'controlled-page',dimensions:{cols:80,rows:24}};
  if(args.action==='visible')return{visible:args.visible};
  if(args.action==='retireView')return{detached:true,view:args.view};
  if(args.action==='write'){host.writes.push(args);return{pending:args.sequence};}
  return null;
 });
 useTerminalStore.getState().setActiveSessionId('controlled-panel');useTerminalStore.getState().setTerminalSession('controlled-panel',{sessionId:'controlled-backend',mode:'shell',cols:80,rows:24});
});
afterEach(()=>{delete (document as any).hidden;delete (window as any).__TD_NATIVE_GATE_STATE;cleanup();useTerminalStore.getState().flushPendingBufferWrites('controlled-panel');useTerminalStore.getState().removeTerminalSession('controlled-panel');vi.restoreAllMocks();vi.unstubAllGlobals();delete window.termdockPreviewLifecycle;});
it('real TerminalView/store/native queue consume consecutive stream data without animation frames, before sending the actual stream ACK',async()=>{
 render(<I18nProvider><TerminalView sessionId="controlled-panel" mode="shell" isActive suppressKeyboard/></I18nProvider>);
 await waitFor(()=>expect(Socket.sockets).toHaveLength(1));const socket=Socket.sockets[0];
 await act(async()=>{socket.readyState=1;socket.onopen?.();socket.event({type:'connected',mode:'shell',outputProtocol:2,streamEpoch:'stream-a',replayLastSeq:1,replayChunks:['baseline\r\n']});});
 await waitFor(()=>expect(host.writes).toHaveLength(1));
 await act(async()=>{socket.event({type:'data',seq:2,flowSeq:2,data:'\x1b['});socket.event({type:'data',seq:3,flowSeq:3,data:'2J中\r\n'});});
 expect(useTerminalStore.getState().hasPendingBufferWrites('controlled-panel')).toBe(false);
 expect(socket.sent.filter(value=>value.type==='output-ack')).toEqual([]);expect(getAppliedTerminalCursor('controlled-backend')).toBeNull();
 await act(async()=>emit(1));await waitFor(()=>expect(host.writes).toHaveLength(2));expect(socket.sent.filter(value=>value.type==='output-ack')).toEqual([]);
 await act(async()=>emit(2));await waitFor(()=>expect(host.writes).toHaveLength(3));expect(socket.sent.filter(value=>value.type==='output-ack')).toEqual([]);
 await act(async()=>emit(3));await waitFor(()=>expect(socket.sent.filter(value=>value.type==='output-ack')).toEqual([{type:'output-ack',flowSeq:3,since:3,epoch:'stream-a'}]));
 expect(getAppliedTerminalCursor('controlled-backend')).toEqual({seq:3,epoch:'stream-a'});
 expect(host.writes.at(-1).cursor).toEqual({seq:3,epoch:'stream-a'});
 const token=host.token;await act(async()=>socket.event({type:'exit',exitCode:0}));await waitFor(()=>expect(host.writes).toHaveLength(4));expect(host.token).toBe(token);expect(atob(host.writes[3].base64)).toContain('Process exited');
 await act(async()=>emit(4));expect(socket.sent.filter(value=>value.type==='output-ack')).toHaveLength(1);
});
it('allows native input immediately after real replay consumption and rejects pre-ACK or old-token input',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(100000);
 render(<I18nProvider><TerminalView sessionId="controlled-panel" mode="shell" isActive suppressKeyboard/></I18nProvider>);
 await waitFor(()=>expect(Socket.sockets).toHaveLength(1));const socket=Socket.sockets[0];
 await act(async()=>{socket.readyState=1;socket.onopen?.();socket.event({type:'connected',mode:'shell',outputProtocol:2,streamEpoch:'stream-a',replayLastSeq:1,replayChunks:['baseline\r\n']});});
 await waitFor(()=>expect(host.writes).toHaveLength(1));
 const state:any={pageEpoch:'controlled-page',inputObservation:true,inputExpectedView:'terminal::controlled-panel',inputExpectedToken:host.token};(window as any).__TD_NATIVE_GATE_STATE=state;
 const input=(text:string,token=host.token)=>host.listeners.forEach(listener=>listener({token,epoch:'controlled-page',event:{type:'input',base64:btoa(text)}}));
 await act(async()=>input('owned-before-ack'));expect(socket.sent.filter(value=>value.type==='input')).toEqual([]);
 expect(state.inputDiagnostics.some((value:any)=>value.source==='page-input'&&value.reason==='suppressReplay')).toBe(true);
 expect(state.inputDiagnostics.some((value:any)=>value.source==='viewport-send'&&value.result==='false')).toBe(true);
 await act(async()=>emit(1));await waitFor(()=>expect(getAppliedTerminalCursor('controlled-backend')?.seq).toBe(1));
 await act(async()=>input('old-owner','old-token'));expect(socket.sent.filter(value=>value.type==='input')).toEqual([]);
 await act(async()=>input('owned-after-ack'));
 await waitFor(()=>expect(socket.sent.filter(value=>value.type==='input').map(value=>value.data)).toEqual(['owned-after-ack']));
 delete (window as any).__TD_NATIVE_GATE_STATE;
});
it('keeps native dictation paste fragments behind the actual asynchronous tmux copy-mode exit',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(100000);
 useTerminalStore.getState().setTerminalSession('controlled-panel',{sessionId:'controlled-backend',mode:'tmux',cols:80,rows:24});
 render(<I18nProvider><TerminalView sessionId="controlled-panel" mode="tmux" isActive suppressKeyboard/></I18nProvider>);
 await waitFor(()=>expect(Socket.sockets).toHaveLength(1));const socket=Socket.sockets[0];
 await act(async()=>{socket.readyState=1;socket.onopen?.();socket.event({type:'connected',mode:'tmux',outputProtocol:2,streamEpoch:'dictation',replayLastSeq:1,replayChunks:['baseline\r\n']});});
 await waitFor(()=>expect(host.writes).toHaveLength(1));await act(async()=>emit(1));
 await waitFor(()=>expect(getAppliedTerminalCursor('controlled-backend')?.seq).toBe(1));
 const input=(text:string)=>host.listeners.forEach(listener=>listener({token:host.token,epoch:'controlled-page',event:{type:'input',base64:btoa(unescape(encodeURIComponent(text)))}}));
 await act(async()=>input('\x1b[<64;1;1M'));
 await waitFor(()=>expect(socket.sent.some(value=>value.type==='input'&&value.data==='\x1b[<64;1;1M')).toBe(true));
 const before=socket.sent.filter(value=>value.type==='input').map(value=>value.data);
 // Ghostty's text API emits these separately for an asynchronous IME commit.
 await act(async()=>{input('\x1b[200~');input('语音最终修订');input('\x1b[201~');});
 const exit=socket.sent.find(value=>value.type==='tmux'&&value.action==='copy-mode'&&value.enabled===false);
 expect(exit).toBeDefined();
 const whileWaiting=socket.sent.filter(value=>value.type==='input').map(value=>value.data);
 await act(async()=>socket.event({type:'tmux-result',reqId:exit.reqId,success:true}));
 await waitFor(()=>expect(socket.sent.filter(value=>value.type==='input')).toHaveLength(before.length+3));
 expect(whileWaiting).toEqual(before);
 expect(socket.sent.filter(value=>value.type==='input').map(value=>value.data)).toEqual([...before,'\x1b[200~','语音最终修订','\x1b[201~']);
});
it('does not let an old copy-mode request block native input after reconnecting the same backend',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(100000);
 useTerminalStore.getState().setTerminalSession('controlled-panel',{sessionId:'controlled-backend',mode:'tmux',cols:80,rows:24});
 render(<I18nProvider><TerminalView sessionId="controlled-panel" mode="tmux" isActive suppressKeyboard/></I18nProvider>);
 await waitFor(()=>expect(Socket.sockets).toHaveLength(1));const socket=Socket.sockets[0];
 await act(async()=>{socket.readyState=1;socket.onopen?.();socket.event({type:'connected',mode:'tmux',outputProtocol:2,streamEpoch:'before-reconnect',replayLastSeq:1,replayChunks:['baseline\r\n']});});
 await waitFor(()=>expect(host.writes).toHaveLength(1));await act(async()=>emit(1));
 await waitFor(()=>expect(getAppliedTerminalCursor('controlled-backend')?.seq).toBe(1));
 const input=(text:string)=>host.listeners.forEach(listener=>listener({token:host.token,epoch:'controlled-page',event:{type:'input',base64:btoa(text)}}));
 await act(async()=>input('\x1b[<64;1;1M'));
 await act(async()=>input('old-waiting-input'));
 const exit=socket.sent.find(value=>value.type==='tmux'&&value.action==='copy-mode'&&value.enabled===false);expect(exit).toBeDefined();
 await act(async()=>socket.event({type:'connected',mode:'tmux',outputProtocol:2,streamEpoch:'after-reconnect',replayLastSeq:2,replayChunks:['fresh baseline\r\n']}));
 await waitFor(()=>expect(host.writes.length).toBeGreaterThan(1));
 await act(async()=>emit(host.writes.at(-1).sequence));
 await waitFor(()=>expect(getAppliedTerminalCursor('controlled-backend')).toEqual({seq:2,epoch:'after-reconnect'}));
 await act(async()=>input('fresh-input'));
 const beforeOldReply=socket.sent.filter(value=>value.type==='input').map(value=>value.data);
 await act(async()=>socket.event({type:'tmux-result',reqId:exit.reqId,success:true}));
 expect(beforeOldReply).toContain('fresh-input');
 expect(socket.sent.filter(value=>value.type==='input').map(value=>value.data)).not.toContain('old-waiting-input');
});
it('keeps startup content unready without presentation frames despite native consumption, then releases after size ACK and two visible frames',async()=>{
 const frames=new Map<number,FrameRequestCallback>();let serial=0;
 vi.stubGlobal('requestAnimationFrame',vi.fn((callback:FrameRequestCallback)=>{frames.set(++serial,callback);return serial;}));
 vi.stubGlobal('cancelAnimationFrame',vi.fn((id:number)=>frames.delete(id)));
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});let hidden=true;
 (window as any).__TD_NATIVE_GATE_STATE={pageEpoch:'controlled-page'};
 const content=vi.fn();
 const view=render(<I18nProvider><TerminalView sessionId="controlled-panel" mode="shell" isActive suppressKeyboard onContentReadyChange={content}/></I18nProvider>);
 await waitFor(()=>expect(Socket.sockets).toHaveLength(1));const socket=Socket.sockets[0];
 await act(async()=>{socket.readyState=1;socket.onopen?.();socket.event({type:'connected',mode:'shell',outputProtocol:2,streamEpoch:'stream-a',replayLastSeq:1,replayChunks:['baseline\r\n']});});
 await waitFor(()=>expect(host.writes).toHaveLength(1));
 await act(async()=>emit(1));
 await waitFor(()=>expect(getAppliedTerminalCursor('controlled-backend')?.seq).toBe(1));
 const state=()=>JSON.parse(view.container.querySelector('[data-owned-terminal-startup]')!.getAttribute('data-owned-terminal-startup')!);
 expect(state().streamReady).toBe(true);expect(state().viewportReady).toBe(true);expect(state().contentReady).toBe(false);
 expect(content.mock.calls.some(([,ready])=>ready===true)).toBe(false);
 await act(async()=>{for(const resize of socket.sent.filter(value=>value.type==='resize'))socket.event({type:'resize-ack',ok:true,cols:resize.cols,rows:resize.rows,seq:resize.seq});});
 expect(state().sizeReady).toBe(true);expect(state().contentReady).toBe(false);
 hidden=false;act(()=>document.dispatchEvent(new Event('visibilitychange')));
 const frame=async()=>{const batch=[...frames.values()];frames.clear();await act(async()=>{for(const callback of batch)callback(performance.now());});};
 await frame();expect(state().contentReady).toBe(false);
 await frame();expect(state().contentReady).toBe(true);
 expect(content.mock.lastCall).toEqual(['controlled-panel',true]);
 delete (document as any).hidden;
});

it('shows a typed input refusal without replacing the backend session or hiding it as reconnecting',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});vi.spyOn(Date,'now').mockReturnValue(100000);
 const view=render(<I18nProvider><TerminalView sessionId="controlled-panel" mode="shell" isActive suppressKeyboard/></I18nProvider>);
 await waitFor(()=>expect(Socket.sockets).toHaveLength(1));const socket=Socket.sockets[0];
 await act(async()=>{socket.readyState=1;socket.onopen?.();socket.event({type:'connected',mode:'shell',outputProtocol:2,streamEpoch:'stream-input',replayLastSeq:1,replayChunks:['baseline\r\n']});});
 await waitFor(()=>expect(host.writes).toHaveLength(1));await act(async()=>emit(1));
 await waitFor(()=>expect(getAppliedTerminalCursor('controlled-backend')?.seq).toBe(1));
 const send=socket.send.bind(socket);socket.send=(raw:string)=>{if(JSON.parse(raw).type==='input')throw new Error('Input could not be delivered. Retry after reconnecting.');send(raw);};
 await act(async()=>{host.listeners.forEach(listener=>listener({token:host.token,epoch:'controlled-page',event:{type:'input',base64:btoa('fixed-input')}}));});
 await waitFor(()=>expect(view.container.textContent).toContain('Input could not be delivered. Retry after reconnecting.'));
 expect(socket.sent.filter(value=>value.type==='input')).toHaveLength(0);
 expect(useTerminalStore.getState().sessions.get('controlled-panel')?.terminalSessionId).toBe('controlled-backend');
});
