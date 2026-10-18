import type { TerminalChunk } from './types';
export const NATIVE_BATCH_BYTES = 256 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
type Batch = { sequence: number; bytes: Uint8Array; chunkId: number | null; replay: boolean; replayEnd: boolean; cursor?: {seq:number;epoch:string} };
type LocalReset = { reset:()=>Promise<{sequence:number;cursor:{seq:number;epoch:string}|null}>;resolve:()=>void;reject:(error:unknown)=>void;started?:boolean };
/** Single parser delivery queue. Submission Pending is never a consumption ACK.
 * One in-flight batch, bounded pending bytes, raw UTF8 including split escapes.
 * No second VT parser, text snapshot or journal is constructed on the page. */
export class NativeOutputQueue {
  private pending: (Omit<Batch, 'sequence'>|LocalReset)[] = [];
  private resetPromise:Promise<void>|null = null;
  private inFlight: Batch | null = null;
  private sending = false;
  private stopped = false;
  private nextSequence: number;
  private bytes = 0;
  private paused = false;
  private lastChunk: number | null = null;
  private lastConsumedChunk: number | null = null;
  private replacement = false;
  private cursor: {seq:number;epoch:string}|null = null;
  constructor(sequence: number, private readonly send: (batch: Batch) => Promise<unknown>, private readonly progress: (id: number) => void, private readonly flow: (paused: boolean) => void, private readonly fatal: (error: Error) => void, baseline:{seq:number;epoch:string}|null=null) {
    this.nextSequence = sequence + 1;this.cursor=baseline;
  }
  get consumedSequence(): number { return this.nextSequence - 1; }
  get consumedCursor(): {seq:number;epoch:string}|null { return this.cursor; }
  get consumedChunkId(): number|null { return this.lastConsumedChunk; }
  get idle(): boolean { return !this.inFlight && !this.pending.length && !this.sending; }
  localReset(reset:LocalReset['reset']):Promise<void> {
    if(this.stopped)return Promise.reject(new Error('Native output owner is closed'));
    if(this.resetPromise)return this.resetPromise;
    let entry!:LocalReset;
    const pending=new Promise<void>((resolve,reject)=>{entry={reset,resolve,reject};this.pending.push(entry);});
    // Only cancel a reset that has not reached the host. A started native
    // operation may have changed state and is never blindly resubmitted.
    const timeout=setTimeout(()=>{if(!entry.started){const index=this.pending.indexOf(entry);if(index>=0)this.pending.splice(index,1);entry.reject(new Error('Local clear is waiting for actual output consumption; no reset was submitted'));}},10000);
    this.resetPromise=pending;void pending.finally(()=>{clearTimeout(timeout);if(this.resetPromise===pending)this.resetPromise=null;}).catch(()=>{});
    void this.flush();return pending;
  }
  prepareReplacement(): void {
    // Preserve in-flight ownership and wait for its real ACK. Only unsent old
    // output can be superseded by an authoritative replacement transaction.
    for (const batch of this.pending) {
      if('reset' in batch)batch.reject(new Error('Local clear superseded by authoritative output'));
      else this.bytes -= batch.bytes.byteLength;
    }
    this.pending = []; this.lastChunk = null; this.replacement = true; this.watermark();
  }
  control(data: string): void {
    if(this.stopped)return;
    const bytes=new TextEncoder().encode(data);
    if(bytes.length>NATIVE_BATCH_BYTES||this.bytes+bytes.length>MAX_PENDING_BYTES){this.stop(new Error('Native local transaction exceeds pending budget'));return;}
    this.pending.push({bytes,chunkId:null,replay:true,replayEnd:true});this.bytes+=bytes.length;this.watermark();void this.flush();
  }
  accept(chunks: readonly TerminalChunk[], historical = false, cursor?: {seq:number;epoch:string}|null): void {
    if (this.stopped || !chunks.length) return;
    const index = this.lastChunk === null ? -1 : chunks.findIndex(chunk => chunk.id === this.lastChunk);
    if (this.lastChunk !== null && index < 0 && !this.replacement) {
      this.stop(new Error('Native output baseline was evicted or replaced without an authoritative transaction')); return;
    }
    const fresh = chunks.slice(index + 1);
    const replay = historical || this.replacement;
    const batches: Omit<Batch,'sequence'>[] = [];
    let cost = 0;
    for (const chunk of fresh) {
      const bytes = new TextEncoder().encode(chunk.data); cost += bytes.byteLength;
      if (!bytes.length) { batches.push({bytes,chunkId:chunk.id,replay,replayEnd:false}); continue; }
      for (let offset=0; offset<bytes.length; offset+=NATIVE_BATCH_BYTES) {
        const end=Math.min(bytes.length,offset+NATIVE_BATCH_BYTES);
        batches.push({bytes:bytes.slice(offset,end),chunkId:end===bytes.length?chunk.id:null,replay,replayEnd:false});
      }
    }
    if (this.bytes + cost > MAX_PENDING_BYTES) { this.stop(new Error('Native pending output exceeded 4 MiB; terminal state was retained, output recovery is required')); return; }
    if(batches.length){batches[batches.length-1].replayEnd=true;if(cursor)batches[batches.length-1].cursor=cursor;}
    this.pending.push(...batches); this.bytes += cost; this.lastChunk = chunks.at(-1)!.id;
    this.replacement = false; this.watermark(); void this.flush();
  }
  async flush(): Promise<void> {
    if (this.stopped || this.sending || this.inFlight || !this.pending.length) return;
    this.sending = true;
    const next = this.pending.shift()!;
    if('reset' in next){
      next.started=true;
      try {
        const receipt=await next.reset();
        if(this.stopped)throw new Error('Local clear belongs to an old native owner');
        this.nextSequence=receipt.sequence+1;this.cursor=receipt.cursor;
        // Keep lastChunk: future store updates must never replay pre-clear data.
        // This is a local barrier, not an output consumption ACK/progress event.
        next.resolve();
      } catch(error){next.reject(error);}
      finally {this.sending=false;void this.flush();}
      return;
    }
    const batch = { ...next, sequence:this.nextSequence };
    // Set before IPC: native ACK may arrive before invoke returns Pending.
    this.inFlight = batch;
    try {
      const response = await this.send(batch) as {pending?: number; duplicate?: boolean; sequence?: number};
      if (this.stopped) return;
      if (response?.duplicate === true && response.sequence === batch.sequence) this.ack(batch.sequence);
      else if (response?.pending !== batch.sequence) this.stop(new Error('Native engine did not accept the expected pending sequence'));
    } catch (error) {
      if (!this.stopped) this.stop(error instanceof Error?error:new Error(String(error)));
    } finally { this.sending = false; if (!this.inFlight) void this.flush(); }
  }
  ack(sequence: number): void {
    if (this.stopped) return;
    const batch = this.inFlight;
    if (!batch || sequence !== batch.sequence) { this.stop(new Error('Native consumption ACK has an unexpected sequence')); return; }
    this.inFlight = null; this.nextSequence = sequence + 1; this.bytes -= batch.bytes.byteLength;
    this.cursor = batch.cursor ?? null;
    this.watermark(); if (batch.chunkId !== null) {this.lastConsumedChunk=batch.chunkId;this.progress(batch.chunkId);}
    void this.flush();
  }
  private watermark(): void {
    const paused=this.bytes >= 500_000 ? true : this.bytes <= 100_000 ? false : this.paused;
    if (paused!==this.paused) {this.paused=paused;this.flow(paused);}
  }
  stop(error?: Error): void { this.stopped=true;for(const entry of this.pending)if('reset' in entry)entry.reject(error??new Error('Native owner changed'));if(error){this.flow(true);this.fatal(error);} }
}
export function nativeBase64(bytes: Uint8Array): string {
  let text=''; for(let offset=0;offset<bytes.length;offset+=8192) text+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
  return btoa(text);
}
