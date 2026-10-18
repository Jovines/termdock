// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {observeOwnedNativeInput} from './nativeInputObservation';
const page=window as unknown as {__TD_NATIVE_GATE_STATE?:any};
afterEach(()=>{delete page.__TD_NATIVE_GATE_STATE;});
it('is off for normal pages and completed or cancelled owned gates',()=>{
 observeOwnedNativeInput('private-view','private-token','native-event');expect(page.__TD_NATIVE_GATE_STATE).toBeUndefined();
 for(const flags of [{},{finished:true,inputObservation:true},{cancelled:true,inputObservation:true}]){const state={pageEpoch:'owned',...flags};page.__TD_NATIVE_GATE_STATE=state;observeOwnedNativeInput('private-view','private-token','native-event');expect(state).not.toHaveProperty('inputDiagnostics');}
});
it('keeps only fixed scalar match and refusal fields without token, view or input text',()=>{
 const state={pageEpoch:'owned',inputObservation:true,inputExpectedView:'private-view',inputExpectedToken:'private-token'};page.__TD_NATIVE_GATE_STATE=state;
 observeOwnedNativeInput('private-view','private-token','native-event');observeOwnedNativeInput('private-view',undefined,'page-input',{reason:'suppressReplay'});observeOwnedNativeInput('private-view','private-token','viewport-send',{result:'undefined'});
 const wire=JSON.stringify((state as any).inputDiagnostics);expect(wire).not.toContain('private-view');expect(wire).not.toContain('private-token');expect(JSON.parse(wire)).toEqual([{source:'native-event',viewMatches:true,tokenMatches:true},{source:'page-input',viewMatches:true,tokenMatches:null,reason:'suppressReplay'},{source:'viewport-send',viewMatches:true,tokenMatches:true,result:'undefined'}]);
});
it('retains the last sixteen observations with visible dropped count',()=>{
 const state:any={pageEpoch:'owned',inputObservation:true};page.__TD_NATIVE_GATE_STATE=state;for(let i=0;i<20;i++)observeOwnedNativeInput('v','t','viewport-send',{result:i===19?'error':'true'});expect(state.inputDiagnostics).toHaveLength(16);expect(state.inputDiagnosticsDropped).toBe(4);expect(state.inputDiagnostics.at(-1).result).toBe('error');
});
