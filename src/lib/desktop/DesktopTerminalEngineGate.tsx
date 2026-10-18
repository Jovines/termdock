import React from 'react';
import { StartupScreen } from '../components/StartupScreen';

/** The host resolves ready only after the old document's native views detach. */
export function DesktopTerminalEngineGate({ready,children}:{ready?:Promise<unknown>;children:React.ReactNode}) {
  const [result,setResult]=React.useState<{promise:Promise<unknown>;ok:boolean}|null>(null);
  React.useEffect(()=>{
    if(!ready)return;let current=true;
    void ready.then(()=>{if(current)setResult({promise:ready,ok:true});},error=>{console.error('Terminal engine negotiation failed',error);if(current)setResult({promise:ready,ok:false});});
    return ()=>{current=false;};
  },[ready]);
  if(!ready)return <>{children}</>;
  if(result?.promise!==ready)return <StartupScreen status="Preparing terminal engine"/>;
  if(!result.ok)return <StartupScreen status="无法完成终端引擎切换" detail="旧终端尚未确认退场，请重新加载工作区。" actionLabel="重新加载" onAction={()=>location.reload()}/>;
  return <>{children}</>;
}
