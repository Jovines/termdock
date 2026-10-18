import { getTermdockDesktopBridge, type NativeTerminalBridge } from '../desktop/nativeBridge';
import { selectedTarget } from '../federation/clientScope';

type RetirementResult='detached'|'superseded'|'not-current';
type Lease = { view:string; token:string; bridge:NativeTerminalBridge; guarded:boolean; owner:string; epoch?:string; ready:boolean; hiddenConfirmed?:boolean; visibilityRevision?:number; cancelHandoff?:()=>void; retirementAttempt?:{cancelled:boolean}; failureId?:string; inheritedFailures?:string[]; retry?:()=>Promise<unknown>; retiring?:Promise<RetirementResult> };
const leases=new Map<string,Lease>();
let nextFailure=0;
const resolved=(ids:string[])=>{if(ids.length)window.dispatchEvent(new CustomEvent('termdock:native-cleanup-resolved',{detail:{recoveryIds:ids}}));};
const rendererListeners=new Set<()=>void>();
const rendererChanged=()=>{for(const listener of rendererListeners)listener();};
export const subscribeNativeRenderer=(listener:()=>void)=>{rendererListeners.add(listener);return()=>{rendererListeners.delete(listener);};};
export function isNativeRendererReady(view:string|null):boolean {
 const lease=view?leases.get(view):undefined;
 return !!lease?.ready&&lease.owner===targetStamp()&&getTermdockDesktopBridge()?.nativeTerminal===lease.bridge;
}
export function markNativeRendererReady(view:string,token:string,ready:boolean){
 const lease=leases.get(view);if(!lease||lease.token!==token||lease.ready===ready)return;
 lease.ready=ready;rendererChanged();
 if(ready&&lease.owner===targetStamp()&&getTermdockDesktopBridge()?.nativeTerminal===lease.bridge){
  resolved(lease.inheritedFailures??[]);lease.inheritedFailures=[];
 }
}
/** A new show intent invalidates the exact lease's earlier hide receipt. */
export function invalidateNativeHiddenReceipt(view:string,token:string){
 const lease=leases.get(view);if(lease?.token===token){lease.visibilityRevision=(lease.visibilityRevision??0)+1;lease.hiddenConfirmed=false;}
}
const targetStamp=()=>{const target=selectedTarget();return JSON.stringify(target?[target.targetPeerId,target.url,target.serviceOrigin,target.entryServiceId]:null);};
const guard=(lease:Lease,active:boolean)=>{
  if(lease.guarded===active)return;
  lease.guarded=active;window.termdockPreviewLifecycle?.nativePanels(active);
};
function failure(lease:Lease,error:unknown,retry:()=>Promise<unknown>){
  lease.retry=retry;lease.failureId??=`native-lease:${++nextFailure}`;
  window.dispatchEvent(new CustomEvent('termdock:native-cleanup-error',{detail:{message:String(error),retry,recoveryId:lease.failureId}}));
}
/** A new host capability proves the previous capability no longer owns this
 * view. Transfer its CSS guard without any unprotected intermediate paint. */
export function registerNativeLease(view:string,token:string,bridge:NativeTerminalBridge,epoch?:string){
  const previous=leases.get(view);
  const lease:Lease={view,token,bridge,epoch,owner:targetStamp(),ready:false,guarded:previous?.guarded??false};
  if(previous?.bridge===bridge&&previous.owner===lease.owner&&previous.epoch===epoch){
    lease.inheritedFailures=[...(previous.inheritedFailures??[]),...(previous.failureId?[previous.failureId]:[])].slice(-32);
  }
  leases.set(view,lease);guard(lease,true);rendererChanged();
}
/** Host replacement can become current before create's reply registers it in JS.
 * Wait only for registration, never repeat a native request or release a guard. */
function waitForReplacement(view:string,lease:Lease):Promise<boolean>{
 if(leases.get(view)!==lease)return Promise.resolve(true);
 return new Promise(resolve=>{
  let timer:ReturnType<typeof setTimeout>;
  const cancel=()=>done(false);
  const done=(active=true)=>{clearTimeout(timer);rendererListeners.delete(changed);if(lease.cancelHandoff===cancel)lease.cancelHandoff=undefined;resolve(active);};
  const changed=()=>{if(leases.get(view)!==lease||targetStamp()!==lease.owner||getTermdockDesktopBridge()?.nativeTerminal!==lease.bridge)done();};
  lease.cancelHandoff=cancel;rendererListeners.add(changed);timer=setTimeout(done,1000);changed();
 });
}
export async function retireNativeLease(view:string,token?:string,isCurrent=()=>true):Promise<RetirementResult>{
  if(!isCurrent())return 'not-current';
  const lease=leases.get(view);
  if(!lease){
    const native=getTermdockDesktopBridge()?.nativeTerminal;
    if(!native?.available)throw Error('Native detach capability unavailable');
    const receipt=await native.request(token?{action:'retireView',view,token}:{action:'closeView',view}) as {detached?:boolean;view?:string;token?:string;disposition?:string};
    if(token&&(receipt.token!==token||!['current','absent'].includes(receipt.disposition??'')))throw Error('Native retirement owner was not confirmed');
    if(receipt?.detached!==true||receipt.view!==view)throw Error('Native detach was not confirmed');return 'detached';
  }
  if(token&&lease.token!==token)return 'not-current';
  if(lease.retiring)return lease.retiring;
  const attempt={cancelled:false};lease.retirementAttempt=attempt;
  const run=async():Promise<RetirementResult>=>{try{
    const receipt=await lease.bridge.request({action:'retireView',view,token:lease.token}) as {detached?:boolean;view?:string;token?:string;epoch?:string;disposition?:string;replacementToken?:string};
    if(receipt?.view!==view||receipt.token!==lease.token||(lease.epoch!==undefined&&receipt.epoch!==lease.epoch))throw new Error('Native retirement owner was not confirmed');
    if(receipt.disposition==='superseded') {
      if(attempt.cancelled)return 'not-current';
      if(receipt.detached===false&&typeof receipt.replacementToken==='string'&&receipt.replacementToken!==lease.token&&!await waitForReplacement(view,lease))return 'not-current';
      const replacement=leases.get(view);
      // The old binding ended, but the current NSView may be a living rebind.
      // Only an exact registered replacement can absorb the old guard/failure.
      const invalid=receipt.detached!==false?'invalid-receipt':!replacement||replacement===lease?'registration-missing':replacement.token!==receipt.replacementToken?'replacement-token':replacement.bridge!==lease.bridge||getTermdockDesktopBridge()?.nativeTerminal!==lease.bridge?'bridge-changed':lease.epoch!==undefined&&replacement.epoch!==lease.epoch?'page-changed':replacement.owner!==lease.owner||replacement.owner!==targetStamp()?'target-changed':!replacement.guarded&&!replacement.hiddenConfirmed?'not-protected':null;
      if(invalid)throw new Error(`Native retirement replacement was not confirmed (${invalid})`);
      return 'superseded';
    }
    if(receipt.detached!==true||!['current','absent'].includes(receipt.disposition??''))throw new Error('Native detach was not confirmed');
    if(leases.get(view)!==lease)return 'not-current';
    guard(lease,false);leases.delete(view);rendererChanged();resolved([...(lease.inheritedFailures??[]),...(lease.failureId?[lease.failureId]:[])]);return 'detached';
  }catch(error){if(leases.get(view)===lease){guard(lease,true);failure(lease,error,()=>retireNativeLease(view,lease.token,isCurrent));}throw error;}};
  const pending=run();lease.retiring=pending;
  try{return await pending;}finally{if(lease.retiring===pending)lease.retiring=undefined;if(lease.retirementAttempt===attempt)lease.retirementAttempt=undefined;}
}
/** Temporary React removal retains VT only after actual hide succeeds. */
export async function hideNativeLease(view:string,token:string){
  const lease=leases.get(view);if(!lease||lease.token!==token)return;
  if(lease.retirementAttempt)lease.retirementAttempt.cancelled=true;
  lease.cancelHandoff?.();
  const visibilityRevision=lease.visibilityRevision=(lease.visibilityRevision??0)+1;
  try{
    const receipt=await lease.bridge.request({action:'visible',token,visible:false}) as {visible?:boolean;epoch?:string};
    if(receipt?.visible!==false)throw new Error('Native hide was not confirmed');
    if(leases.get(view)===lease&&lease.visibilityRevision===visibilityRevision){lease.hiddenConfirmed=receipt.epoch===lease.epoch&&lease.epoch!==undefined&&lease.bridge===getTermdockDesktopBridge()?.nativeTerminal&&lease.owner===targetStamp();guard(lease,false);}
  }catch{await retireNativeLease(view,token);}
}
/** Confirmed inventory removal, distinct from backend exit/temporary unmount. */
export async function closeNativeSession(frontendSessionId:string,isStillRemoved=()=>true){
  const view=`terminal::${frontendSessionId}`;
  const target=targetStamp(),bridge=getTermdockDesktopBridge()?.nativeTerminal;
  const lease=leases.get(view);
  const valid=()=>isStillRemoved()&&targetStamp()===target&&getTermdockDesktopBridge()?.nativeTerminal===bridge&&(!lease||leases.get(view)===lease);
  if(!valid())return;
  if(lease){await retireNativeLease(view,lease.token,valid);return;}
  // A retained surface may predate this page and have no JS lease. Explicit
  // close is still scoped by the host's actual window/service/target context.
  const native=bridge;if(!native?.available)return;
  try{
    const receipt=await native.request({action:'closeView',view}) as {detached?:boolean;view?:string};
    if(receipt?.detached!==true||receipt.view!==view)throw Error('Native explicit close was not confirmed');
  }catch(error){window.dispatchEvent(new CustomEvent('termdock:native-cleanup-error',{detail:{message:String(error),retry:()=>valid()&&!leases.has(view)?closeNativeSession(frontendSessionId,isStillRemoved):Promise.resolve()}}));throw error;}
}

export async function closeAllNativeSessions(){
  const native=getTermdockDesktopBridge()?.nativeTerminal;if(!native?.available)return;
  const previous=[...leases.values()].filter(lease=>lease.view.startsWith('terminal::'));
  const target=targetStamp();
  // Send at the start of the clear operation. The host captures its own live
  // generations before main-thread enqueue; new views/tokens are preserved.
  let receipt:{detached?:boolean;retired?:Array<{view:string;token:string}>};
  try{receipt=await native.request({action:'closeAllViews'}) as typeof receipt;
    if(receipt?.detached!==true||!Array.isArray(receipt.retired))throw Error('Native bulk close was not confirmed');
  }catch(error){
    const retry=async()=>{if(targetStamp()!==target||getTermdockDesktopBridge()?.nativeTerminal!==native)return;await Promise.all(previous.filter(lease=>leases.get(lease.view)===lease).map(lease=>retireNativeLease(lease.view,lease.token,()=>targetStamp()===target&&leases.get(lease.view)===lease)));};
    window.dispatchEvent(new CustomEvent('termdock:native-cleanup-error',{detail:{message:String(error),retry}}));throw error;
  }
  if(targetStamp()!==target||getTermdockDesktopBridge()?.nativeTerminal!==native)return;
  for(const lease of previous){if(leases.get(lease.view)===lease&&receipt.retired!.some(entry=>entry.view===lease.view&&entry.token===lease.token)){guard(lease,false);leases.delete(lease.view);rendererChanged();}}
}
