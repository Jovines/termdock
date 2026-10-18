// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {confirmPageAction,showPageFeedback,runConfirmedPageAction} from './pageFeedback';
afterEach(()=>{delete window.termdockDesktop;vi.restoreAllMocks();});
const options={title:'Controlled',message:'Confirm owned action',confirmLabel:'Confirm',cancelLabel:'Cancel'};
it('only explicit page-v1 uses async confirmation; legacy browser/Electron retain synchronous confirm and alert',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false),alert=vi.spyOn(window,'alert').mockImplementation(()=>{}),native=vi.fn(async()=>true);
 window.termdockDesktop={platform:'darwin',confirm:native} as any;expect(await confirmPageAction(options)).toBe(false);expect(native).not.toHaveBeenCalled();showPageFeedback('legacy');expect(alert).toHaveBeenCalledWith('legacy');
 const pageAlert=vi.fn();window.termdockDesktop={platform:'darwin',confirmationUI:'page-v1',confirm:native,alert:pageAlert} as any;expect(await confirmPageAction(options)).toBe(true);showPageFeedback('visible');expect(pageAlert).toHaveBeenCalledWith('visible');expect(confirm).toHaveBeenCalledTimes(1);
});
it('one async approval cannot double-submit or apply a response in a new page/target',async()=>{
 let answer!:(value:boolean)=>void,current=true,finish!:(value:string)=>void;const lock={busy:false},submit=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;})),apply=vi.fn(),pending=vi.fn(),failure=vi.fn();
 const action={confirm:()=>new Promise<boolean>(resolve=>{answer=resolve;}),current:()=>current,submit,apply,pending,failure,expiredMessage:'changed'};
 const run=runConfirmedPageAction(lock,action);await runConfirmedPageAction(lock,action);answer(true);await Promise.resolve();expect(submit).toHaveBeenCalledTimes(1);current=false;finish('old');await run;expect(apply).not.toHaveBeenCalled();expect(failure).not.toHaveBeenCalled();expect(lock.busy).toBe(false);
});
