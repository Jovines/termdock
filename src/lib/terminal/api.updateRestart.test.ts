// @vitest-environment jsdom
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {confirmTermdockUpdateRestart,resetCsrfTokenCache} from './api';
beforeEach(()=>resetCsrfTokenCache());
afterEach(()=>vi.unstubAllGlobals());
describe('actual service restart API confirmation scope',()=>{
 it('does not request CSRF or restart after the confirmation context is already stale',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(confirmTermdockUpdateRestart(()=>false)).rejects.toThrow('expired');expect(fetch).not.toHaveBeenCalled();
 });
 it('does not POST if the target changes while CSRF is being read',async()=>{
  let resolve!:(value:Response)=>void,current=true;const fetch=vi.fn((_url:string)=>new Promise<Response>(done=>{resolve=done;}));vi.stubGlobal('fetch',fetch);const pending=confirmTermdockUpdateRestart(()=>current);current=false;resolve(Response.json({csrfToken:'controlled'}));await expect(pending).rejects.toThrow('expired');expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][0]).toBe('/api/csrf-token');
 });
 it('only confirms through the existing page POST with CSRF and propagates visible failure text',async()=>{
  const fetch=vi.fn(async(url:string)=>url==='/api/csrf-token'?Response.json({csrfToken:'controlled'}):Response.json({error:'Controlled failure'},{status:503}));vi.stubGlobal('fetch',fetch);await expect(confirmTermdockUpdateRestart(()=>true)).rejects.toThrow('Controlled failure');expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[1]).toEqual(['/api/terminal/update/restart',{method:'POST',headers:{'X-XSRF-TOKEN':'controlled'}}]);
 });
});
