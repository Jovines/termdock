// @vitest-environment jsdom
import {act,cleanup,render} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {RendererPreferenceNotice,RendererPreferenceControls} from './App';
const current=vi.hoisted(()=>({native:null as any}));
vi.mock('./lib/desktop/nativeBridge',async original=>({...await original<any>(),getTermdockDesktopBridge:()=>current.native?{nativeTerminal:current.native}:null}));
import {registerNativeLease,markNativeRendererReady,retireNativeLease} from './lib/terminal/nativeLifetime';
afterEach(()=>{cleanup();current.native=null;});
it('renderer preference scope is explicit and does not claim static native capability is the active engine',()=>{
 const view=render(<RendererPreferenceNotice locale="en"/>);expect(view.container.textContent).toContain('browser and fallback');expect(view.container.textContent).toContain('native terminals use Ghostty');expect(view.container.querySelector('[data-terminal-renderer-scope]')?.getAttribute('data-terminal-renderer-scope')).toBe('browser-fallback');view.rerender(<RendererPreferenceNotice locale="zh"/>);expect(view.container.textContent).toContain('浏览器和后备终端');
});

it('settings hide renderer options only after selected native layout is ready and restore them on fallback/session change',async()=>{
 const native={available:true,request:vi.fn(async(args:any)=>({view:args.view,token:args.token,detached:true,disposition:'current'})),subscribe:()=>()=>{}};current.native=native;
 const view=render(<RendererPreferenceControls sessionId="a"><button>WebGL</button></RendererPreferenceControls>);
 act(()=>registerNativeLease('terminal::a','one',native));expect(view.queryByText('WebGL')).not.toBeNull();
 act(()=>markNativeRendererReady('terminal::a','one',true));expect(view.queryByText('WebGL')).toBeNull();
 view.rerender(<RendererPreferenceControls sessionId="b"><button>WebGL</button></RendererPreferenceControls>);expect(view.queryByText('WebGL')).not.toBeNull();
 view.rerender(<RendererPreferenceControls sessionId="a"><button>WebGL</button></RendererPreferenceControls>);expect(view.queryByText('WebGL')).toBeNull();
 act(()=>markNativeRendererReady('terminal::a','one',false));expect(view.queryByText('WebGL')).not.toBeNull();
 await act(async()=>{await retireNativeLease('terminal::a','one');});
});
