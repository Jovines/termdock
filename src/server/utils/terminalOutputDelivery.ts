export interface OutputFrame { type: 'data'; data: string; seq?: number; flowSeq?: number }

/** Per-observer output budget. A slow observer never pauses the shared PTY. */
export class TerminalOutputDelivery {
  active = true;
  replaying = true;
  needsReplay = false;
  private queue: OutputFrame[] = [];
  private queuedBytes = 0;
  private outstanding: Array<{ id: number; bytes: number }> = [];
  private outstandingBytes = 0;
  private nextId = 1;
  private lastAck = 0;

  constructor(
    private readonly send: (frame: OutputFrame) => void,
    private readonly flowControl: boolean,
    private readonly windowBytes = 128 * 1024,
    private readonly queueLimit = 512 * 1024,
    private readonly onOverflow?: () => void,
  ) {}

  setActive(active: boolean): boolean {
    const changed = active !== this.active;
    this.active = active;
    if (!active) { this.queue = []; this.queuedBytes = 0; }
    return changed;
  }

  enqueue(frame: OutputFrame): void {
    if (!this.active || this.needsReplay) return;
    // Bound single frames too. PTY producers may deliver multi-megabyte chunks.
    const bytes = Buffer.byteLength(frame.data);
    if (bytes + this.queuedBytes > this.queueLimit) {
      this.queue = [];
      this.queuedBytes = 0;
      this.needsReplay = true;
      this.onOverflow?.();
      return;
    }
    this.queue.push(frame);
    this.queuedBytes += bytes;
    this.flush();
  }

  acknowledge(id: number): void {
    if (!Number.isSafeInteger(id) || id <= this.lastAck || id >= this.nextId) return;
    this.lastAck = id;
    while (this.outstanding.length && this.outstanding[0].id <= id) {
      this.outstandingBytes -= this.outstanding.shift()!.bytes;
    }
    this.flush();
  }

  finishReplay(lastSeq: number): void {
    // Shell replay is captured after the async metadata lookup. Discard live
    // frames covered by that snapshot before exposing newer queued output.
    this.queue = this.queue.filter((frame) => frame.seq === undefined || frame.seq > lastSeq);
    this.queuedBytes = this.queue.reduce((sum, frame) => sum + Buffer.byteLength(frame.data), 0);
    this.outstanding = [];
    this.outstandingBytes = 0;
    this.needsReplay = false;
    this.replaying = false;
    this.flush();
  }

  get pendingBytes(): number { return this.queuedBytes + this.outstandingBytes; }

  private flush(): void {
    if (!this.active || this.replaying || this.needsReplay) return;
    while (this.queue.length && (!this.flowControl || this.outstandingBytes < this.windowBytes)) {
      const frame = this.queue.shift()!;
      const bytes = Buffer.byteLength(frame.data);
      this.queuedBytes -= bytes;
      if (this.flowControl) {
        const id = this.nextId++;
        this.outstanding.push({ id, bytes });
        this.outstandingBytes += bytes;
        this.send({ ...frame, flowSeq: id });
      } else this.send(frame);
    }
  }
}

export function resolveTerminalReplayCursor(since: number, clientEpoch: string | undefined, epoch: string): number {
  return clientEpoch === epoch && Number.isSafeInteger(since) && since > 0 ? since : 0;
}
