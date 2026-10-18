// Temporary, default-off observation for the existing owned native-input gate.
// It records fixed scalars only and grants no bridge or business capability.
type InputObservation = {inputActive?:boolean;engineReady?:boolean;localResetting?:boolean;backendMatches?:boolean;result?:'true'|'false'|'undefined'|'other'|'error';reason?:'focusSuspended'|'inactive'|'empty'|'suppressReplay'|'stream'|'send-start'|'send-return'|'send-error'};
type InputGate = {pageEpoch:string;finished?:boolean;cancelled?:boolean;inputObservation?:boolean;inputExpectedToken?:string;inputExpectedView?:string;inputDiagnostics?:unknown[];inputDiagnosticsDropped?:number};
export function observeOwnedNativeInput(view:string,token:string|undefined,source:'native-event'|'viewport-send'|'page-input',fields:InputObservation={}){
 try{
  const state=(window as unknown as {__TD_NATIVE_GATE_STATE?:InputGate}).__TD_NATIVE_GATE_STATE;
  if(!state||state.inputObservation!==true||state.finished||state.cancelled)return;
  const values=state.inputDiagnostics??(state.inputDiagnostics=[]);
  if(values.length>=16){values.shift();state.inputDiagnosticsDropped=(state.inputDiagnosticsDropped??0)+1;}
  values.push({source,viewMatches:view===state.inputExpectedView,tokenMatches:token===undefined?null:token===state.inputExpectedToken,...fields});
 }catch{/* Observation cannot change normal input handling. */}
}
