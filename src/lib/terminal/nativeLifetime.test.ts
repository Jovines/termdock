// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
const client=vi.hoisted(()=>({native:null as any}));
vi.mock('../desktop/nativeBridge',()=>({getTermdockDesktopBridge:()=>client.native?{nativeTerminal:client.native}:null}));
import {closeNativeSession,closeAllNativeSessions,hideNativeLease,invalidateNativeHiddenReceipt,registerNativeLease,retireNativeLease,isNativeRendererReady,markNativeRendererReady} from './nativeLifetime';
import { saveSelectedTarget, clearSelectedTarget } from '../federation/clientScope';
const bridge=(request:(args:Record<string,unknown>)=>Promise<unknown>)=>({available:true,request,subscribe:()=>()=>{}});
afterEach(()=>{client.native=null;clearSelectedTarget();delete window.termdockPreviewLifecycle;});
it('temporary remount retains the surface; explicit close drops it and permits unlimited close/create cycles',async()=>{
 const count=vi.fn();window.termdockPreviewLifecycle={nativePanels:count} as any;
 const request=vi.fn(async(args:any)=>args.action==='visible'?{visible:false}:{detached:true,view:args.view,token:args.token,disposition:'current'});
 for(let n=0;n<40;n++){
  const view=`terminal::cycle-${n}`,token=`token-${n}`;registerNativeLease(view,token,bridge(request));
  await hideNativeLease(view,token);expect(request.mock.calls.at(-1)?.[0].action).toBe('visible');
  registerNativeLease(view,token,bridge(request));await closeNativeSession(`cycle-${n}`);
  expect(request.mock.calls.at(-1)?.[0]).toMatchObject({action:'retireView',view,token});
 }
 expect(count.mock.calls.filter(([active])=>active)).toHaveLength(80);expect(count.mock.calls.filter(([active])=>!active)).toHaveLength(80);
});
it('hide rejection retains the CSS guard until delayed matching detach completes',async()=>{
 const count=vi.fn();window.termdockPreviewLifecycle={nativePanels:count} as any;let detach!:(value:unknown)=>void;
 const request=vi.fn(async(args:any)=>{if(args.action==='visible')throw Error('hide rejected');return await new Promise(resolve=>{detach=resolve;});});
 registerNativeLease('delay','token',bridge(request));const pending=hideNativeLease('delay','token');await Promise.resolve();expect(count).not.toHaveBeenCalledWith(false);
 detach({detached:true,view:'delay',token:'token',disposition:'current'});await pending;expect(count).toHaveBeenCalledWith(false);
});
it('double failure retains protection and exposes a safe retry; stale cleanup cannot retire a remounted token',async()=>{
 const count=vi.fn(),notice=vi.fn();window.termdockPreviewLifecycle={nativePanels:count} as any;window.addEventListener('termdock:native-cleanup-error',notice);
 const request=vi.fn<(args:Record<string,unknown>)=>Promise<unknown>>(async()=>{throw Error('detach failed');});registerNativeLease('failure','old',bridge(request));await expect(hideNativeLease('failure','old')).rejects.toThrow('detach failed');expect(count).not.toHaveBeenCalledWith(false);
 const retry=notice.mock.calls[0][0].detail.retry;registerNativeLease('failure','new',bridge(request));await retry();expect(request).toHaveBeenCalledTimes(2);expect(count).not.toHaveBeenCalledWith(false);
 request.mockResolvedValue({detached:true,view:'failure',token:'new',disposition:'current'});await retireNativeLease('failure','new');expect(count).toHaveBeenCalledWith(false);window.removeEventListener('termdock:native-cleanup-error',notice);
});

it('explicit close also retires retained previous-page panels without a JS lease',async()=>{
 const request=vi.fn(async(args:any)=>({detached:true,view:args.view,token:args.token,disposition:'current'}));client.native=bridge(request);
 await closeNativeSession('previous-page');expect(request).toHaveBeenCalledWith({action:'closeView',view:'terminal::previous-page'});
 request.mockResolvedValue({detached:false,view:'terminal::previous-page',token:undefined,disposition:'current'});await expect(closeNativeSession('previous-page')).rejects.toThrow('not confirmed');
});
it('concurrent matching retirement requests share one actual detach',async()=>{
 let resolve!:(value:unknown)=>void;const request=vi.fn(async()=>await new Promise(done=>{resolve=done;}));const native=bridge(request);client.native=native;
 registerNativeLease('terminal::concurrent','actual',native);
 const first=closeNativeSession('concurrent'),second=closeNativeSession('concurrent');expect(request).toHaveBeenCalledOnce();
 resolve({detached:true,view:'terminal::concurrent',token:'actual',disposition:'current'});await Promise.all([first,second]);
});
it('failed removal retry cannot close a reappeared ID, a new lease, or a different service',async()=>{
 let removed=true;const notice=vi.fn();window.addEventListener('termdock:native-cleanup-error',notice);
 const request=vi.fn<(args:Record<string,unknown>)=>Promise<unknown>>(async()=>{throw Error('controlled detach failure');});const native=bridge(request);client.native=native;
 saveSelectedTarget({url:'http://127.0.0.1:12345',targetPeerId:'controlled-a'});
 registerNativeLease('terminal::guarded','old',native);await expect(closeNativeSession('guarded',()=>removed)).rejects.toThrow('controlled');
 const retry=notice.mock.calls[0][0].detail.retry;
 removed=false;await retry();expect(request).toHaveBeenCalledOnce();
 removed=true;saveSelectedTarget({url:'http://127.0.0.1:12346',targetPeerId:'controlled-b'});await retry();expect(request).toHaveBeenCalledOnce();
 saveSelectedTarget({url:'http://127.0.0.1:12345',targetPeerId:'controlled-a'});registerNativeLease('terminal::guarded','new',native);await retry();expect(request).toHaveBeenCalledOnce();
 request.mockImplementation(async()=>({detached:true,view:'terminal::guarded',token:'new',disposition:'current'}));await closeNativeSession('guarded');window.removeEventListener('termdock:native-cleanup-error',notice);
});
it('bulk clear is sent before any await and does not release a new lease from an old receipt',async()=>{
 let resolve!:(value:unknown)=>void;const count=vi.fn();window.termdockPreviewLifecycle={nativePanels:count} as any;
 const request=vi.fn<(args:Record<string,unknown>)=>Promise<unknown>>(async()=>await new Promise(done=>{resolve=done;}));const native=bridge(request);client.native=native;
 registerNativeLease('terminal::bulk','old',native);const pending=closeAllNativeSessions();expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][0].action).toBe('closeAllViews');
 registerNativeLease('terminal::bulk','new',native);resolve({detached:true,retired:[{view:'terminal::bulk',token:'old'}]});await pending;expect(count).not.toHaveBeenCalledWith(false);
 request.mockResolvedValue({detached:true,view:'terminal::bulk',token:'new',disposition:'current'});await closeNativeSession('bulk');
});
it('failed bulk cleanup remains visible and its retry is limited to the captured old leases',async()=>{
 const request=vi.fn<(args:Record<string,unknown>)=>Promise<unknown>>(async()=>{throw Error('controlled bulk rejection');});const native=bridge(request);client.native=native;const notice=vi.fn();window.addEventListener('termdock:native-cleanup-error',notice);
 registerNativeLease('terminal::bulk-failed','old',native);await expect(closeAllNativeSessions()).rejects.toThrow('bulk rejection');registerNativeLease('terminal::bulk-failed','new',native);await notice.mock.calls[0][0].detail.retry();expect(request).toHaveBeenCalledOnce();
 request.mockResolvedValue({detached:true,view:'terminal::bulk-failed',token:'new',disposition:'current'});await closeNativeSession('bulk-failed');window.removeEventListener('termdock:native-cleanup-error',notice);
});

it('host-confirmed superseded retirement finishes only the exact old binding and retains the replacement guard',async()=>{
 let done!:(value:unknown)=>void;const count=vi.fn(),notice=vi.fn();window.termdockPreviewLifecycle={nativePanels:count} as any;window.addEventListener('termdock:native-cleanup-error',notice);
 const request=vi.fn<(args:Record<string,unknown>)=>Promise<unknown>>(async()=>await new Promise(resolve=>{done=resolve;}));const native=bridge(request);client.native=native;
 registerNativeLease('race','old',native,'page');const pending=retireNativeLease('race','old');registerNativeLease('race','new',native,'page');
 done({view:'race',token:'old',epoch:'page',detached:false,disposition:'superseded',replacementToken:'new'});await pending;
 expect(notice).not.toHaveBeenCalled();expect(count).not.toHaveBeenCalledWith(false);
 request.mockResolvedValue({view:'race',token:'new',epoch:'page',detached:true,disposition:'current'});await retireNativeLease('race','new');expect(count).toHaveBeenCalledWith(false);window.removeEventListener('termdock:native-cleanup-error',notice);
});
it('unknown, wrong replacement or stale epoch never counts as a retirement or releases a live guard',async()=>{
 for(const wrong of [{replacementToken:'other'},{epoch:'old-page'},{token:'other'},{detached:true}]){
  const view=`invalid-${JSON.stringify(wrong)}`;let done!:(value:unknown)=>void;const count=vi.fn();window.termdockPreviewLifecycle={nativePanels:count} as any;
  const request=vi.fn<(args:Record<string,unknown>)=>Promise<unknown>>(async()=>await new Promise(resolve=>{done=resolve;}));const native=bridge(request);client.native=native;
  registerNativeLease(view,'old',native,'page');const pending=retireNativeLease(view,'old');registerNativeLease(view,'new',native,'page');
  done({view,token:'old',epoch:'page',detached:false,disposition:'superseded',replacementToken:'new',...wrong});await expect(pending).rejects.toThrow(/not confirmed/);expect(count).not.toHaveBeenCalledWith(false);
  request.mockResolvedValue({view,token:'new',epoch:'page',detached:true,disposition:'current'});await retireNativeLease(view,'new');
 }
});
it('actual renderer readiness is scoped to the selected bridge, target, view and current token',async()=>{
 const request=vi.fn(async(args:any)=>({detached:true,view:args.view,token:args.token,disposition:'current'}));const native=bridge(request);client.native=native;
 registerNativeLease('terminal::ready','old',native);expect(isNativeRendererReady('terminal::ready')).toBe(false);
 markNativeRendererReady('terminal::ready','old',true);expect(isNativeRendererReady('terminal::ready')).toBe(true);expect(isNativeRendererReady('terminal::other')).toBe(false);
 registerNativeLease('terminal::ready','new',native);markNativeRendererReady('terminal::ready','old',true);expect(isNativeRendererReady('terminal::ready')).toBe(false);
 markNativeRendererReady('terminal::ready','new',true);expect(isNativeRendererReady('terminal::ready')).toBe(true);markNativeRendererReady('terminal::ready','new',false);expect(isNativeRendererReady('terminal::ready')).toBe(false);
 markNativeRendererReady('terminal::ready','new',true);saveSelectedTarget({url:'http://127.0.0.1:12345',targetPeerId:'other'});expect(isNativeRendererReady('terminal::ready')).toBe(false);clearSelectedTarget();await retireNativeLease('terminal::ready','new');
});

it('waits for the exact host-confirmed replacement registration before completing old cleanup',async()=>{
 let done!:(value:unknown)=>void;const notice=vi.fn();window.addEventListener('termdock:native-cleanup-error',notice);
 const request=vi.fn(async(args:any)=>args.action==='retireView'&&args.token==='gap-old'?await new Promise(resolve=>{done=resolve;}):({detached:true,view:args.view,token:args.token,disposition:'current',epoch:'gap-page'}));
 const native=bridge(request);client.native=native;registerNativeLease('registration-gap','gap-old',native,'gap-page');
 const pending=retireNativeLease('registration-gap','gap-old');void pending.catch(()=>{});
 done({view:'registration-gap',token:'gap-old',epoch:'gap-page',detached:false,disposition:'superseded',replacementToken:'gap-new'});
 await Promise.resolve();await Promise.resolve();registerNativeLease('registration-gap','gap-new',native,'gap-page');
 await expect(pending).resolves.toBe('superseded');expect(notice).not.toHaveBeenCalled();
 await retireNativeLease('registration-gap','gap-new');window.removeEventListener('termdock:native-cleanup-error',notice);
});
it('keeps rejecting an unguarded replacement even when a hide receipt exists',async()=>{
 let done!:(value:unknown)=>void;const notice=vi.fn();window.addEventListener('termdock:native-cleanup-error',notice);
 const request=vi.fn(async(args:any)=>args.action==='visible'?{visible:false}:args.token==='hidden-old'?await new Promise(resolve=>{done=resolve;}):({detached:true,view:args.view,token:args.token,disposition:'current',epoch:'hidden-page'}));
 const native=bridge(request);client.native=native;registerNativeLease('hidden-replacement','hidden-old',native,'hidden-page');
 const pending=retireNativeLease('hidden-replacement','hidden-old');void pending.catch(()=>{});
 registerNativeLease('hidden-replacement','hidden-new',native,'hidden-page');await hideNativeLease('hidden-replacement','hidden-new');
 done({view:'hidden-replacement',token:'hidden-old',epoch:'hidden-page',detached:false,disposition:'superseded',replacementToken:'hidden-new'});
 await expect(pending).rejects.toThrow('Native retirement replacement was not confirmed');expect(notice).not.toHaveBeenCalled();
 await retireNativeLease('hidden-replacement','hidden-new');window.removeEventListener('termdock:native-cleanup-error',notice);
});
it('registration timeout keeps the old guard and exposes failure without another host request',async()=>{
 vi.useFakeTimers();const notice=vi.fn(),count=vi.fn();window.termdockPreviewLifecycle={nativePanels:count} as any;window.addEventListener('termdock:native-cleanup-error',notice);
 const request=vi.fn(async(args:any)=>({view:args.view,token:args.token,epoch:'timeout-page',detached:false,disposition:'superseded',replacementToken:'never-registered'}));
 const native=bridge(request);client.native=native;registerNativeLease('registration-timeout','timeout-old',native,'timeout-page');
 const pending=retireNativeLease('registration-timeout','timeout-old');const rejection=expect(pending).rejects.toThrow('Native retirement replacement was not confirmed');
 await vi.advanceTimersByTimeAsync(1000);await rejection;expect(request).toHaveBeenCalledOnce();expect(notice).toHaveBeenCalledOnce();expect(count).not.toHaveBeenCalledWith(false);
 request.mockImplementation(async(args:any)=>({view:args.view,token:args.token,epoch:'timeout-page',detached:true,disposition:'current'}));await retireNativeLease('registration-timeout','timeout-old');window.removeEventListener('termdock:native-cleanup-error',notice);vi.useRealTimers();
});
it('a late replacement from another page epoch cannot complete the old retirement',async()=>{
 let done!:(value:unknown)=>void;
 const request=vi.fn(async(args:any)=>args.token==='epoch-old'?await new Promise(resolve=>{done=resolve;}):({view:args.view,token:args.token,epoch:'new-page',detached:true,disposition:'current'}));
 const native=bridge(request);client.native=native;registerNativeLease('registration-epoch','epoch-old',native,'old-page');
 const pending=retireNativeLease('registration-epoch','epoch-old');void pending.catch(()=>{});
 done({view:'registration-epoch',token:'epoch-old',epoch:'old-page',detached:false,disposition:'superseded',replacementToken:'epoch-new'});
 await Promise.resolve();registerNativeLease('registration-epoch','epoch-new',native,'new-page');
 await expect(pending).rejects.toThrow('Native retirement replacement was not confirmed');await retireNativeLease('registration-epoch','epoch-new');
});
it('same-target bridge replacement cannot approve an old bridge handoff',async()=>{
 let done!:(value:unknown)=>void;
 const request=vi.fn(async(args:any)=>args.token==='bridge-old'?await new Promise(resolve=>{done=resolve;}):({view:args.view,token:args.token,epoch:'bridge-page',detached:true,disposition:'current'}));
 const native=bridge(request);client.native=native;registerNativeLease('registration-bridge','bridge-old',native,'bridge-page');
 const pending=retireNativeLease('registration-bridge','bridge-old');void pending.catch(()=>{});
 registerNativeLease('registration-bridge','bridge-new',native,'bridge-page');client.native=bridge(vi.fn());
 done({view:'registration-bridge',token:'bridge-old',epoch:'bridge-page',detached:false,disposition:'superseded',replacementToken:'bridge-new'});
 await expect(pending).rejects.toThrow('Native retirement replacement was not confirmed');client.native=native;await retireNativeLease('registration-bridge','bridge-new');
});
it('unmount hide cancels a pending registration listener without dropping a replacement or leaving a timer',async()=>{
 vi.useFakeTimers();const count=vi.fn(),notice=vi.fn();window.termdockPreviewLifecycle={nativePanels:count} as any;window.addEventListener('termdock:native-cleanup-error',notice);
 const request=vi.fn(async(args:any)=>{if(args.action==='visible')throw Error('old surface already replaced');return{view:args.view,token:args.token,epoch:'unmount-page',detached:false,disposition:'superseded',replacementToken:'unmount-new'};});
 const native=bridge(request);client.native=native;registerNativeLease('registration-unmount','unmount-old',native,'unmount-page');
 const pending=retireNativeLease('registration-unmount','unmount-old');await Promise.resolve();await Promise.resolve();
 await hideNativeLease('registration-unmount','unmount-old');await expect(pending).resolves.toBe('not-current');expect(vi.getTimerCount()).toBe(0);expect(count).not.toHaveBeenCalledWith(false);expect(notice).not.toHaveBeenCalled();
 registerNativeLease('registration-unmount','unmount-new',native,'unmount-page');request.mockImplementation(async(args:any)=>({view:args.view,token:args.token,epoch:'unmount-page',detached:true,disposition:'current'}));await retireNativeLease('registration-unmount','unmount-new');window.removeEventListener('termdock:native-cleanup-error',notice);vi.useRealTimers();
});
it('hide before the host retirement receipt cancels only that pending attempt and never creates a later wait',async()=>{
 vi.useFakeTimers();let done!:(value:unknown)=>void;
 const request=vi.fn(async(args:any)=>args.action==='visible'?{visible:false}:await new Promise(resolve=>{done=resolve;}));const native=bridge(request);client.native=native;
 registerNativeLease('unmount-before-receipt','before-old',native,'before-page');const pending=retireNativeLease('unmount-before-receipt','before-old');
 await hideNativeLease('unmount-before-receipt','before-old');
 done({view:'unmount-before-receipt',token:'before-old',epoch:'before-page',detached:false,disposition:'superseded',replacementToken:'before-new'});
 await expect(pending).resolves.toBe('not-current');expect(vi.getTimerCount()).toBe(0);
 registerNativeLease('unmount-before-receipt','before-new',native,'before-page');request.mockImplementation(async(args:any)=>({view:args.view,token:args.token,epoch:'before-page',detached:true,disposition:'current'}));await retireNativeLease('unmount-before-receipt','before-new');vi.useRealTimers();
});

it('accepts an inactive replacement only with its exact same-page host hide receipt',async()=>{
 let done!:(value:unknown)=>void;
 const request=vi.fn(async(args:any)=>args.action==='visible'?{visible:false,epoch:'confirmed-hidden-page'}:args.token==='confirmed-old'?await new Promise(resolve=>{done=resolve;}):({detached:true,view:args.view,token:args.token,disposition:'current',epoch:'confirmed-hidden-page'}));
 const native=bridge(request);client.native=native;registerNativeLease('confirmed-hidden','confirmed-old',native,'confirmed-hidden-page');
 const pending=retireNativeLease('confirmed-hidden','confirmed-old');
 registerNativeLease('confirmed-hidden','confirmed-new',native,'confirmed-hidden-page');await hideNativeLease('confirmed-hidden','confirmed-new');
 done({view:'confirmed-hidden',token:'confirmed-old',epoch:'confirmed-hidden-page',detached:false,disposition:'superseded',replacementToken:'confirmed-new'});
 await expect(pending).resolves.toBe('superseded');await retireNativeLease('confirmed-hidden','confirmed-new');
});

it('a show intent invalidates prior hidden replacement proof before the host can show it',async()=>{
 let done!:(value:unknown)=>void;
 const request=vi.fn(async(args:any)=>args.action==='visible'?{visible:false,epoch:'show-page'}:args.token==='show-old'?await new Promise(resolve=>{done=resolve;}):({detached:true,view:args.view,token:args.token,disposition:'current',epoch:'show-page'}));
 const native=bridge(request);client.native=native;registerNativeLease('show-again','show-old',native,'show-page');const pending=retireNativeLease('show-again','show-old');
 registerNativeLease('show-again','show-new',native,'show-page');await hideNativeLease('show-again','show-new');invalidateNativeHiddenReceipt('show-again','show-new');
 done({view:'show-again',token:'show-old',epoch:'show-page',detached:false,disposition:'superseded',replacementToken:'show-new'});
 await expect(pending).rejects.toThrow('Native retirement replacement was not confirmed');await retireNativeLease('show-again','show-new');
});
it('a delayed hide receipt cannot restore hidden proof or release a guard after a new show intent',async()=>{
 let hidden!:(value:unknown)=>void,retired!:(value:unknown)=>void;
 const request=vi.fn(async(args:any)=>args.action==='visible'?await new Promise(resolve=>{hidden=resolve;}):args.token==='late-hide-old'?await new Promise(resolve=>{retired=resolve;}):({detached:true,view:args.view,token:args.token,disposition:'current',epoch:'late-hide-page'}));
 const count=vi.fn();window.termdockPreviewLifecycle={nativePanels:count} as any;const native=bridge(request);client.native=native;
 registerNativeLease('late-hide','late-hide-old',native,'late-hide-page');const pending=retireNativeLease('late-hide','late-hide-old');registerNativeLease('late-hide','late-hide-new',native,'late-hide-page');
 const hide=hideNativeLease('late-hide','late-hide-new');invalidateNativeHiddenReceipt('late-hide','late-hide-new');hidden({visible:false,epoch:'late-hide-page'});await hide;
 expect(count).not.toHaveBeenCalledWith(false);
 retired({view:'late-hide',token:'late-hide-old',epoch:'late-hide-page',detached:false,disposition:'superseded',replacementToken:'late-hide-new'});await expect(pending).resolves.toBe('superseded');
 // A current guard, rather than the stale hide, authorizes this handoff.
 await retireNativeLease('late-hide','late-hide-new');
});

it('clears an old cleanup failure only after the exact same-page replacement becomes ready',async()=>{
 vi.useFakeTimers();const failed=vi.fn(),resolved=vi.fn();
 window.addEventListener('termdock:native-cleanup-error',failed);window.addEventListener('termdock:native-cleanup-resolved',resolved);
 const request=vi.fn(async(args:any)=>({view:args.view,token:args.token,epoch:'recovery-page',detached:false,disposition:'superseded',replacementToken:'replacement'}));
 const native=bridge(request);client.native=native;registerNativeLease('recover-ready','old',native,'recovery-page');
 const pending=retireNativeLease('recover-ready','old');const rejected=expect(pending).rejects.toThrow(/replacement was not confirmed/);
 await vi.advanceTimersByTimeAsync(1000);await rejected;const id=failed.mock.calls.at(-1)![0].detail.recoveryId;
 registerNativeLease('recover-ready','replacement',native,'recovery-page');expect(resolved).not.toHaveBeenCalled();
 markNativeRendererReady('recover-ready','old',true);expect(resolved).not.toHaveBeenCalled();
 markNativeRendererReady('recover-ready','replacement',true);expect(resolved.mock.calls[0][0].detail.recoveryIds).toContain(id);
 request.mockImplementation(async(args:any)=>({view:args.view,token:args.token,epoch:'recovery-page',detached:true,disposition:'current'}));await retireNativeLease('recover-ready','replacement');
 window.removeEventListener('termdock:native-cleanup-error',failed);window.removeEventListener('termdock:native-cleanup-resolved',resolved);vi.useRealTimers();
});
