import { getTermdockDesktopBridge } from './nativeBridge';
export async function confirmPageAction(options:{title:string;message:string;confirmLabel:string;cancelLabel:string}):Promise<boolean>{
  const bridge=getTermdockDesktopBridge();
  return bridge?.confirmationUI==='page-v1'&&bridge.confirm?await bridge.confirm(options):window.confirm(options.message);
}
export function showPageFeedback(message:string):void {
  const bridge=getTermdockDesktopBridge();
  if(bridge?.confirmationUI==='page-v1'&&bridge.alert)bridge.alert(message);else window.alert(message);
}
/** A synchronous lock and live scope cover confirmation, transport awaits and
 * the response. No native HTTP or global asynchronous confirm shim is used. */
export async function runConfirmedPageAction<T>(lock:{busy:boolean},action:{
 confirm:()=>boolean|Promise<boolean>;current:()=>boolean;submit:(current:()=>boolean)=>Promise<T>;
 apply:(result:T)=>void;pending:(value:boolean)=>void;failure:(message:string)=>void;expiredMessage:string;
}):Promise<void>{
 if(lock.busy)return;lock.busy=true;action.pending(true);
 try{if(!await action.confirm())return;if(!action.current())throw new Error(action.expiredMessage);const result=await action.submit(action.current);if(action.current())action.apply(result);}
 catch(error){if(action.current())action.failure(error instanceof Error?error.message:String(error));}
 finally{lock.busy=false;action.pending(false);}
}
