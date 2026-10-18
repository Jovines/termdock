import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {normalizeWorkspaceWorker,workspacePrecacheUrls} from './workspace-sw.mjs';
const vite=fs.readFileSync(new URL('../../vite.config.ts',import.meta.url),'utf8');
const fixture='self.importScripts("sw-encrypted-background.js");workbox.precacheAndRoute([{url:"index.html",revision:"1"},{url:"assets/app-core.js",revision:null},{url:"assets/App-workspace.js",revision:null},{url:"assets/react-main.js",revision:null},{url:"manifest.webmanifest",revision:"2"}]);workbox.registerRoute(/assets/,new workbox.CacheFirst());';
const resources=['index.html','assets/app-core.js','assets/App-workspace.js','assets/react-main.js','manifest.webmanifest'];
test('APFS extra App module stays available on demand without changing background/runtime cache code',()=>{
 const result=normalizeWorkspaceWorker(fixture,resources,vite);
 assert.deepEqual(result.removedCaseVariants,['assets/App-workspace.js']);
 assert(!result.precacheUrls.includes('assets/App-workspace.js'));assert(resources.includes('assets/App-workspace.js'));
 assert(result.script.includes('self.importScripts("sw-encrypted-background.js")'));assert(result.script.includes('workbox.registerRoute(/assets/,new workbox.CacheFirst())'));
});
test('missing core resource or unknown generated policy fails packaging',()=>{
 assert.throws(()=>normalizeWorkspaceWorker(fixture,resources.filter(n=>n!=='index.html'),vite));
 assert.throws(()=>normalizeWorkspaceWorker(fixture,resources.concat('assets/app-missing.js'),vite));
 assert.throws(()=>normalizeWorkspaceWorker(fixture.replace('App-workspace','private'),resources.map(n=>n.replace('App-workspace','private')),vite));
});
test('actual platform-generated worker conforms to the current source cold-loading policy',{skip:!fs.existsSync(new URL('../../dist/client/sw.js',import.meta.url))},()=>{
 const workerPath=new URL('../../dist/client/sw.js',import.meta.url);
 const worker=fs.readFileSync(workerPath,'utf8');
 const built=JSON.parse(fs.readFileSync(new URL('../.workspace-dist/workspace-manifest.json',import.meta.url),'utf8'));
 const result=normalizeWorkspaceWorker(worker,Object.keys(built.files),vite);
 assert.deepEqual(workspacePrecacheUrls(result.script),result.precacheUrls);assert(result.precacheUrls.includes('index.html'));assert(result.script.includes('sw-encrypted-background.js'));assert(result.script.includes('termdock-lazy-assets-v1'));
 if(process.env.TD_PREVIEW_MAC_WORKER){
  const mac=fs.readFileSync(process.env.TD_PREVIEW_MAC_WORKER,'utf8');const normalized=normalizeWorkspaceWorker(mac,Object.keys(built.files),vite);
  assert(normalized.removedCaseVariants.some(n=>/^assets\/App-/.test(n)));
  assert.deepEqual(new Set(normalized.precacheUrls),new Set(result.precacheUrls));
 }
});

test('Preview launch navigation bypasses the existing encrypted worker without allowing business HTTP',()=>{
 const listeners=new Map();
 const self={location:{origin:'http://127.0.0.1:43000'},addEventListener:(name,listener)=>listeners.set(name,listener)};
 vm.runInNewContext(fs.readFileSync(new URL('../../public/sw-secure-api.js',import.meta.url),'utf8'),{self,URL,Map,Set,Response,Headers,TextEncoder,TextDecoder,Uint8Array,setTimeout,clearTimeout});
 let intercepted=false;
 listeners.get('fetch')({request:new Request(self.location.origin+'/api/auth/status?__td_launch=owned-fixture'),respondWith:()=>{intercepted=true;}});
 assert.equal(intercepted,false);
 // Ordinary business reads still enter the encrypted page handoff, never the
 // bootstrap network exception. No page/client exists in this failure case.
 let denied;
 listeners.get('fetch')({request:new Request(self.location.origin+'/api/terminal/sessions'),clientId:'',respondWith:promise=>{intercepted=true;denied=promise;}});
 assert.equal(intercepted,true);
 return Promise.resolve(denied).then(response=>assert.equal(response.status,503));
});
