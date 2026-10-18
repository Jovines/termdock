// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {deleteFile,resetCsrfTokenCache} from './api';
beforeEach(()=>resetCsrfTokenCache());afterEach(()=>vi.unstubAllGlobals());
it('stale confirmation never reads CSRF or deletes a file',async()=>{const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(deleteFile('/controlled/file',()=>false)).rejects.toThrow('context');expect(fetch).not.toHaveBeenCalled();});
it('target change during actual CSRF wait never issues DELETE',async()=>{
 let finish!:(value:Response)=>void,current=true;const fetch=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetch);const request=deleteFile('/controlled/file',()=>current);current=false;finish(Response.json({csrfToken:'controlled'}));await expect(request).rejects.toThrow('context');expect(fetch).toHaveBeenCalledTimes(1);
});
it('explicit current confirmation uses only the existing page DELETE with CSRF and reports failure',async()=>{
 const fetch=vi.fn(async(url:string)=>url==='/api/csrf-token'?Response.json({csrfToken:'controlled'}):Response.json({error:'Controlled delete failure'},{status:503}));vi.stubGlobal('fetch',fetch);await expect(deleteFile('/controlled/file',()=>true)).rejects.toThrow('Controlled delete failure');expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[1]).toEqual(['/api/terminal/fs/file?path=%2Fcontrolled%2Ffile&confirm=true',{method:'DELETE',headers:{'X-XSRF-TOKEN':'controlled'},signal:expect.any(AbortSignal)}]);
});
