// @vitest-environment jsdom
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {confirmTermdockUpdateRestart,resetCsrfTokenCache} from './api';
const state = {status:'current',currentVersion:'1.4.351',latestVersion:'1.4.351',source:'official',checkedAt:1,error:null};
beforeEach(()=>resetCsrfTokenCache());
afterEach(()=>vi.unstubAllGlobals());
describe('actual service restart API confirmation scope',()=>{
 it('sends the exact confirmed version and reconciles a consumed update without another POST',async()=>{
  const fetch=vi.fn(async(url:string)=>url==='/api/csrf-token'?Response.json({csrfToken:'controlled'}):Response.json({code:'UPDATE_STATE_CHANGED',state},{status:409}));vi.stubGlobal('fetch',fetch);
  await expect(confirmTermdockUpdateRestart(()=>true,'1.4.351')).resolves.toEqual(state);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]).toEqual(['/api/terminal/update/restart',{method:'POST',headers:{'X-XSRF-TOKEN':'controlled','Content-Type':'application/json'},body:JSON.stringify({version:'1.4.351'})}]);
 });
 it('reads the actual state from an older service on conflict without retrying restart',async()=>{
  const fetch=vi.fn(async(url:string)=>url==='/api/csrf-token'?Response.json({csrfToken:'controlled'}):url==='/api/terminal/update'?Response.json(state):Response.json({error:'No installed Termdock update is waiting for restart.'},{status:409}));vi.stubGlobal('fetch',fetch);
  await expect(confirmTermdockUpdateRestart(()=>true,'1.4.351')).resolves.toEqual(state);
  expect(fetch.mock.calls.map(call=>call[0])).toEqual(['/api/csrf-token','/api/terminal/update/restart','/api/terminal/update']);
 });
 it('reconciles a different pending version and requires a fresh confirmation instead of restarting it',async()=>{
  const next={...state,status:'ready',currentVersion:'1.4.350',latestVersion:'1.4.352'};
  const fetch=vi.fn(async(url:string)=>url==='/api/csrf-token'?Response.json({csrfToken:'controlled'}):Response.json({code:'UPDATE_STATE_CHANGED',state:next},{status:409}));vi.stubGlobal('fetch',fetch);
  await expect(confirmTermdockUpdateRestart(()=>true,'1.4.351')).resolves.toEqual(next);
  expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('keeps actual installation errors visible when a ready reminder has become invalid',async()=>{
  const fetch=vi.fn(async(url:string)=>url==='/api/csrf-token'?Response.json({csrfToken:'controlled'}):Response.json({code:'UPDATE_STATE_CHANGED',error:'No installed update',state:{...state,status:'error',error:'Installation verification failed'}},{status:409}));vi.stubGlobal('fetch',fetch);
  await expect(confirmTermdockUpdateRestart(()=>true,'1.4.351')).rejects.toThrow('Installation verification failed');
  expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('does not hide a real install failure or a failed reconciliation from an older service',async()=>{
  const fetch=vi.fn(async(url:string)=>url==='/api/csrf-token'?Response.json({csrfToken:'controlled'}):url==='/api/terminal/update'?Response.json({...state,status:'error',error:'Installation incomplete'}):Response.json({error:'Installation incomplete'},{status:409}));vi.stubGlobal('fetch',fetch);
  await expect(confirmTermdockUpdateRestart(()=>true,'1.4.351')).rejects.toThrow('Installation incomplete');
  fetch.mockImplementation(async(url:string)=>url==='/api/csrf-token'?Response.json({csrfToken:'controlled'}):url==='/api/terminal/update'?Promise.reject(new Error('offline')):Response.json({error:'Restart failed'},{status:409}));
  await expect(confirmTermdockUpdateRestart(()=>true,'1.4.351')).rejects.toThrow('Restart failed');
 });
 it('cannot apply a legacy conflict snapshot if the service changes during its read',async()=>{
  let resolve!:(response:Response)=>void,current=true;
  const fetch=vi.fn(async(url:string)=>url==='/api/csrf-token'?Response.json({csrfToken:'controlled'}):url==='/api/terminal/update'?new Promise<Response>(done=>{resolve=done;}):Response.json({error:'stale'},{status:409}));vi.stubGlobal('fetch',fetch);
  const pending=confirmTermdockUpdateRestart(()=>current,'1.4.351');
  await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
  current=false;resolve(Response.json(state));
  await expect(pending).rejects.toThrow('expired');
 });
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
