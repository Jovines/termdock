import { describe,it,expect,vi } from 'vitest';
import { NativeOutputQueue, NATIVE_BATCH_BYTES } from './nativeOutput';
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
describe('single native consumption stream',()=>{
  it('waits for real consumption ACK, preserves raw UTF8 and escapes across bounded batches',async()=>{
    const writes:Array<{sequence:number;bytes:Uint8Array;chunkId:number|null;replay:boolean}>=[], progress:number[]=[], flow:boolean[]=[], errors:Error[]=[];
    const q=new NativeOutputQueue(0,async batch=>{writes.push(batch);return{pending:batch.sequence};},id=>progress.push(id),paused=>flow.push(paused),error=>errors.push(error));
    const data='a'.repeat(NATIVE_BATCH_BYTES-1)+'中\x1b[?1049h\x1b[31m界\x1b[?1049l';
    q.accept([{id:1,data}]);await turn();expect(writes).toHaveLength(1);expect(progress).toEqual([]);expect(q.idle).toBe(false);
    q.ack(1);await turn();expect(writes).toHaveLength(2);expect(progress).toEqual([]);q.ack(2);
    expect(progress).toEqual([1]);expect(q.idle).toBe(true);expect(q.consumedSequence).toBe(2);
    const bytes=new Uint8Array(writes.reduce((n,b)=>n+b.bytes.length,0));let offset=0;for(const batch of writes){bytes.set(batch.bytes,offset);offset+=batch.bytes.length;expect(batch.bytes.length).toBeLessThanOrEqual(NATIVE_BATCH_BYTES);}
    expect(new TextDecoder().decode(bytes)).toBe(data);expect(errors).toEqual([]);
  });
  it('accepts native ACK arriving before the invoke Pending response',async()=>{
    let resolve!: (response:unknown)=>void;const progress:number[]=[];let writes=0;
    const q=new NativeOutputQueue(4,()=>{writes++;return new Promise(r=>{resolve=r});},id=>progress.push(id),()=>{},()=>{});
    q.accept([{id:9,data:'first'},{id:10,data:'second'}]);q.ack(5);expect(progress).toEqual([9]);expect(writes).toBe(1);resolve({pending:5});await turn();expect(writes).toBe(2);q.ack(6);resolve({pending:6});await turn();expect(progress).toEqual([9,10]);
  });
  it('an authoritative replacement preserves in-flight bytes and discards only unsent superseded output',async()=>{
    const writes:Array<{sequence:number;bytes:Uint8Array;replay:boolean}>=[],errors:Error[]=[];
    const q=new NativeOutputQueue(0,async b=>{writes.push(b);return{pending:b.sequence};},()=>{},()=>{},error=>errors.push(error));
    q.accept([{id:1,data:'old'},{id:2,data:'unsent'}]);await turn();q.prepareReplacement();q.accept([{id:3,data:'\x1bc\x1b[?1049h\x1b[2Jauthoritative'}]);q.ack(1);await turn();expect(writes).toHaveLength(2);expect(writes[1].replay).toBe(true);expect(new TextDecoder().decode(writes[1].bytes)).not.toContain('unsent');expect(errors).toEqual([]);
  });
  it('fails closed on a missing baseline or wrong ACK without advancing',async()=>{
    const errors:Error[]=[],progress:number[]=[];const q=new NativeOutputQueue(0,async b=>({pending:b.sequence}),id=>progress.push(id),()=>{},error=>errors.push(error));
    q.accept([{id:1,data:'hello'}]);await turn();q.ack(2);expect(progress).toEqual([]);expect(q.consumedSequence).toBe(0);expect(errors[0].message).toContain('unexpected');
    const other=new NativeOutputQueue(0,async b=>({pending:b.sequence}),()=>{},()=>{},error=>errors.push(error));other.accept([{id:1,data:'hello'}]);other.ack(1);other.accept([{id:3,data:'evicted'}]);expect(errors[1].message).toContain('baseline');
  });
  it('stale callbacks after owner invalidation cannot ACK or send to the replacement PTY',async()=>{
    const writes:number[]=[],progress:number[]=[];const q=new NativeOutputQueue(0,async b=>{writes.push(b.sequence);return{pending:b.sequence};},id=>progress.push(id),()=>{},()=>{});
    q.accept([{id:1,data:'old PTY'},{id:2,data:'pending'}]);q.stop();q.ack(1);await turn();expect(writes).toEqual([1]);expect(progress).toEqual([]);
  });
  it('continues live beyond the native replay journal limit, without rebuilding or replaying state',async()=>{
    let bytes=0;const q=new NativeOutputQueue(0,async batch=>{bytes+=batch.bytes.length;return{pending:batch.sequence};},()=>{},()=>{},error=>{throw error;});
    let sequence=1;for(let id=1;id<=40;id++){q.accept([...(id>1?[{id:id-1,data:''}]:[]),{id,data:'a'.repeat(256*1024)}]);await turn();q.ack(sequence++);}
    expect(bytes).toBe(10*1024*1024);expect(q.consumedSequence).toBe(40);expect(q.idle).toBe(true);
  });
});
it('a native baseline is published only for complete consumption; byte-only control never supplies a checkpoint',async()=>{
 const q=new NativeOutputQueue(0,async b=>({pending:b.sequence}),()=>{},()=>{},error=>{throw error;});const cursor={seq:17,epoch:'stream-a'};
 q.accept([{id:1,data:'a'.repeat(NATIVE_BATCH_BYTES+1)}],false,cursor);await turn();expect(q.consumedCursor).toBeNull();q.ack(1);await turn();expect(q.consumedCursor).toBeNull();q.ack(2);expect(q.consumedCursor).toEqual(cursor);
 q.control('\x1bc');await turn();q.ack(3);expect(q.consumedCursor).toBeNull();
});

it('orders local reset after real old consumption and before later output without replaying retained chunks',async()=>{
 const writes:any[]=[],progress:number[]=[],reset=vi.fn(async()=>({sequence:0,cursor:{seq:5,epoch:'stream'}}));
 const q=new NativeOutputQueue(0,async b=>{writes.push(b);return{pending:b.sequence};},id=>progress.push(id),()=>{},error=>{throw error;});
 q.accept([{id:1,data:'\x1bPunfinished'}],false,{seq:5,epoch:'stream'});await turn();const clear=q.localReset(reset);
 q.accept([{id:1,data:'\x1bPunfinished'},{id:2,data:'new'}],false,{seq:6,epoch:'stream'});expect(reset).not.toHaveBeenCalled();q.ack(1);await clear;await turn();
 expect(reset).toHaveBeenCalledTimes(1);expect(writes).toHaveLength(2);expect(new TextDecoder().decode(writes[1].bytes)).toBe('new');expect(writes[1].sequence).toBe(1);expect(progress).toEqual([1]);expect(q.consumedCursor).toEqual({seq:5,epoch:'stream'});
 q.ack(1);expect(progress).toEqual([1,2]);expect(q.consumedCursor).toEqual({seq:6,epoch:'stream'});
});
it('closing an owner cancels its pending local reset without invoking it or progressing output',async()=>{
 const reset=vi.fn(async()=>({sequence:0,cursor:null})),progress=vi.fn();const q=new NativeOutputQueue(0,async b=>({pending:b.sequence}),progress,()=>{},()=>{});
 q.accept([{id:1,data:'partial'}]);const clear=q.localReset(reset);q.stop();await expect(clear).rejects.toThrow('owner');q.ack(1);expect(reset).not.toHaveBeenCalled();expect(progress).not.toHaveBeenCalled();
});

it('a pending local clear times out without submitting or advancing an unconsumed cursor',async()=>{
 vi.useFakeTimers();try{const reset=vi.fn(async()=>({sequence:0,cursor:null})),progress=vi.fn();const q=new NativeOutputQueue(0,async b=>({pending:b.sequence}),progress,()=>{},()=>{});
 q.accept([{id:1,data:'partial'}],false,{seq:1,epoch:'old'});const clear=q.localReset(reset),rejection=expect(clear).rejects.toThrow('no reset was submitted');await vi.advanceTimersByTimeAsync(10000);await rejection;expect(reset).not.toHaveBeenCalled();expect(q.consumedSequence).toBe(0);expect(q.consumedCursor).toBeNull();expect(progress).not.toHaveBeenCalled();q.ack(1);expect(q.consumedCursor).toEqual({seq:1,epoch:'old'});q.stop();}finally{vi.useRealTimers();}
});
it('a confirmed restored baseline remains available to a local clear before the first incremental output',async()=>{
 const cursor={seq:8,epoch:'stream'},q=new NativeOutputQueue(1,async b=>({pending:b.sequence}),()=>{},()=>{},()=>{},cursor);
 expect(q.consumedCursor).toEqual(cursor);await q.localReset(async()=>({sequence:0,cursor}));expect(q.consumedSequence).toBe(0);expect(q.consumedCursor).toEqual(cursor);
});
