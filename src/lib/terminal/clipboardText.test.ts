// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({bridge:undefined as any,read:vi.fn()}));
vi.mock('../desktop/nativeBridge',()=>({getTermdockDesktopBridge:()=>state.bridge}));
vi.mock('./api',()=>({sendTmuxAction:state.read}));
import {writeTerminalClipboardText,copyTmuxTerminalSelection} from './clipboardText';
afterEach(()=>{state.bridge=undefined;state.read.mockReset();vi.restoreAllMocks();});
it('desktop copy writes on the client even when WebKit denies clipboard access',async()=>{
 const web=vi.fn(async()=>{throw Error('gesture denied');}),writeClipboardText=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:web}});state.bridge={writeClipboardText};
 expect(await writeTerminalClipboardText('中文 remote text')).toBe(true);expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('中文 remote text');expect(web).not.toHaveBeenCalled();
});
it('browser copy falls back to an explicit copy event and restores the input focus',async()=>{
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn(async()=>{throw Error('denied');})}});const copy=vi.fn(()=>true);Object.defineProperty(document,'execCommand',{configurable:true,value:copy});const input=document.createElement('input');document.body.append(input);input.focus();
 expect(await writeTerminalClipboardText('selected')).toBe(true);expect(copy).toHaveBeenCalledWith('copy');expect(document.activeElement).toBe(input);expect(document.querySelector('textarea')).toBeNull();input.remove();
});
it('remote tmux copy uses only the explicit selected pane result and local clipboard',async()=>{
 const text='remote 中文';state.read.mockResolvedValue({success:true,selection:{status:'copied',text,bytes:new TextEncoder().encode(text).length,paneId:'%2'}});const writeClipboardText=vi.fn(async()=>{});state.bridge={writeClipboardText};
 expect(await copyTmuxTerminalSelection('remote-backend',()=>true)).toBe(true);expect(state.read).toHaveBeenCalledExactlyOnceWith('remote-backend',{action:'copy-selection'});expect(writeClipboardText).toHaveBeenCalledWith(text);
});
it('a late tmux result after target/session switch cannot overwrite the clipboard',async()=>{
 let resolve!:(v:unknown)=>void;state.read.mockReturnValue(new Promise(r=>resolve=r));let current=true;const writeClipboardText=vi.fn();state.bridge={writeClipboardText};const result=copyTmuxTerminalSelection('old',()=>current);current=false;resolve({success:true,selection:{status:'copied',text:'old',bytes:3,paneId:'%2'}});expect(await result).toBe(false);expect(writeClipboardText).not.toHaveBeenCalled();
});
it('invalid selection metadata and empty selections preserve clipboard contents',async()=>{
 const writeClipboardText=vi.fn();state.bridge={writeClipboardText};state.read.mockResolvedValueOnce({success:true,selection:{status:'copied',text:'x',bytes:99,paneId:'%2'}});await expect(copyTmuxTerminalSelection('x',()=>true)).rejects.toThrow();state.read.mockResolvedValueOnce({success:true,selection:{status:'empty',text:'',bytes:0,paneId:'%2'}});expect(await copyTmuxTerminalSelection('x',()=>true)).toBe(false);expect(writeClipboardText).not.toHaveBeenCalled();
});

it('desktop copy failure preserves clipboard and never silently uses a second writer',async()=>{
 const web=vi.fn();Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:web}});state.bridge={writeClipboardText:vi.fn(async()=>{throw Error('unavailable');})};expect(await writeTerminalClipboardText('selection')).toBe(false);expect(web).not.toHaveBeenCalled();
});
