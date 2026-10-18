// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {runServiceUpdateConfirmation} from './App';

const result={status:'restarting' as const,currentVersion:'1',latestVersion:'2',source:'official' as const,checkedAt:1,error:null};
function action(confirm:()=>boolean|Promise<boolean>){return{confirm,current:vi.fn(()=>true),submit:vi.fn(async()=>result),apply:vi.fn(),pending:vi.fn(),failure:vi.fn(),expiredMessage:'Expired'};}
describe('actual App service update confirmation runner',()=>{
 it('cancel never submits and synchronous busy ownership prevents double clicks while confirmation is open',async()=>{
  let answer!:(value:boolean)=>void;const a=action(()=>new Promise(resolve=>{answer=resolve;})),lock={busy:false};const first=runServiceUpdateConfirmation(lock,a);await runServiceUpdateConfirmation(lock,a);expect(a.pending.mock.calls).toEqual([[true]]);answer(false);await first;expect(a.submit).not.toHaveBeenCalled();expect(lock.busy).toBe(false);expect(a.pending.mock.calls).toEqual([[true],[false]]);
 });
 it('requires the captured service/page after asynchronous confirmation and ignores late results from an old context',async()=>{
  const a=action(()=>true);a.current.mockReturnValue(false);await runServiceUpdateConfirmation({busy:false},a);expect(a.submit).not.toHaveBeenCalled();
  let finish!:(value:typeof result)=>void;const b=action(()=>true);b.submit.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));const pending=runServiceUpdateConfirmation({busy:false},b);await Promise.resolve();b.current.mockReturnValue(false);finish(result);await pending;expect(b.apply).not.toHaveBeenCalled();expect(b.failure).not.toHaveBeenCalled();
 });
 it('passes the live scope guard to the page API and reports a real failure without automatically retrying',async()=>{
  const a=action(()=>true);a.submit.mockRejectedValue(new Error('Controlled restart failure'));const lock={busy:false};await runServiceUpdateConfirmation(lock,a);expect(a.submit).toHaveBeenCalledExactlyOnceWith(a.current);expect(a.failure).toHaveBeenCalledExactlyOnceWith('Controlled restart failure');expect(a.apply).not.toHaveBeenCalled();expect(lock.busy).toBe(false);
 });
});
