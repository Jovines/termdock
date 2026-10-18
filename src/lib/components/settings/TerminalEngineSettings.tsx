import React from 'react';
import { getTermdockDesktopBridge, type TerminalEngine, type TerminalEngineState } from '../../desktop/nativeBridge';

/** Local Preview preference only; it never changes the service/PTY settings. */
export function TerminalEngineSettings({locale,onReload=()=>window.location.reload(),children}:{locale:string;onReload?:()=>void;children?:React.ReactNode}) {
  const api=getTermdockDesktopBridge()?.terminalEngine;
  const [state,setState]=React.useState<TerminalEngineState|null>(null);
  const [choice,setChoice]=React.useState<TerminalEngine>('web');
  const [busy,setBusy]=React.useState(false),[error,setError]=React.useState(false);
  const version=React.useRef(0),lifecycle=React.useRef(0),mounted=React.useRef(false);
  React.useEffect(()=>{
    mounted.current=true;const current=++lifecycle.current;
    let request=0;
    const refresh=()=>{const id=++request,operation=++version.current;if(api)void api.getState().then(value=>{if(mounted.current&&lifecycle.current===current&&id===request&&version.current===operation){setState(value);setChoice(value.selected);setBusy(false);}},reason=>{console.error('Cannot read terminal engine preference',reason);if(mounted.current&&lifecycle.current===current&&id===request&&version.current===operation){setError(true);setBusy(false);}});};
    refresh();window.addEventListener('termdock:terminal-engine-availability',refresh);
    return ()=>{mounted.current=false;lifecycle.current++;version.current++;window.removeEventListener('termdock:terminal-engine-availability',refresh);};
  },[api]);
  if(!api)return <>{children}</>;
  const zh=locale==='zh';
  const apply=async()=>{
    if(!state||busy||(choice==='native'&&state.targetVerified===false))return;const current=++version.current;setBusy(true);setError(false);
    try{
      const result=await api.set(choice);
      if(!mounted.current||version.current!==current)return;
      if(result.epoch!==state.epoch)throw new Error('Terminal engine page changed');
      // Reload only this document. The next bootstrap confirms old native
      // detach before mounting; server sessions are never closed or recreated.
      onReload();
    }catch(reason){console.error('Cannot change terminal engine',reason);if(mounted.current&&version.current===current){setError(true);setBusy(false);}}
  };
  return <><fieldset aria-label={zh?'终端引擎':'Terminal engine'} className="min-w-0 space-y-2 rounded-xl bg-surface-2 px-2.5 py-2" disabled={busy}>
    <div className="flex min-w-0 items-center gap-2">
    <span className="w-14 shrink-0 text-[12px] font-medium text-foreground/90">{zh?'终端引擎':'Terminal engine'}</span>
    <select aria-label={zh?'终端引擎':'Terminal engine'} className="min-h-8 min-w-0 flex-1 rounded-md border-0 bg-surface px-2 py-1 text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" value={choice} disabled={!state||busy} onChange={event=>setChoice(event.target.value as TerminalEngine)}>
      <option value="web">{zh?'Web（默认）':'Web (default)'}</option>
      <option value="native" disabled={!state?.nativeSupported}>{zh?'原生（实验）':'Native (experimental)'}</option>
    </select>
    </div>
    <p className="text-[11px] text-muted-foreground">{zh?'选择将保存在此 Preview；应用时重新加载当前工作区，保留服务端会话。原生引擎仍有偶发输入及输入法兼容问题。':'Saved in this Preview. Applying reloads this workspace and keeps server sessions. Native still has intermittent input and IME compatibility issues.'}</p>
    <p role="status" className="text-[11px] text-muted-foreground">{zh?`当前引擎：${state?.active==='native'?'原生':'Web'}。`:`Active engine: ${state?.active==='native'?'Native':'Web'}.`}{choice==='native'&&state?.targetVerified===false?(zh?' 完成此服务的身份验证后，再应用原生引擎。':' Complete verification of this service before applying Native.'):(state&&state.selected!==state.active?(zh?' 已保存的选择将在应用并重载后生效。':' Apply and reload to activate the saved choice.'):'')}</p>
    <div className="flex justify-end"><button type="button" className="min-h-8 rounded-md bg-surface px-3 py-1 text-[12px] text-foreground transition hover:bg-surface-elevated disabled:opacity-50" disabled={!state||busy||(choice==='native'&&state.targetVerified===false)||(choice===state.selected&&choice===state.active)} onClick={()=>void apply()}>{zh?'应用并重新加载工作区':'Apply and reload workspace'}</button></div>
    {error&&<p role="alert" className="text-[11px] text-destructive">{zh?'无法切换终端引擎，请重试。':'Could not switch the terminal engine. Please retry.'}</p>}
  </fieldset>{choice!=='native'&&children}</>;
}
