import { BOOT_SERVICE_ID } from '../federation/clientScope';
export const NATIVE_ENGINE='ghostty-21c717340b62349d67124446c2447bf38796540b-td4';
export interface NativeSnapshot {
  version:1;engine:string;owner:{service:string;target:string;session:string;device:string;window:string;view:string;epoch:string};
  options:{columns:number;rows:number;history:number;palette:unknown;font:unknown};font_size:number;data:string;data_sha256:string;cursor:{seq:number;epoch:string};savedAt:number;
}
const MAX_ENTRY=256*1024,MAX_TOTAL=4*1024*1024,TTL=24*60*60_000;
let revision=0,connection:Promise<IDBDatabase|null>|undefined;
type SnapshotStamp={authorization:number;session:object};
const sessionRevisions=new Map<string,object>(),capturedRevisions=new WeakMap<NativeSnapshot,SnapshotStamp>();
function sessionRevision(session:string):object{
 let stamp=sessionRevisions.get(session);if(!stamp)stamp={};sessionRevisions.delete(session);sessionRevisions.set(session,stamp);
 while(sessionRevisions.size>64)sessionRevisions.delete(sessionRevisions.keys().next().value!);return stamp;
}
export function nativeSnapshotRevision(session:string):SnapshotStamp{return{authorization:revision,session:sessionRevision(session)};}
function sameRevision(stamp:SnapshotStamp,session:string):boolean{return stamp.authorization===revision&&stamp.session===sessionRevision(session);}
export function tagNativeSnapshot(snapshot:NativeSnapshot,generation:SnapshotStamp):NativeSnapshot|null{
  if(!sameRevision(generation,snapshot.owner.session))return null;capturedRevisions.set(snapshot,generation);return snapshot;
}
export function usableNativeSnapshot(value:unknown):value is NativeSnapshot {
  const s=value as NativeSnapshot;
  if(!s||s.version!==1||s.engine!==NATIVE_ENGINE||typeof s.data!=='string'||typeof s.data_sha256!=='string'||!/^([0-9a-f]{64})$/.test(s.data_sha256)||!s.owner||!s.options||!s.cursor)return false;
  return Object.values(s.owner).every(value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x1f]/.test(value))
    &&Number.isSafeInteger(s.cursor.seq)&&s.cursor.seq>0&&typeof s.cursor.epoch==='string'&&s.cursor.epoch.length>0
    &&Number.isSafeInteger(s.options.columns)&&s.options.columns>=2&&Number.isSafeInteger(s.options.rows)&&s.options.rows>0
    &&Number.isFinite(s.font_size)&&s.font_size>=1&&s.font_size<=500&&Number.isFinite(s.savedAt)&&s.savedAt<=Date.now()&&Date.now()-s.savedAt<TTL
    &&JSON.stringify(s).length*2<=MAX_ENTRY;
}
function database(){
  if(typeof indexedDB==='undefined')return Promise.resolve(null);
  return connection??=new Promise<IDBDatabase|null>(resolve=>{
    const request=indexedDB.open(`termdock-native-snapshots:${BOOT_SERVICE_ID}`,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('snapshots',{keyPath:'owner.session'});
    request.onerror=request.onblocked=()=>resolve(null);request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();connection=undefined;};resolve(request.result);};
  });
}
export async function readNativeSnapshot(session:string):Promise<NativeSnapshot|null>{
  const generation=nativeSnapshotRevision(session);try{const db=await database();if(!db||!sameRevision(generation,session))return null;return await new Promise(resolve=>{
    const request=db.transaction('snapshots').objectStore('snapshots').get(session);request.onerror=()=>resolve(null);request.onsuccess=()=>resolve(sameRevision(generation,session)&&usableNativeSnapshot(request.result)?request.result:null);
  });}catch{return null;}
}
export async function writeNativeSnapshot(snapshot:NativeSnapshot):Promise<boolean>{
  if(capturedRevisions.has(snapshot)&&!sameRevision(capturedRevisions.get(snapshot)!,snapshot.owner.session))return false;
  if(!usableNativeSnapshot(snapshot))return false;const generation=nativeSnapshotRevision(snapshot.owner.session);
  try{const db=await database();if(!db||!sameRevision(generation,snapshot.owner.session))return false;return await new Promise<boolean>(resolve=>{
    const tx=db.transaction('snapshots','readwrite'),store=tx.objectStore('snapshots');store.put(snapshot);
    const all=store.getAll();all.onsuccess=()=>{let size=0,count=0;for(const s of all.result.sort((a,b)=>b.savedAt-a.savedAt)){
      size+=JSON.stringify(s).length*2;if(++count>32||size>MAX_TOTAL||!usableNativeSnapshot(s))store.delete(s.owner.session);
    }};tx.oncomplete=()=>resolve(true);tx.onerror=tx.onabort=()=>resolve(false);
  });}catch{return false;}
}
/** A local reset cannot succeed while an old durable screen can reappear.
 * Fence late captures/writes and confirm the IDB deletion transaction first. */
export async function deleteNativeSnapshot(session:string):Promise<boolean>{
 sessionRevision(session);sessionRevisions.set(session,{});
 try {
  let timeout:ReturnType<typeof setTimeout>|undefined;const db=await Promise.race([database(),new Promise<null>(resolve=>{timeout=setTimeout(()=>resolve(null),3000);})]);clearTimeout(timeout);if(!db)return false;
  return await new Promise<boolean>(resolve=>{
   const tx=db.transaction('snapshots','readwrite');tx.objectStore('snapshots').delete(session);
   const timeout=setTimeout(()=>{try{tx.abort();}catch{}resolve(false);},3000);
   const done=(ok:boolean)=>{clearTimeout(timeout);resolve(ok);};
   tx.oncomplete=()=>done(true);tx.onerror=tx.onabort=()=>done(false);
  });
 }catch{return false;}
}
export async function clearNativeSnapshots():Promise<void>{revision++;sessionRevisions.clear();try{(await database())?.transaction('snapshots','readwrite').objectStore('snapshots').clear();}catch{/* best effort */}}
if(typeof window!=='undefined')window.addEventListener('auth:unauthorized',()=>{void clearNativeSnapshots();});
