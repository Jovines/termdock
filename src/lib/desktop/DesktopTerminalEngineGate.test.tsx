// @vitest-environment jsdom
import React from 'react';
import { act,cleanup,render,screen } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
vi.mock('../components/StartupScreen',()=>({StartupScreen:({status}:{status:string})=><div role="status">{status}</div>}));
import { DesktopTerminalEngineGate } from './DesktopTerminalEngineGate';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function deferred(){let resolve!:(value:unknown)=>void,reject!:(reason:unknown)=>void;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return{promise,resolve,reject};}
it('mounts the real child only after detach negotiation and supports old browser/Electron without the capability',async()=>{
 const mounts=vi.fn();function Renderer(){React.useEffect(mounts,[]);return <div>renderer</div>;}
 const ready=deferred();const view=render(<DesktopTerminalEngineGate ready={ready.promise}><Renderer/></DesktopTerminalEngineGate>);
 expect(screen.queryByText('renderer')).toBeNull();expect(mounts).not.toHaveBeenCalled();
 await act(async()=>{ready.resolve({detached:true});});expect(mounts).toHaveBeenCalledTimes(1);view.unmount();
 render(<DesktopTerminalEngineGate><Renderer/></DesktopTerminalEngineGate>);expect(mounts).toHaveBeenCalledTimes(2);
});
it('a rejected or superseded negotiation never mounts a replacement renderer',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});const old=deferred(),current=deferred(),mounts=vi.fn();
 function Renderer(){React.useEffect(mounts,[]);return <div>renderer</div>;}
 const ui=(ready:Promise<unknown>)=><DesktopTerminalEngineGate ready={ready}><Renderer/></DesktopTerminalEngineGate>;
 const view=render(ui(old.promise));view.rerender(ui(current.promise));
 await act(async()=>{old.resolve({detached:true});});expect(mounts).not.toHaveBeenCalled();
 await act(async()=>{current.reject(Error('old surface remained'));});expect(mounts).not.toHaveBeenCalled();expect(screen.getByRole('status').textContent).toContain('无法完成');
});
