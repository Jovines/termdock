import { sendTmuxAction } from './api';
import { currentSecureClient } from '../federation/browserIntegration';
import React from 'react';
import type { TerminalController, TerminalViewportProps } from '../components/terminal/TerminalViewport';
import { getTermdockDesktopBridge, subscribeNativeFileDrops, type NativeTerminalEvent } from '../desktop/nativeBridge';
import { getIdentity } from '../federation/deviceIdentity';
import { selectedTarget } from '../federation/clientScope';
import { routeCollaborationInput } from '../collaboration/inputTarget';
import { NativeOutputQueue, nativeBase64 } from './nativeOutput';
import { terminalSequencePayload } from './sequencePayload';
import { readTerminalClipboardFiles, readTerminalClipboardImage, uploadTerminalClipboardFiles, uploadTerminalClipboardImage, TerminalClipboardVideoError } from './clipboardImage';
import { escapeShellPath } from '../desktop/shellPath';
import { createResizeSyncState, acknowledgeResize, requestResize, forceResize, observeServerSize } from './resizeSync';
import { sanitizeTerminalInput } from './inputNormalization';
import { nativeMenuShortcut, nativeTerminalShortcut, nativeSessionFontShortcut } from './nativeShortcuts';
import { activateNativePathHit, nativePathHoverRects } from './nativePaths';
import { readNativeSnapshot, deleteNativeSnapshot, nativeSnapshotRevision, tagNativeSnapshot, writeNativeSnapshot, type NativeSnapshot } from './nativeSnapshotCache';
import {observeOwnedNativeInput} from './nativeInputObservation';
import { registerNativeLease, invalidateNativeHiddenReceipt, markNativeRendererReady, hideNativeLease, retireNativeLease } from './nativeLifetime';
import { setSessionFontSize } from './sessionFontSize';
import { useNativeViewportFeedback } from './nativeViewportFeedback';
import type { TerminalTheme } from './theme';
import { MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE, type TerminalSettings } from './settings';
type Cursor = {seq:number;epoch:string};
type Surface = { token:string;epoch:string;sequence:number;baseline:Cursor|null;reused:boolean;dimensions?:{cols:number;rows:number};snapshot?:Omit<NativeSnapshot,'savedAt'>|null };
class NativeOwnerChanged extends Error {}
type Lifecycle = {blockInput?:boolean;hidden:boolean;focused:boolean;moving?:boolean;overlayReady?:boolean;viewport:{width:number;height:number;scale:number};overlays:Array<{x:number;y:number;width:number;height:number}>;generation?:number};
declare global { interface Window { termdockPreviewLifecycle?: {snapshot():Lifecycle;subscribe(callback:(snapshot:Lifecycle)=>void):()=>void; nativePanels(active:boolean):void; prepareOverlay?():Promise<unknown> } } }
function rgb(color:string):number[] {
  const match=/^#([\da-f]{6})$/i.exec(color); if(!match) throw new Error('Native palette requires the existing opaque terminal tokens');
  return [0,2,4].map(offset=>Number.parseInt(match[1].slice(offset,offset+2),16));
}
function palette(theme:TerminalTheme) {
  return {ansi:['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'].map(key=>rgb(theme[key as keyof TerminalTheme]!)),foreground:rgb(theme.foreground),background:rgb(theme.background),cursor:rgb(theme.cursor),selection:rgb(theme.selectionBackground)};
}
function nativeFont(settings:TerminalSettings) {
  const {fontFamily:family,fontLigatures:ligatures}=settings;
  // CoreText uses the actual shipped family, not CSS @font-face aliases.
  const resolved=!family||family.includes('var(')?getComputedStyle(document.documentElement).getPropertyValue('--font-mono'):family;
  const first=resolved.split(',')[0].trim().replace(/^["']|["']$/g,'');
  const weight=(value:TerminalSettings['fontWeight'])=>value==='normal'?400:value==='bold'?700:value;
  return {family:first==='Termdock Mono'?'JetBrainsMonoNL NFM':first,features:ligatures?['+liga','+calt']:['-liga','-calt'],letter_spacing:settings.letterSpacing,extra_height_percent:Math.round((settings.lineHeight-1)*100),weight:weight(settings.fontWeight),weight_bold:weight(settings.fontWeightBold),contrast:Math.round(settings.minimumContrastRatio*100),bold_is_bright:settings.drawBoldTextInBrightColors};
}
// Sample geometry and viewport together. Hidden/offscreen staging panes are
// valid React state, but must never become an out-of-bounds AppKit rectangle.
function measuredNativeBounds(element:HTMLElement|null,allowed:boolean){
  if(!element||!allowed||document.hidden)return null;
  const viewportWidth=innerWidth,viewportHeight=innerHeight,bounds=element.getBoundingClientRect();
  const {x,y,width,height}=bounds;
  if(![x,y,width,height,viewportWidth,viewportHeight].every(Number.isFinite)||width<=0||height<=0||viewportWidth<=0||viewportHeight<=0||x<0||y<0||x+width>viewportWidth+0.5||y+height>viewportHeight+0.5)return null;
  return{x,y,width,height,viewportWidth,viewportHeight};
}
/** The native branch owns no xterm instance. Page callbacks remain the only
 * business transport and retain the existing same-session PTY. */
export const NativeTerminalViewport=React.forwardRef<TerminalController,TerminalViewportProps>((props,ref)=>{
  const latest=React.useRef(props);latest.current=props;
  const container=React.useRef<HTMLDivElement>(null);
  const surface=React.useRef<Surface|null>(null), queue=React.useRef<NativeOutputQueue|null>(null);
  const backend=React.useRef<string|null>(null), engineReady=React.useRef(false), disposed=React.useRef(false);
  const publishRendererReady=React.useCallback((ready:boolean)=>{if(surface.current)markNativeRendererReady(latest.current.sessionKey,surface.current.token,ready);},[]);
  const restoring=React.useRef(false), prepareGeneration=React.useRef(0);
  const localResetting=React.useRef(false),localClearWork=React.useRef<Promise<void>|null>(null);
  const inputDecoder=React.useRef({token:'',decoder:new TextDecoder()});
  const retiring=React.useRef(false),lastHostToken=React.useRef<string|null>(null);
  const initialReplay=React.useRef(true), acceptOutput=React.useRef(false);
  const position=React.useRef<{x:number;y:number;rows:number}|null>(null);
  const copying=React.useRef<((ok:boolean)=>void)|null>(null);
  const copyIsCurrent=React.useRef<(()=>boolean)|null>(null);
  const searchGeneration=React.useRef(0);
  const dimensions=React.useRef({cols:80,rows:24});
  const sessionReady=React.useRef(false), resize=React.useRef(createResizeSyncState());
  const syncGeneration=React.useRef<number|null>(null), appliedGeneration=React.useRef(-1);
  const feedbackOwner=JSON.stringify([props.sessionKey,props.backendSessionId??null,selectedTarget()?.targetPeerId??null]);
  const feedback=useNativeViewportFeedback(feedbackOwner);
  const {message:feedbackMessage,beginClipboardOperation,clearClipboardError,showClipboardError,showPersistentError,clear:clearFeedback}=feedback;
  const [error,setError]=React.useState<string|null>(null), [search,setSearch]=React.useState<string|null>(null), [searchResult,setSearchResult]=React.useState('');
  const bridge=getTermdockDesktopBridge()!.nativeTerminal!;
  const commandChain=React.useRef(Promise.resolve());
  const wheelState=React.useRef({delta:0,remainder:0,x:0,y:0,width:1,height:1,cellHeight:16,frame:0});
  const lastLayout=React.useRef('');
  const layoutVersion=React.useRef(0);
  const hoverSlice=React.useRef<{token:string;data:Record<string,unknown>}|null>(null);
  const pointerFocus=React.useRef<Surface|null>(null);
  const explicitBlur=React.useRef(false);
  const actualFocusReceipt=React.useRef({token:'',revision:0,focused:false});
  const fatal=React.useCallback((reason:unknown)=>{
    if(disposed.current||reason instanceof NativeOwnerChanged||retiring.current)return;
    if(restoring.current)return;
    retiring.current=true;const generation=++prepareGeneration.current;
    setError(reason instanceof Error?reason.message:String(reason));engineReady.current=false;publishRendererReady(false);acceptOutput.current=false;queue.current?.stop();latest.current.onFlowControl?.(true);
    const view=latest.current.sessionKey;
    // Browser fallback starts only after actual AppKit detach, so it never
    // runs a second parser/renderer beside the failed native receiver.
    void retireNativeLease(view,surface.current?.token??lastHostToken.current??undefined).then(retirement=>{
      if(disposed.current||generation!==prepareGeneration.current||retirement!=='detached')return;
      surface.current=null;
      latest.current.onNativeRendererFailed?.();
    }).catch(error=>{if(!disposed.current)setError(String(error));}).finally(()=>{retiring.current=false;});
  },[bridge,publishRendererReady]);
  const request=React.useCallback(async (action:string,args:Record<string,unknown>={},token=surface.current?.token,layoutStamp?:number):Promise<unknown>=>{
    if(!token || disposed.current) throw new Error('Native surface is not ready');
    const stamp=surface.current,generation=prepareGeneration.current;
    const current=()=>!disposed.current&&surface.current===stamp&&stamp?.token===token&&prepareGeneration.current===generation;
    // Retry only explicit unconsumed Backpressure. Pending is handled by the
    // output queue and is never resubmitted while waiting for consumption ACK.
    const started=performance.now();
    while(true){
      if(!current())throw new NativeOwnerChanged('Native surface owner changed');
      if(layoutStamp!==undefined&&layoutStamp!==layoutVersion.current)return {superseded:true};
      if(action==='focus'&&args.focused===true){
        const active=document.activeElement;
        const editable=active instanceof HTMLElement&&(active.isContentEditable||active.matches('input,textarea,select,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]'));
        // Recheck at dispatch and every Backpressure retry, not at enqueue.
        // Explicit focus is allowed even when the autofocus preference is off.
        if(latest.current.inputActive===false||latest.current.isLayoutVisible===false||document.hidden||editable)return;
      }
      try{if(((action==='visible'&&args.visible===true)||(action==='rect'&&Array.isArray(args.holes)))&&stamp)invalidateNativeHiddenReceipt(latest.current.sessionKey,stamp.token);const receipt=await bridge.request({action,token,...args});if(!current())throw new NativeOwnerChanged('Native reply belongs to an old owner');return receipt;}
      catch(error){if(!current())throw new NativeOwnerChanged('Native rejection belongs to an old owner');if(!String(error).includes('pending batch or callbacks must be drained')||performance.now()-started>10000)throw error;await new Promise(resolve=>setTimeout(resolve,16));}
    }
  },[bridge]);
  const serializeCommand=React.useCallback((action:string,args:Record<string,unknown>={},layoutStamp?:number)=>{
    const stamp=surface.current,generation=prepareGeneration.current;
    const run=commandChain.current.then(()=>{if(surface.current!==stamp||generation!==prepareGeneration.current)throw new NativeOwnerChanged('Queued native control belongs to an old owner');return request(action,args,stamp?.token,layoutStamp);});
    commandChain.current=run.then(()=>undefined,()=>undefined);return run;
  },[request]);
  const closeSearch=React.useCallback(async()=>{
    const stamp=surface.current,generation=++searchGeneration.current;
    try {
      await serializeCommand('search',{needle:'',direction:2});
      await serializeCommand('layout');
      if(!disposed.current&&surface.current===stamp&&generation===searchGeneration.current){setSearch(null);setSearchResult('');}
    } catch(error){fatal(error);}
  },[fatal,serializeCommand]);
  const searchTerminal=React.useCallback((needle:string,direction:number)=>{
    const stamp=surface.current,generation=++searchGeneration.current;
    void serializeCommand('search',{needle,direction}).then(value=>{
      if(!disposed.current&&surface.current===stamp&&generation===searchGeneration.current)setSearchResult(String((value as {total:number}).total));
    }).catch(fatal);
  },[fatal,serializeCommand]);
  const pushResize=React.useCallback((force=false)=>{
    if(!sessionReady.current)return;
    const plan=force?forceResize(resize.current,dimensions.current):requestResize(resize.current,dimensions.current);
    resize.current=plan.state;
    if(plan.request){latest.current.onSizeSynchronizedChange?.(false);latest.current.onResize(plan.request.cols,plan.request.rows,plan.request.seq);}
  },[]);
  const layoutFrame=React.useRef(0);
  const layoutViewport=React.useRef<{width:number;height:number}|null>(null);
  const resizingViewport=React.useRef(false);
  const measure=React.useCallback(()=>{
    const element=container.current;if(!element||!surface.current||localResetting.current)return;

    const life=window.termdockPreviewLifecycle?.snapshot();
    let rect=element.getBoundingClientRect();
    const previousViewport=layoutViewport.current;
    layoutViewport.current={width:innerWidth,height:innerHeight};
    const viewportChanged=previousViewport&&(previousViewport.width!==innerWidth||previousViewport.height!==innerHeight);
    if(viewportChanged)resizingViewport.current=true;
    const overflowing=rect.right>innerWidth+0.5||rect.bottom>innerHeight+0.5;
    if(!overflowing)resizingViewport.current=false;
    // Flex layout can lag WK by multiple callbacks during live resize. Clip an
    // existing pane to the current viewport instead of hiding it after one RAF.
    // Initial invalid/offscreen panes still follow the normal hidden path.
    if(resizingViewport.current&&latest.current.isLayoutVisible!==false&&!document.hidden&&rect.width>0&&rect.height>0&&rect.left>=0&&rect.top>=0&&rect.left<innerWidth&&rect.top<innerHeight){
      const right=Math.min(rect.right,innerWidth),bottom=Math.min(rect.bottom,innerHeight);
      rect={...rect,x:rect.left,y:rect.top,left:rect.left,top:rect.top,right,bottom,width:right-rect.left,height:bottom-rect.top} as DOMRect;
      if(!layoutFrame.current)layoutFrame.current=requestAnimationFrame(()=>{layoutFrame.current=0;measure();});
    }
    const overlaps=life?.overlays.filter(r=>r.x<rect.right&&r.x+r.width>rect.left&&r.y<rect.bottom&&r.y+r.height>rect.top)??[];
    const visible=latest.current.isLayoutVisible!==false&&!document.hidden&&rect.width>0&&rect.height>0&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth+0.5&&rect.bottom<=innerHeight+0.5;
    // During the first safe overlay ACK, keep an already-visible surface in
    // place; prepareOverlay atomically adds the cutout before the CSS gate lifts.
    const holdForOverlay=visible&&(overlaps.length>0||life?.blockInput===true)&&life?.overlayReady===false;
    if(pointerFocus.current&&pointerFocus.current!==surface.current)pointerFocus.current=null;
    const pointerIntent=pointerFocus.current===surface.current&&visible&&latest.current.inputActive!==false;
    if(pointerIntent){const old=document.activeElement;if(old instanceof HTMLElement&&(old.isContentEditable||old.matches('input,textarea,select,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]')))old.blur();}
    const active=document.activeElement;
    const textFocus=active instanceof HTMLElement&&(active.isContentEditable||active.matches('input,textarea,select,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]'));
    const signature=JSON.stringify([surface.current.token,visible,holdForOverlay,rect.x,rect.y,rect.width,rect.height,innerWidth,innerHeight,window.devicePixelRatio,latest.current.autoFocus,latest.current.inputActive,textFocus,pointerIntent,overlaps,life?.generation,life?.focused,life?.blockInput]);
    if(signature===lastLayout.current)return;lastLayout.current=signature;
    const version=++layoutVersion.current;
    void (async()=>{
      if(holdForOverlay)return;
      if(!visible){await serializeCommand('visible',{visible:false});return;}
      // The host applies frame, overlay clip and visibility in one AppKit
      // transaction. A moving overlay must not cause a hide/show per frame.
      const receipt=await serializeCommand('rect',{x:rect.x,y:rect.y,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight,holes:overlaps.map(r=>[r.x,r.y,r.width,r.height]),blockInput:life?.blockInput===true,generation:String(life?.generation??0)},version);
      if(version!==layoutVersion.current)return;
      if((receipt as {staleGeometry?:boolean;layoutPending?:boolean}|undefined)?.staleGeometry||(receipt as {layoutPending?:boolean}|undefined)?.layoutPending){
        lastLayout.current='';
        if(!layoutFrame.current)layoutFrame.current=requestAnimationFrame(()=>{layoutFrame.current=0;measure();});
        return;
      }
      if(version===layoutVersion.current){const focused=await serializeCommand('focus',{focused:(pointerIntent||(!explicitBlur.current&&latest.current.autoFocus!==false))&&!textFocus&&!life?.blockInput});if(pointerIntent&&focused!==undefined&&pointerFocus.current===surface.current)pointerFocus.current=null;}
    })().catch(fatal);
  },[fatal,serializeCommand]);
  const send=React.useCallback(async(data:string,options?:Parameters<TerminalViewportProps['onInput']>[1])=>{
    const observationView=latest.current.sessionKey,observationToken=surface.current?.token;
    observeOwnedNativeInput(observationView,observationToken,'viewport-send',{inputActive:latest.current.inputActive!==false,engineReady:engineReady.current,localResetting:localResetting.current,backendMatches:!latest.current.backendSessionId||latest.current.backendSessionId===backend.current});
    if((latest.current.inputActive===false&&!options?.targeted)||!engineReady.current||localResetting.current||(latest.current.backendSessionId&&latest.current.backendSessionId!==backend.current)) return false;
    pushResize();if(routeCollaborationInput(data))return true;
    const result=await latest.current.onInput(data,options);observeOwnedNativeInput(observationView,observationToken,'viewport-send',{result:result===true?'true':result===false?'false':result===undefined?'undefined':'other'});return result!==false;
  },[pushResize]);
  const clipboardUpload=React.useRef<{controller:AbortController;target:ReturnType<typeof selectedTarget>;client:ReturnType<typeof currentSecureClient>}|null>(null);
  const startClipboardOperation=React.useCallback(()=>{
    clipboardUpload.current?.controller.abort();
    const controller=new AbortController(),operation=beginClipboardOperation();
    clipboardUpload.current={controller,target:selectedTarget(),client:currentSecureClient()};
    return {...operation,signal:controller.signal,isCurrent:()=>!controller.signal.aborted&&operation.isCurrent()};
  },[beginClipboardOperation]);
  React.useEffect(()=>{
    const changed=(event:Event)=>{const work=clipboardUpload.current;if(work&&(event.type==='auth:unauthorized'||work.target!==selectedTarget()||work.client!==currentSecureClient()||work.client?.closed)){work.controller.abort();clearClipboardError();}};
    window.addEventListener('termdock:secure-state',changed);window.addEventListener('auth:unauthorized',changed);
    return()=>{clipboardUpload.current?.controller.abort();window.removeEventListener('termdock:secure-state',changed);window.removeEventListener('auth:unauthorized',changed);};
  },[clearClipboardError,props.sessionKey,props.backendSessionId]);
  const paste=React.useCallback(async()=>{
    const operation=startClipboardOperation();
    const stamp=surface.current,session=backend.current,target=selectedTarget(),client=currentSecureClient();
    const current=()=>operation.isCurrent()&&stamp===surface.current&&session===backend.current&&target===selectedTarget()&&client===currentSecureClient()&&!client?.closed&&!disposed.current;
    try{
      let text='';let fileError:unknown;
      let files:Awaited<ReturnType<typeof readTerminalClipboardFiles>>|undefined;
      try{files=await readTerminalClipboardFiles();}catch(error){if(error instanceof TerminalClipboardVideoError)throw error;fileError=error;}
      if(!current())return false;
      // A recognized file upload failure is final: never paste its title, cover
      // image or unrelated clipboard text instead.
      if(files&&(files.paths.length||files.files.length)){
        const uploaded=files.files.length?await uploadTerminalClipboardFiles(files.files,operation.signal):[];
        if(!current())return false;
        text=[...files.paths,...uploaded].map(escapeShellPath).join(' ')+' ';
      }
      if(!text){const image=await readTerminalClipboardImage(navigator.clipboard);if(!current())return false;if(image){text=escapeShellPath(await uploadTerminalClipboardImage(image,operation.signal))+' ';}}
      if(!current())return false;
      if(!text){try{text=await serializeCommand('clipboardText') as string;}catch(error){throw fileError??error;}}
      if(!current())return false;
      if(!text){if(fileError)throw fileError;operation.succeed();return false;}
      const accepted=await send(terminalSequencePayload(sanitizeTerminalInput(text),{paste:true,submitAfterPaste:false}),{skipModifierTransform:true});
      if(!current())return false;
      if(!accepted){operation.fail('当前终端未接受粘贴内容。');return false;}
      operation.succeed();return true;
    }catch(error){if(current())operation.fail(error instanceof Error?error.message:String(error));return false;}
  },[startClipboardOperation,send,serializeCommand]);
  const copyTmuxSelection=React.useCallback(async(copyId?:string)=>{
    const operation=startClipboardOperation();
    const stamp=surface.current,session=backend.current,target=selectedTarget(),client=currentSecureClient();
    const current=()=>operation.isCurrent()&&!disposed.current&&surface.current===stamp&&backend.current===session&&selectedTarget()===target&&currentSecureClient()===client&&!client?.closed&&latest.current.inputActive!==false;
    if(!stamp||!session||!current())return false;
    try{
      const result=await sendTmuxAction(session,{action:'copy-selection'});
      if(!current())return false;
      const selection=result.selection;
      if(!result.success||!selection||!['copied','empty'].includes(selection.status)||typeof selection.text!=='string'||typeof selection.paneId!=='string'||!/^%[0-9]+$/.test(selection.paneId)||new TextEncoder().encode(selection.text).length!==selection.bytes||selection.bytes>262144)throw new Error('This service did not confirm a valid tmux selection; update the service and retry.');
      if(selection.status==='empty'){operation.succeed();return false;}
      if(!selection.bytes)throw new Error('Tmux copy returned an empty selection.');
      if(copyId){
        const result=await serializeCommand('copyText',{copyId,text:selection.text}) as {copied?:boolean}|null;
        if(!result?.copied)throw new Error('Native clipboard copy was not confirmed.');
      }else await navigator.clipboard.writeText(selection.text);
      if(!current())return false;
      operation.succeed();return true;
    }catch(error){if(current())operation.fail(error instanceof Error?error.message:String(error));return false;}
  },[beginClipboardOperation,serializeCommand]);
  const clearLocal=React.useCallback(()=>{
    const output=queue.current;if(!output||localClearWork.current)return;
    const feedbackOwnerAtStart=JSON.stringify([latest.current.sessionKey,latest.current.backendSessionId??null,selectedTarget()?.targetPeerId??null]);
    const work=output.localReset(async()=>{
      const stamp=surface.current,session=backend.current,generation=prepareGeneration.current,view=latest.current.sessionKey;
      if(!stamp||!session)throw new NativeOwnerChanged('Local clear has no current owner');
      const baseline=output.consumedCursor;let changed=false;localResetting.current=true;layoutVersion.current++;
      const current=()=>!disposed.current&&generation===prepareGeneration.current&&queue.current===output;
      try {
        if(!await deleteNativeSnapshot(session))throw new Error('Cannot clear the saved terminal state.');
        if(!current()||surface.current!==stamp)throw new NativeOwnerChanged('Local clear owner changed');
        engineReady.current=false;publishRendererReady(false);
        const fresh=await serializeCommand('localReset') as Surface;
        if(!current()||surface.current!==stamp){void bridge.request({action:'retireView',view,token:fresh.token}).catch(()=>{});throw new NativeOwnerChanged('Local clear was superseded');}
        changed=true;surface.current=fresh;lastHostToken.current=fresh.token;registerNativeLease(latest.current.sessionKey,fresh.token,bridge,fresh.epoch);
        if(fresh.token===stamp.token||fresh.sequence!==0||JSON.stringify(fresh.baseline)!==JSON.stringify(baseline))throw new Error('Local clear did not confirm the consumed baseline');
        const completed=async()=>{const receipt=await serializeCommand('layout') as {complete:boolean;token:string;epoch:string;dimensions:{cols:number;rows:number}};if(!current()||surface.current!==fresh)throw new NativeOwnerChanged('Local clear layout owner changed');if(!receipt.complete||receipt.token!==fresh.token||receipt.epoch!==fresh.epoch||!receipt.dimensions)throw new Error('Local clear layout was not completed');dimensions.current=receipt.dimensions;};
        await completed();
        const bounds=measuredNativeBounds(container.current,latest.current.isLayoutVisible!==false);
        if(bounds){await serializeCommand('rect',bounds);await completed();}
        else await serializeCommand('visible',{visible:false});
        await serializeCommand('policy',{tmux:!!latest.current.onTmuxScroll});
        if(!current()||surface.current!==fresh)throw new NativeOwnerChanged('Local clear owner changed after layout');
        if(baseline){
          const cacheRevision=nativeSnapshotRevision(session);
          const value=await serializeCommand('capture',{sequence:0,cursor:baseline}) as Omit<NativeSnapshot,'savedAt'>|{status:string};
          if('status' in value)showPersistentError('Terminal cleared; the reload checkpoint could not be saved.',feedbackOwnerAtStart);
          else {const snapshot=tagNativeSnapshot({...value,savedAt:Date.now()},cacheRevision);if(!snapshot||!await writeNativeSnapshot(snapshot))showPersistentError('Terminal cleared; the reload checkpoint could not be saved.',feedbackOwnerAtStart);}
        }
        engineReady.current=true;publishRendererReady(true);position.current=null;lastLayout.current='';
        return {sequence:0,cursor:baseline};
      }catch(reason){if(changed)fatal(reason);throw reason;}
      finally {if(current()){localResetting.current=false;if(engineReady.current)measure();}}
    });localClearWork.current=work;
    void work.catch(reason=>{if(!(reason instanceof NativeOwnerChanged)&&!disposed.current)showPersistentError(reason instanceof Error?reason.message:String(reason),feedbackOwnerAtStart);}).finally(()=>{if(localClearWork.current===work)localClearWork.current=null;});
  },[bridge,fatal,measure,serializeCommand,publishRendererReady,showPersistentError]);
  const prepare=React.useCallback(async(session:string,restoreCache=true):Promise<Cursor|null>=>{
    // A backend transition must observe a local reset's returned new token,
    // rather than enqueueing destroy with the superseded capability.
    await localClearWork.current?.catch(()=>{});
    const generation=++prepareGeneration.current;
    const ensureOwner=()=>{if(disposed.current||generation!==prepareGeneration.current)throw new NativeOwnerChanged('Native initialization was superseded');};
    const layoutComplete=async()=>{
      const stamp=surface.current;
      const receipt=await serializeCommand('layout') as {complete?:boolean;token?:string;epoch?:string;dimensions?:{cols:number;rows:number}};
      ensureOwner();
      if(!stamp||receipt?.complete!==true||receipt.token!==stamp.token||receipt.epoch!==stamp.epoch||!receipt.dimensions)throw new Error('Native layout completion was not confirmed');
      dimensions.current=receipt.dimensions;engineReady.current=true;publishRendererReady(true);
    };
    setError(null);acceptOutput.current=false;engineReady.current=false;publishRendererReady(false);queue.current?.stop();
    if(surface.current&&backend.current!==session)await request('destroy');
    surface.current=null;
    ensureOwner();backend.current=session;position.current=null;lastLayout.current='';inputDecoder.current={token:'',decoder:new TextDecoder()};
    const identity=await getIdentity();
    const settings=latest.current.terminalSettings;
    ensureOwner();
    const createArgs={action:'create',view:latest.current.sessionKey,session,device:identity.peerId,options:{columns:dimensions.current.cols,rows:dimensions.current.rows,history:latest.current.onTmuxScroll?0:1000,font:nativeFont(settings),palette:palette(latest.current.theme),cursor_visible:latest.current.cursorVisible!==false,cursor_blink:settings.rendererMode!=='webgl'},fontSize:settings.fontSize,viewportWidth:innerWidth,viewportHeight:innerHeight};
    const create=async()=>{const started=performance.now();while(true){ensureOwner();try{return await bridge.request({...createArgs,viewportWidth:innerWidth,viewportHeight:innerHeight}) as Surface;}catch(error){if(!String(error).includes('pending batch or callbacks must be drained')||performance.now()-started>10000)throw error;await new Promise(resolve=>setTimeout(resolve,16));}}};
    const synchronizeCreatedPreferences=async()=>{
      // Preference effects can run while create is awaiting its capability and
      // skip the absent surface. Reconcile before publishing ready or laying out.
      const current=latest.current.terminalSettings,updates:Array<Promise<unknown>>=[];
      if(current.fontSize!==createArgs.fontSize)updates.push(serializeCommand('fontSize',{size:current.fontSize}));
      const font=nativeFont(current);
      if(JSON.stringify(font)!==JSON.stringify(createArgs.options.font))updates.push(serializeCommand('font',{font}));
      const currentPalette=palette(latest.current.theme);
      if(JSON.stringify(currentPalette)!==JSON.stringify(createArgs.options.palette))updates.push(serializeCommand('palette',{palette:currentPalette}));
      const visible=latest.current.cursorVisible!==false,blink=current.rendererMode!=='webgl';
      if(visible!==createArgs.options.cursor_visible||blink!==createArgs.options.cursor_blink)updates.push(serializeCommand('cursor',{visible,blink}));
      const history=latest.current.onTmuxScroll?0:1000;
      if(history!==createArgs.options.history)updates.push(serializeCommand('history',{history}));
      // Enqueue together so a later preference effect stays later.
      await Promise.all(updates);ensureOwner();
    };
    let result=await create();
    if(disposed.current||generation!==prepareGeneration.current){void bridge.request({action:'destroy',token:result.token});throw new NativeOwnerChanged('Native viewport closed during initialization');}
    surface.current=result;
    lastHostToken.current=result.token;registerNativeLease(latest.current.sessionKey,result.token,bridge,result.epoch);
    if(result.dimensions)dimensions.current=result.dimensions;
    queue.current=new NativeOutputQueue(result.sequence,batch=>request('write',{sequence:batch.sequence,base64:nativeBase64(batch.bytes),replay:batch.replay,replayEnd:batch.replayEnd,cursor:batch.cursor??null}),id=>latest.current.onWriteProgress?.(id),paused=>latest.current.onFlowControl?.(paused),fatal,result.baseline);
    // Query the completed IO barrier directly. No-op rects do not emit Ready;
    // unrelated focus/initial Ready events cannot complete this handshake.
    await synchronizeCreatedPreferences();
    await layoutComplete();
    const applyBounds=async()=>{
      // Restore and layout can await multiple AppKit frames. Never reuse the
      // pre-restore rectangle with the post-resize viewport dimensions.
      const bounds=measuredNativeBounds(container.current,latest.current.isLayoutVisible!==false);
      if(bounds){await serializeCommand('rect',bounds);await layoutComplete();}
      else await serializeCommand('visible',{visible:false});
    };
    await applyBounds();
    if(!result.reused&&restoreCache){
      const cached=result.snapshot?{...result.snapshot,savedAt:Date.now()}:await Promise.race([readNativeSnapshot(session),new Promise<null>(resolve=>setTimeout(()=>resolve(null),75))]);
      if(cached){
        const {savedAt: _savedAt,...snapshot}=cached;
        restoring.current=true;
        // A damaged cache can fail asynchronously at the engine metadata
        // barrier. Retire only that private receiver and recover the same PTY.
        try {
          const restored=await serializeCommand('restore',{snapshot}) as Surface|null;
          if(restored){
          surface.current=restored;
          lastHostToken.current=restored.token;registerNativeLease(latest.current.sessionKey,restored.token,bridge,restored.epoch);
          await layoutComplete();
          result.token=restored.token;result.sequence=restored.sequence;result.baseline=restored.baseline;
          queue.current=new NativeOutputQueue(restored.sequence,batch=>request('write',{sequence:batch.sequence,base64:nativeBase64(batch.bytes),replay:batch.replay,replayEnd:batch.replayEnd,cursor:batch.cursor??null}),id=>latest.current.onWriteProgress?.(id),paused=>latest.current.onFlowControl?.(paused),fatal,restored.baseline);
          }
        } catch(error) {
          if(error instanceof NativeOwnerChanged)throw error;
          ensureOwner();queue.current?.stop();
          if(surface.current)await serializeCommand('destroy');
          publishRendererReady(false);surface.current=null;engineReady.current=false;
          result=await create();ensureOwner();surface.current=result;lastHostToken.current=result.token;registerNativeLease(latest.current.sessionKey,result.token,bridge,result.epoch);
          await synchronizeCreatedPreferences();await layoutComplete();await applyBounds();
          queue.current=new NativeOutputQueue(0,batch=>request('write',{sequence:batch.sequence,base64:nativeBase64(batch.bytes),replay:batch.replay,replayEnd:batch.replayEnd,cursor:batch.cursor??null}),id=>latest.current.onWriteProgress?.(id),paused=>latest.current.onFlowControl?.(paused),fatal);
        } finally {restoring.current=false;}
      }
    }
    await serializeCommand('policy' ,{tmux:!!latest.current.onTmuxScroll});initialReplay.current=!result.reused;acceptOutput.current=true;latest.current.onFlowControl?.(false);
    measure();
    return result.baseline;
  },[bridge,fatal,measure,request,serializeCommand,publishRendererReady]);
  React.useEffect(()=>{
    disposed.current=false;
    const unsubscribe=bridge.subscribe((payload:NativeTerminalEvent)=>{
      const current=surface.current;if(!current||payload.token!==current.token||payload.epoch!==current.epoch)return;
      const event=payload.event;
      switch(event.type){
        case 'ack': if(event.sequence!==undefined){queue.current?.ack(event.sequence);current.sequence=event.sequence;current.baseline=queue.current?.consumedCursor??null;}break;
        case 'ready': if(!localResetting.current)engineReady.current=true;
          if(event.position){position.current=event.position;latest.current.onCursorPositionChange?.(event.position);latest.current.onWritesSettled?.({...event.position,lastProcessedChunkId:queue.current?.consumedChunkId??null});}break;
        case 'input': observeOwnedNativeInput(latest.current.sessionKey,current.token,'native-event');if(event.base64){if(inputDecoder.current.token!==current.token)inputDecoder.current={token:current.token,decoder:new TextDecoder()};const raw=Uint8Array.from(atob(event.base64),c=>c.charCodeAt(0));void send(inputDecoder.current.decoder.decode(raw,{stream:true}),{skipModifierTransform:true});}break;
        case 'resize': if(event.cols&&event.rows){dimensions.current={cols:event.cols,rows:event.rows};pushResize();}break;
        case 'focusChanged': {
          if(typeof event.focused!=='boolean'||!Number.isSafeInteger(event.revision)||event.revision!<=0)break;
          const receipt=actualFocusReceipt.current;
          if(receipt.token===current.token&&event.revision!<=receipt.revision)break;
          actualFocusReceipt.current={token:current.token,revision:event.revision!,focused:event.focused};
          // Geometry can stay identical while AppKit transfers the responder.
          // Invalidate once per real loss; repeated negative ACKs must not loop.
          if(!event.focused&&receipt.token===current.token&&receipt.focused)lastLayout.current='';
          const active=document.activeElement,editable=active instanceof HTMLElement&&(active.isContentEditable||active.matches('input,textarea,select'));
          if(!event.focused&&receipt.token===current.token&&receipt.focused&&!explicitBlur.current&&!editable&&latest.current.inputActive!==false&&latest.current.isLayoutVisible!==false&&!document.hidden){
            const life=window.termdockPreviewLifecycle?.snapshot();
            if(life?.focused!==false&&!life?.overlays.length)queueMicrotask(()=>{if(surface.current===current&&!explicitBlur.current)measure();});
          }
          if(event.focused&&(latest.current.inputActive===false||latest.current.isLayoutVisible===false||document.hidden||editable))break;
          latest.current.onInputFocusChange?.(event.focused);break;
        }
        case 'pointer':explicitBlur.current=false;pointerFocus.current=current;container.current?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse'}));measure();break;
        case 'wheel': {
          const wheel=event.wheel;if(!wheel)break;
          container.current?.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:wheel.deltaY}));
          if(wheel.modifiers&(2|8)) {setSessionFontSize(latest.current.sessionId,Math.max(MIN_TERMINAL_FONT_SIZE,Math.min(MAX_TERMINAL_FONT_SIZE,latest.current.terminalSettings.fontSize+(wheel.deltaY<0?1:-1))));break;}
          const state=wheelState.current;state.delta+=wheel.precise?wheel.deltaY:wheel.deltaY*wheel.cellHeight;
          Object.assign(state,{x:wheel.x,y:wheel.y,width:wheel.width,height:wheel.height,cellHeight:wheel.cellHeight});
          if(!state.frame)state.frame=requestAnimationFrame(()=>{
            state.frame=0;const total=state.remainder+state.delta;state.delta=0;
            const lines=Math.trunc(total/Math.max(8,state.cellHeight));state.remainder=total-lines*Math.max(8,state.cellHeight);
            const cap=Math.max(3,Math.floor(dimensions.current.rows/2));if(Math.abs(lines)>cap)state.remainder=0;
            const col=Math.max(1,Math.min(dimensions.current.cols,Math.floor(state.x/state.width*dimensions.current.cols)+1));
            const row=Math.max(1,Math.min(dimensions.current.rows,Math.floor(state.y/state.height*dimensions.current.rows)+1));
            if(lines)void send(`\x1b[<${lines<0?64:65};${col};${row}M`.repeat(Math.min(cap,Math.abs(lines))),{skipModifierTransform:true});
          });break;
        }
        case 'layout': measure();break;
        case 'paste':void paste();break;
        case 'pasteText':if(event.text){const operation=startClipboardOperation();void send(terminalSequencePayload(sanitizeTerminalInput(event.text),{paste:true,submitAfterPaste:false}),{skipModifierTransform:true}).then(accepted=>{if(accepted)operation.succeed();else operation.fail('当前终端未接受粘贴内容。');},reason=>operation.fail(reason instanceof Error?reason.message:String(reason)));}break;
        case 'copyFailed':showClipboardError(event.status==='TooLarge'?'Copy exceeds the 256 KiB limit. Select a smaller range.':event.status==='Unreadable'?'Terminal selection could not be read.':'Clipboard copy was not confirmed.');break;
        case 'selection':if(copying.current&&event.text!==undefined){const done=copying.current;copying.current=null;if(!copyIsCurrent.current?.()){done(false);break;}void navigator.clipboard.writeText(event.text).then(()=>done(true),()=>done(false));}break;
        case 'search':searchGeneration.current++;setSearchResult('');setSearch(event.text||'');break;
        case 'close':window.dispatchEvent(new CustomEvent('termdock:native-command',{detail:'close-session'}));break;
        case 'shortcut':{
          const focused=document.activeElement;if(focused instanceof HTMLElement&&(focused.isContentEditable||focused.matches('input,textarea,select')))break;
          const key=event.key||'';const modifiers=event.modifiers||0;
          if(key.toLowerCase()==='c'&&(modifiers&15)===8&&latest.current.onTmuxScroll){void copyTmuxSelection(event.copyId);break;}
          const terminal=nativeTerminalShortcut(key,event.keyCode??0,modifiers);if(terminal){if(terminal.kind==='clear')clearLocal();else void send(terminalSequencePayload(terminal.data),{skipModifierTransform:true});break;}
          const font=nativeSessionFontShortcut(key,modifiers);if(font){setSessionFontSize(latest.current.sessionId,font==='reset'?null:latest.current.terminalSettings.fontSize+(font==='increase'?1:-1));break;}
          const menu=nativeMenuShortcut(key,event.keyCode??0,modifiers);if(menu){void serializeCommand('menu',{id:menu}).catch(fatal);break;}
          const code=event.keyCode===33?'BracketLeft':event.keyCode===30?'BracketRight':key.length===1?`Key${key.toUpperCase()}`:undefined;
          document.dispatchEvent(new KeyboardEvent('keydown',{key,code,metaKey:(modifiers&8)!==0,ctrlKey:(modifiers&2)!==0,altKey:(modifiers&4)!==0,shiftKey:(modifiers&1)!==0,bubbles:true,cancelable:true}));break;
        }
        case 'title':if(event.text!==undefined)latest.current.onNativeTitleChange?.(event.text);break;
        case 'link':if(event.text){try{const url=new URL(event.text);if(url.protocol==='file:')latest.current.onDirectoryLinkActivate?.(decodeURIComponent(url.pathname));else if(['https:','http:','mailto:'].includes(url.protocol))window.open(url.href,'_blank','noopener');}catch{/* An invalid remote link is inert. */}}break;
        case 'pathHover':if(event.text&&event.revision){try{
          const incoming=JSON.parse(event.text) as Record<string,unknown>;
          const data=event.partial?(hoverSlice.current?.token===current.token?{...hoverSlice.current.data,...incoming}:null):incoming;
          if(data){if(!event.partial)hoverSlice.current={token:current.token,data};const rects=nativePathHoverRects(data);void serializeCommand('linkHover',{revision:event.revision,rects}).catch(()=>{});}
        }catch{/* Invalid or expired hover data cannot activate anything. */}}break;
        case 'path':if(event.text){try{activateNativePathHit(JSON.parse(event.text),latest.current.onDirectoryLinkActivate,event.plainClick===true?url=>{window.open(url,'_blank','noopener');}:undefined);}catch{/* A bounded or stale path read is inert. */}}break;
        case 'bell':container.current?.dispatchEvent(new CustomEvent('termdock:terminal-bell',{bubbles:true}));break;
        case 'fatal':fatal(event.message||'Native terminal failed');break;
        case 'rejected':showPersistentError(event.message||'Native input was rejected',JSON.stringify([latest.current.sessionKey,latest.current.backendSessionId??null,selectedTarget()?.targetPeerId??null]));break;
      }
    });
    // Geometry readiness breaks the ensureSession/backend creation dependency.
    // No consumption or applied output cursor is claimed at this stage.
    latest.current.onReadyChange?.(true);
    const drops=subscribeNativeFileDrops(payload=>{
      const owner=latest.current.sessionKey;
      if(payload.sessionKey!==owner)return;
      const operation=startClipboardOperation();
      void send(payload.paths.map(escapeShellPath).join(' ')+' ',{targeted:true}).then(accepted=>{
        if(latest.current.sessionKey===owner&&!accepted)showClipboardError('文件已上传，但当前终端未接受路径；请重新拖入。',operation);
        else if(latest.current.sessionKey===owner)clearClipboardError(operation);
      }).catch(reason=>{if(latest.current.sessionKey===owner)showClipboardError(String(reason instanceof Error?reason.message:reason),operation);});
    });
    const observer=new ResizeObserver(measure);if(container.current)observer.observe(container.current);
    const lifecycle=window.termdockPreviewLifecycle?.subscribe(measure);
    const focusOut=()=>queueMicrotask(measure);
    const focusIn=()=>{pointerFocus.current=null;measure();};
    document.addEventListener('focusin',focusIn);document.addEventListener('focusout',focusOut);
    const dropZone=container.current;const dropError=(event:Event)=>{const message=(event as CustomEvent).detail;if(typeof message==='string')showClipboardError(message);};dropZone?.addEventListener('termdock:file-drop-error',dropError);
    return()=>{
      publishRendererReady(false);disposed.current=true;pointerFocus.current=null;cancelAnimationFrame(layoutFrame.current);cancelAnimationFrame(wheelState.current.frame);queue.current?.stop();unsubscribe();drops();dropZone?.removeEventListener('termdock:file-drop-error',dropError);observer.disconnect();lifecycle?.();document.removeEventListener('focusin',focusIn);document.removeEventListener('focusout',focusOut);
      latest.current.onReadyChange?.(false);
      // Retain the full living VT for remount/reload. Window destruction owns
      // final drop; stale tokens cannot mutate a new page epoch.
      if(surface.current)void hideNativeLease(latest.current.sessionKey,surface.current.token).catch(()=>{});
    };
  },[startClipboardOperation,clearClipboardError,bridge,clearLocal,copyTmuxSelection,fatal,measure,paste,pushResize,send,publishRendererReady,showClipboardError,showPersistentError]);
  React.useEffect(()=>{if(acceptOutput.current&&(!props.backendSessionId||props.backendSessionId===backend.current)&&props.chunks.length){queue.current?.accept(props.chunks,initialReplay.current,props.nativeCursor);initialReplay.current=false;}},[props.chunks,props.backendSessionId]);
  React.useEffect(()=>{if(surface.current){void serializeCommand('policy',{tmux:!!props.onTmuxScroll}).catch(fatal);void serializeCommand('history',{history:props.onTmuxScroll?0:1000}).catch(fatal);}},[props.onTmuxScroll,serializeCommand,fatal]);
  React.useEffect(measure,[measure,props.autoFocus,props.inputActive,props.isLayoutVisible,search]);
  React.useEffect(()=>{if(surface.current)void serializeCommand('palette',{palette:palette(props.theme)}).catch(fatal);},[props.theme,serializeCommand,fatal]);
  React.useEffect(()=>{if(surface.current)void serializeCommand('cursor',{visible:props.cursorVisible!==false,blink:props.terminalSettings.rendererMode!=='webgl'}).catch(fatal);},[props.cursorVisible,props.terminalSettings.rendererMode,serializeCommand,fatal]);
  React.useEffect(()=>{if(surface.current)void serializeCommand('fontSize',{size:props.terminalSettings.fontSize}).catch(fatal);},[props.terminalSettings.fontSize,serializeCommand,fatal]);
  React.useEffect(()=>{if(surface.current)void serializeCommand('font',{font:nativeFont(props.terminalSettings)}).catch(fatal);},[props.terminalSettings.fontFamily,props.terminalSettings.fontLigatures,props.terminalSettings.letterSpacing,props.terminalSettings.lineHeight,props.terminalSettings.fontWeight,props.terminalSettings.fontWeightBold,props.terminalSettings.minimumContrastRatio,props.terminalSettings.drawBoldTextInBrightColors,serializeCommand,fatal]);
  React.useImperativeHandle(ref,()=>({
    serializeSnapshot:()=>null,
    renderer:()=>engineReady.current?'native':'native-pending',
    prepareNativeSession:session=>prepare(session).catch(error=>{fatal(error);throw error;}),
    captureNativeSnapshot:async(cursor)=>{if(!queue.current?.idle)return null;const session=backend.current;if(!session)return null;const generation=nativeSnapshotRevision(session);const value=await serializeCommand('capture',{sequence:queue.current.consumedSequence,cursor}) as Omit<NativeSnapshot,'savedAt'>|{status:string}|null;return value&&!('status' in value)?tagNativeSnapshot({...value,savedAt:Date.now()},generation):null;},
    saveNativeCursor:async(cursor)=>{if(queue.current?.idle)await serializeCommand('checkpoint',{sequence:queue.current.consumedSequence,cursor});},
    focus:()=>{explicitBlur.current=false;if(surface.current)void serializeCommand('focus',{focused:true}).catch(fatal);},
    blur:()=>{explicitBlur.current=true;if(surface.current)void serializeCommand('focus',{focused:false}).catch(fatal);latest.current.onInputFocusChange?.(false);},
    clear:clearLocal,
    prepareScreenReplacement:()=>{
      // An authoritative stream replacement needs a neutral parser too. A RIS
      // fed into an unfinished OSC/DCS is not a parser reset. Replace only the
      // rendering surface; keep the service PTY and original stream intact.
      const stamp=surface.current,session=backend.current;if(!stamp||!session)return;
      acceptOutput.current=false;engineReady.current=false;publishRendererReady(false);queue.current?.stop();latest.current.onFlowControl?.(true);
      void serializeCommand('destroy').then(async()=>{
        if(surface.current!==stamp)throw new NativeOwnerChanged('Authoritative replacement was superseded');
        surface.current=null;await prepare(session,false);
        queue.current?.accept(latest.current.chunks,true,latest.current.nativeCursor);initialReplay.current=false;
      }).catch(fatal);
    },
    copySelectionOrViewport:async()=>{
      const cancelCopy=()=>{copying.current?.(false);copying.current=null;};
      const operation=startClipboardOperation();
      if(copying.current){showClipboardError('Copy is already pending.',operation);return false;}
      const stamp=surface.current;copyIsCurrent.current=()=>operation.isCurrent()&&surface.current===stamp&&!disposed.current;
      try {
        const copied=new Promise<boolean>(resolve=>{copying.current=resolve;setTimeout(()=>{if(copying.current===resolve){copying.current=null;resolve(false);}},1000);});
        const result=await serializeCommand('copy',{selection:true}) as {status?:string}|null;
        if(result?.status&&result.status!=='Copied'){
          cancelCopy();
          if(surface.current===stamp&&!disposed.current)showClipboardError(result.status==='TooLarge'?'Copy exceeds the 256 KiB limit. Select a smaller range.':result.status==='Empty'?'There is no terminal text to copy.':'Terminal text could not be read.',operation);
          return false;
        }
        const ok=await copied;if(!ok&&surface.current===stamp&&!disposed.current)showClipboardError('Clipboard copy was not confirmed.',operation);else if(ok)clearClipboardError(operation);return ok;
      } catch(reason){cancelCopy();operation.fail(reason instanceof Error?reason.message:String(reason));return false;}
    },
    pasteClipboardText:paste,
    sendSequence:(text,options)=>send(terminalSequencePayload(text,options),{skipModifierTransform:true,targeted:options?.targeted,consumeModifier:options?.consumeModifier,ownedPaste:options?.ownedPaste}),
    getDimensions:()=>dimensions.current,
    requestRefresh:()=>{measure();pushResize();},
    setSessionReady:ready=>{sessionReady.current=ready;if(ready)pushResize();else latest.current.onSizeSynchronizedChange?.(false);},
    acknowledgeResize:ack=>{const result=acknowledgeResize(resize.current,ack);if(!result.accepted)return;resize.current=result.state;syncGeneration.current=ack.screenSyncPending?ack.screenSyncGeneration??null:null;latest.current.onSizeSynchronizedChange?.(!ack.screenSyncPending||appliedGeneration.current>=(ack.screenSyncGeneration??0));},
    notifyScreenSynchronized:generation=>{appliedGeneration.current=Math.max(generation,appliedGeneration.current);if(syncGeneration.current!==null&&generation>=syncGeneration.current){syncGeneration.current=null;latest.current.onSizeSynchronizedChange?.(true);}},
    notifyServerSize:(cols,rows)=>{resize.current=observeServerSize(resize.current,{cols,rows});},
    ensureSizeMatches:()=>pushResize(),
    requestPtyRedraw:()=>pushResize(true),
  }),[startClipboardOperation,clearClipboardError,clearLocal,fatal,measure,paste,prepare,pushResize,send,serializeCommand,publishRendererReady,showClipboardError]);
  return <div ref={container} data-termdock-terminal-dropzone={props.sessionKey} data-termdock-terminal-owner={props.getPasteOwnerKey?.()??props.backendSessionId??props.sessionKey} aria-disabled={props.inputActive===false} className={`relative h-full w-full terminal-viewport-container ${props.className||''}`} style={{backgroundColor:props.theme.background}} onPointerDown={event=>{
    // WK can receive a click while the native sibling is temporarily clipped.
    // A click on this pane must retry focus even if cached layout is unchanged;
    // child search fields/buttons and inactive panes retain their own focus.
    if(event.target!==event.currentTarget||!surface.current||latest.current.inputActive===false||latest.current.isLayoutVisible===false||document.hidden)return;
    explicitBlur.current=false;pointerFocus.current=surface.current;lastLayout.current='';measure();
  }}>
    {feedbackMessage&&<div role="alert" className="absolute bottom-2 left-2 z-20 rounded bg-surface p-2 text-destructive"><span>{feedbackMessage}</span><button onClick={clearFeedback}>×</button></div>}
    {error&&<div role="alert" className="absolute inset-0 z-20 flex items-center justify-center bg-background p-4 text-destructive">{error}</div>}
    {search!==null&&<div role="dialog" className="absolute right-2 top-2 z-30 flex gap-2 rounded bg-surface p-2">
      <input autoFocus aria-label="搜索终端" value={search} onChange={event=>{setSearch(event.target.value);searchTerminal(event.target.value,0);}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();void closeSearch();}else if(event.key==='Enter'){event.preventDefault();searchTerminal(search,event.shiftKey?-1:1);}}}/>
      <span>{searchResult}</span><button aria-label="关闭终端搜索" onClick={()=>{void closeSearch();}}>×</button>
    </div>}
  </div>;
});
