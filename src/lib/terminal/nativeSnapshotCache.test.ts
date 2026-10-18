import { describe,it,expect,vi } from 'vitest';
import {indexedDB} from '../../../desktop-rust/node_modules/fake-indexeddb';
import { usableNativeSnapshot, readNativeSnapshot, writeNativeSnapshot, clearNativeSnapshots, deleteNativeSnapshot, nativeSnapshotRevision, tagNativeSnapshot, NATIVE_ENGINE, type NativeSnapshot } from './nativeSnapshotCache';
function snapshot(id='pty', savedAt=Date.now()):NativeSnapshot {
 return {version:1,engine:NATIVE_ENGINE,owner:{service:'https://service',target:'target',session:id,device:'device',window:'window',view:'panel',epoch:'old-page'},options:{columns:80,rows:24,history:1000,font:{family:'JetBrainsMonoNL NFM'},palette:{}},font_size:14,data:'{"version":1,"vt":"ANSI","state":{}}',data_sha256:'0'.repeat(64),cursor:{seq:40,epoch:'stream'},savedAt};
}
describe('bounded independent native durable cache',()=>{
 it('rejects xterm/raw journal, stale/oversized/invalid data and wrong engine',()=>{
  const value=snapshot();expect(usableNativeSnapshot(value)).toBe(true);
  for(const bad of [{...value,version:3},{...value,engine:'xterm'},{...value,savedAt:Date.now()-24*60*60_000},{...value,data:'a'.repeat(128*1024)},{...value,cursor:{seq:0,epoch:'stream'}},{...value,owner:{...value.owner,device:''}}])expect(usableNativeSnapshot(bad)).toBe(false);
 });
 it('roundtrips with the real IDB API, applies 32-entry eviction and clears authorization generations',async()=>{
  vi.stubGlobal('indexedDB',indexedDB);await clearNativeSnapshots();
  await writeNativeSnapshot(snapshot());expect(await readNativeSnapshot('pty')).toEqual(snapshot('pty', (await readNativeSnapshot('pty'))!.savedAt));
  const now=Date.now();for(let i=0;i<34;i++)await writeNativeSnapshot(snapshot('pty-'+i,now-100+i));
  expect(await readNativeSnapshot('pty-0')).toBeNull();expect(await readNativeSnapshot('pty-33')).not.toBeNull();
  await clearNativeSnapshots();expect(await readNativeSnapshot('pty-33')).toBeNull();
 });
 it('unavailable storage returns no baseline and never blocks the caller',async()=>{
  vi.stubGlobal('indexedDB',undefined);expect(await readNativeSnapshot('missing')).toBeNull();vi.unstubAllGlobals();
 });
});

it('confirmed local deletion fences late captures/writes and permits a new neutral durable entry',async()=>{
 vi.stubGlobal('indexedDB',indexedDB);await clearNativeSnapshots();const previous=tagNativeSnapshot(snapshot('clear-pty'),nativeSnapshotRevision('clear-pty'))!;await writeNativeSnapshot(previous);
 const oldGeneration=nativeSnapshotRevision('clear-pty');expect(await deleteNativeSnapshot('clear-pty')).toBe(true);expect(await readNativeSnapshot('clear-pty')).toBeNull();
 await writeNativeSnapshot(previous);expect(await readNativeSnapshot('clear-pty')).toBeNull();expect(tagNativeSnapshot(snapshot('clear-pty'),oldGeneration)).toBeNull();
 const neutral=tagNativeSnapshot({...snapshot('clear-pty'),data:'{"version":1,"vt":"","state":{}}'},nativeSnapshotRevision('clear-pty'))!;await writeNativeSnapshot(neutral);expect((await readNativeSnapshot('clear-pty'))?.data).toBe(neutral.data);vi.unstubAllGlobals();
});

it('local clear does not invalidate another owned session capture or cached entry',async()=>{
 vi.stubGlobal('indexedDB',indexedDB);await clearNativeSnapshots();const other=tagNativeSnapshot(snapshot('other-pty'),nativeSnapshotRevision('other-pty'))!;
 await deleteNativeSnapshot('clear-pty');expect(await writeNativeSnapshot(other)).toBe(true);expect(await readNativeSnapshot('other-pty')).not.toBeNull();vi.unstubAllGlobals();
});
