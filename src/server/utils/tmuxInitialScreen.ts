const SYNC_END = '\x1b[?2026l';

type InitialScreen = {
  data: string;
  status: 'complete' | 'timeout' | 'overflow' | 'cancelled';
};

/** Collect tmux's first synchronized redraw from its actual PTY stream.
 * Return subsequent bytes to the live delivery queue without duplicating
 * the initial screen in both connected.replayChunks and data frames.
 */
export class TmuxInitialScreen {
  readonly ready: Promise<InitialScreen>;
  private resolve!: (screen: InitialScreen) => void;
  private buffer = '';
  private bytes = 0;
  private done = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs = 1500, private readonly maxBytes = 512 * 1024) {
    this.ready = new Promise(resolve => { this.resolve = resolve; });
    // Compatibility escape hatch for a tmux build without synchronized
    // output. Normal startup completes on the protocol boundary immediately.
    this.timer = setTimeout(() => this.finish('timeout', this.buffer), timeoutMs);
    this.timer.unref?.();
  }

  push(data: string): string {
    if (this.done) return data;
    this.bytes += Buffer.byteLength(data);
    if (this.bytes > this.maxBytes) {
      this.finish('overflow', '');
      return '';
    }
    const searchFrom = Math.max(0, this.buffer.length - SYNC_END.length + 1);
    this.buffer += data;
    const end = this.buffer.indexOf(SYNC_END, searchFrom);
    if (end < 0) return '';
    const boundary = end + SYNC_END.length;
    const initial = this.buffer.slice(0, boundary);
    const remainder = this.buffer.slice(boundary);
    this.finish('complete', initial);
    return remainder;
  }

  cancel(): void { this.finish('cancelled', ''); }

  private finish(status: InitialScreen['status'], data: string): void {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.buffer = '';
    this.resolve({ status, data });
  }
}
