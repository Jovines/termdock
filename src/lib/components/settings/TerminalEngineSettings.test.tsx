// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({bridge:undefined as any}));
vi.mock('../../desktop/nativeBridge',()=>({getTermdockDesktopBridge:()=>mock.bridge}));
import {TerminalEngineSettings} from './TerminalEngineSettings';
const state={selected:'web',active:'web',nativeSupported:true,epoch:'page-one'};
it('shows Web rendering controls only while Web is selected and preserves their preference',async()=>{
 mock.bridge={terminalEngine:{getState:vi.fn(async()=>({...state,selected:'native',active:'native'})),set:vi.fn()}};
 render(<TerminalEngineSettings locale="zh"><div data-testid="web-renderer">WebGL</div></TerminalEngineSettings>);
 await waitFor(()=>expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('native'));
 expect(screen.queryByTestId('web-renderer')).toBeNull();
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'web'}});
 expect(screen.getByTestId('web-renderer').textContent).toBe('WebGL');
 expect(mock.bridge.terminalEngine.set).not.toHaveBeenCalled();
});
beforeEach(()=>{mock.bridge={terminalEngine:{getState:vi.fn(async()=>({...state})),set:vi.fn()}};});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('exposes user Web/native choices and reloads only after the host saves the same-page preference',async()=>{
 const reload=vi.fn();let finish!:(value:any)=>void;mock.bridge.terminalEngine.set.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 render(<TerminalEngineSettings locale="zh" onReload={reload}/>);
 const select=await screen.findByRole('combobox');await waitFor(()=>expect((select as HTMLSelectElement).disabled).toBe(false));
 expect((select as HTMLSelectElement).value).toBe('web');fireEvent.change(select,{target:{value:'native'}});
 fireEvent.click(screen.getByRole('button'));expect(mock.bridge.terminalEngine.set).toHaveBeenCalledWith('native');expect(reload).not.toHaveBeenCalled();
 await act(async()=>{finish({...state,selected:'native'});});expect(reload).toHaveBeenCalledTimes(1);
});
for(const scenario of ['reject','stale','unmount'] as const)it(`does not reload on ${scenario} switch completion`,async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});const reload=vi.fn();let resolve!:(value:any)=>void,reject!:(value:any)=>void;
 mock.bridge.terminalEngine.getState.mockResolvedValue({...state,active:'native',selected:'native'});
 mock.bridge.terminalEngine.set.mockImplementation(()=>new Promise((yes,no)=>{resolve=yes;reject=no;}));
 const view=render(<TerminalEngineSettings locale="en" onReload={reload}/>);const select=screen.getByRole('combobox');await waitFor(()=>expect((select as HTMLSelectElement).disabled).toBe(false));
 fireEvent.change(select,{target:{value:'web'}});fireEvent.click(screen.getByRole('button'));if(scenario==='unmount')view.unmount();
 await act(async()=>{if(scenario==='reject')reject(Error('disk failed'));else resolve({...state,epoch:scenario==='stale'?'page-two':state.epoch});});
 expect(reload).not.toHaveBeenCalled();if(scenario!=='unmount')expect(screen.getByRole('alert')).toBeTruthy();
});
it('omits the setting on older shells and disables unsupported native selection',async()=>{
 mock.bridge=undefined;const view=render(<TerminalEngineSettings locale="en"/>);expect(screen.queryByRole('combobox')).toBeNull();view.unmount();
 mock.bridge={terminalEngine:{getState:vi.fn(async()=>({...state,nativeSupported:false})),set:vi.fn()}};render(<TerminalEngineSettings locale="en"/>);
 await waitFor(()=>expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false));expect((screen.getByRole('option',{name:'Native (experimental)'}) as HTMLOptionElement).disabled).toBe(true);
});

it('requires verified service identity, then offers a reload without enabling Native in the current page',async()=>{
 const reload=vi.fn();mock.bridge.terminalEngine.getState.mockResolvedValue({...state,selected:'native',targetVerified:false});
 mock.bridge.terminalEngine.set.mockResolvedValue({...state,selected:'native',targetVerified:true});
 render(<TerminalEngineSettings locale="zh" onReload={reload}/>);
 await waitFor(()=>expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('native'));
 expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('status').textContent).toContain('完成此服务的身份验证');
 fireEvent.click(screen.getByRole('button'));expect(mock.bridge.terminalEngine.set).not.toHaveBeenCalled();
 mock.bridge.terminalEngine.getState.mockResolvedValue({...state,selected:'native',targetVerified:true});
 act(()=>window.dispatchEvent(new Event('termdock:terminal-engine-availability')));
 await waitFor(()=>expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
 expect(screen.getByRole('status').textContent).toContain('当前引擎：Web');expect(reload).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button'));await waitFor(()=>expect(reload).toHaveBeenCalledTimes(1));
});

it('accepts availability refresh after an apply failure in the same mounted settings',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});const reload=vi.fn();
 mock.bridge.terminalEngine.getState.mockResolvedValue({...state,selected:'native',targetVerified:true});
 mock.bridge.terminalEngine.set.mockRejectedValue(Error('save failed'));
 render(<TerminalEngineSettings locale="zh" onReload={reload}/>);
 await waitFor(()=>expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button'));await screen.findByRole('alert');
 mock.bridge.terminalEngine.getState.mockResolvedValue({...state,selected:'native',targetVerified:false});
 act(()=>window.dispatchEvent(new Event('termdock:terminal-engine-availability')));
 await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('完成此服务的身份验证'));
 expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);expect(reload).not.toHaveBeenCalled();
 mock.bridge.terminalEngine.getState.mockResolvedValue({...state,selected:'native',targetVerified:true});
 act(()=>window.dispatchEvent(new Event('termdock:terminal-engine-availability')));
 await waitFor(()=>expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false));expect(reload).not.toHaveBeenCalled();
});

it('does not reload for an apply superseded by a newer availability snapshot',async()=>{
 const reload=vi.fn();let finish!:(value:any)=>void;
 mock.bridge.terminalEngine.getState.mockResolvedValue({...state,selected:'native',targetVerified:true});
 mock.bridge.terminalEngine.set.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const view=render(<TerminalEngineSettings locale="en" onReload={reload}/>);
 await waitFor(()=>expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button'));
 mock.bridge.terminalEngine.getState.mockResolvedValue({...state,selected:'native',targetVerified:false});
 act(()=>window.dispatchEvent(new Event('termdock:terminal-engine-availability')));
 await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('Complete verification'));
 await act(async()=>finish({...state,selected:'native',targetVerified:true}));
 expect(reload).not.toHaveBeenCalled();expect(screen.getByRole('status').textContent).toContain('Complete verification');
 view.unmount();act(()=>window.dispatchEvent(new Event('termdock:terminal-engine-availability')));
 expect(mock.bridge.terminalEngine.getState).toHaveBeenCalledTimes(2);
});

for(const outcome of ['resolve','reject'] as const)it(`ignores old availability ${outcome} after Apply starts`,async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});const reload=vi.fn();let finishApply!:(value:any)=>void,finishRead!:(value:any)=>void,failRead!:(value:any)=>void;
 mock.bridge.terminalEngine.getState.mockResolvedValueOnce({...state,selected:'native',targetVerified:true}).mockImplementationOnce(()=>new Promise((resolve,reject)=>{finishRead=resolve;failRead=reject;}));
 mock.bridge.terminalEngine.set.mockImplementation(()=>new Promise(resolve=>{finishApply=resolve;}));
 render(<TerminalEngineSettings locale="en" onReload={reload}/>);
 await waitFor(()=>expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
 act(()=>window.dispatchEvent(new Event('termdock:terminal-engine-availability')));
 fireEvent.click(screen.getByRole('button'));
 await act(async()=>{if(outcome==='resolve')finishRead({...state,selected:'web',targetVerified:false});else failRead(Error('old read failed'));});
 expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('native');expect(screen.queryByRole('alert')).toBeNull();expect(reload).not.toHaveBeenCalled();
 await act(async()=>finishApply({...state,selected:'native',targetVerified:true}));expect(reload).toHaveBeenCalledTimes(1);
});
