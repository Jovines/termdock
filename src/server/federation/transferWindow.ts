/** Application flow control inside Noise. Old peers retain one chunk in flight. */
export const TRANSFER_CHUNK_BYTES = 64 * 1024;
export const MAX_TRANSFER_WINDOW = 8;

export function transferWindow(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? Math.min(value, MAX_TRANSFER_WINDOW) : 1;
}

/** One producer and ordered acknowledgements; unsolicited ACKs grant no credit. */
export class TransferWindow {
  private outstanding = 0;
  private wake?: () => void;
  constructor(private readonly limit: number, private readonly signal: AbortSignal) {}
  sent(): void {
    if (this.outstanding >= this.limit) throw new Error('Transfer window exceeded');
    this.outstanding++;
  }
  acknowledge(): void {
    if (this.outstanding === 0) return;
    this.outstanding--;
    this.wake?.();
  }
  async wait(drained = false): Promise<void> {
    while (true) {
      if (this.signal.aborted) throw this.signal.reason ?? new Error('CANCELLED');
      if (this.outstanding < (drained ? 1 : this.limit)) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          this.signal.removeEventListener('abort', abort);
          this.wake = undefined;
        };
        const abort = () => { cleanup(); reject(this.signal.reason ?? new Error('CANCELLED')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('CONSUMER_TIMEOUT')); }, 30_000);
        this.wake = () => { cleanup(); resolve(); };
        this.signal.addEventListener('abort', abort, { once: true });
        if (this.signal.aborted) abort();
      });
    }
  }
}
