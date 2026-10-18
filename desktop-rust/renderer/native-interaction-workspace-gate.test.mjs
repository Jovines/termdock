import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const helpers=fs.readFileSync(new URL('./native-workspace-gate.js',import.meta.url),'utf8').split('(async()=>{')[0];
const driver=fs.readFileSync(new URL('./native-interaction-workspace-gate.js',import.meta.url),'utf8');
test('actual interaction receiver reports a rejected owner without retrying or fabricating host ACK/steps',async()=>{
 let calls=0;const window={__TD_NATIVE_GATE_NONCE:'owned',__TD_NATIVE_GATE_EPOCH:'page',termdockDesktop:{nativeTerminal:{available:true,subscribe:()=>()=>{},request:async()=>{calls++;throw Error('Native capability belongs to another owner');}}}},document={title:''};
 await vm.runInNewContext(helpers+driver,{window,document,Promise,Error,String,Object,Array,JSON,Uint8Array,TextEncoder,performance,setTimeout,clearTimeout,innerWidth:900,innerHeight:600});
 const snapshot=JSON.parse(window.__TD_NATIVE_GATE_WIRE);assert.equal(snapshot.kind,'result');assert.equal(snapshot.data.ok,false);assert.match(snapshot.data.error,/another owner/);assert.deepEqual(snapshot.data.acks,[]);assert.deepEqual(snapshot.data.steps,[]);assert.equal(calls,1);assert.equal(snapshot.data.pageEpoch,'page');assert(document.title.length<512);
});

test('same-document injection is idempotent and a new epoch stops a pending owned create without retry or accepting its late result',async()=>{
 let calls=0,finish;const window={__TD_NATIVE_GATE_NONCE:'owned',__TD_NATIVE_GATE_EPOCH:'page-a',termdockDesktop:{nativeTerminal:{available:true,subscribe:()=>()=>{},request:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}}}},document={title:''};
 const context=vm.createContext({window,document,Promise,Error,String,Object,Array,JSON,Uint8Array,TextEncoder,performance,setTimeout,clearTimeout,innerWidth:900,innerHeight:600});
 const pending=vm.runInContext(helpers+driver,context);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls,1);
 await vm.runInContext(helpers+driver,context);assert.equal(calls,1);
 window.__TD_NATIVE_GATE_EPOCH='page-b';await vm.runInContext(helpers+driver,context);
 const failure=window.__TD_NATIVE_GATE_WIRE,snapshot=JSON.parse(failure);assert.equal(snapshot.data.pageEpoch,'page-b');assert.equal(snapshot.data.previousPageEpoch,'page-a');assert.deepEqual(snapshot.data.acks,[]);assert.deepEqual(snapshot.data.steps,[]);assert.equal(snapshot.data.ok,false);
 finish({token:'old-token',epoch:'page-a',sequence:0});await pending;
 assert.equal(calls,1);assert.equal(window.__TD_NATIVE_GATE_WIRE,failure); // late callback cannot advance page-b
});
