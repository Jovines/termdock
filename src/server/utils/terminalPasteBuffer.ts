const START = '\x1b[200~';
const END = '\x1b[201~';
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const INCOMPLETE = '粘贴内容未完整送达，已取消，请重新粘贴。';

/** A socket owns its pending paste. Never expose its opening delimiter to the
 * PTY until the closing delimiter has arrived, even across input records.
 * Ordinary keyboard/mouse records remain synchronous and unbuffered. */
export class TerminalPasteBuffer {
  private pending = '';
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onTimeout: (message: string) => void) {}

  push(data: string): string[] {
    const previousStart = this.startedAt;
    const continuing = this.pending.length > 0;
    const input = this.pending + data;
    const output: string[] = [];
    this.clear();
    let offset = 0;
    while (offset < input.length) {
      const start = input.indexOf(START, offset);
      if (start < 0) { output.push(input.slice(offset)); break; }
      if (start > offset) output.push(input.slice(offset, start));
      const end = input.indexOf(END, start + START.length);
      const nested = input.indexOf(START, start + START.length);
      if (nested >= 0 && (end < 0 || nested < end)) throw new Error(INCOMPLETE);
      const paste = input.slice(start, end < 0 ? undefined : end + END.length);
      if (Buffer.byteLength(paste) > MAX_BYTES) throw new Error('粘贴内容超过 1 MiB，请分段粘贴。');
      if (end < 0) {
        this.pending = paste;
        this.startedAt = continuing && start === 0 ? previousStart : Date.now();
        this.timer = setTimeout(() => { this.clear(); this.onTimeout(INCOMPLETE); },
          Math.max(0, this.startedAt + TIMEOUT_MS - Date.now()));
        this.timer.unref();
        break;
      }
      output.push(paste);
      offset = end + END.length;
    }
    return output;
  }

  /** HTTP input has no continuation stream. Reject its entire body on failure. */
  complete(data: string): string[] {
    const output = this.push(data);
    if (this.pending) { this.clear(); throw new Error(INCOMPLETE); }
    return output;
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = '';
    this.startedAt = 0;
  }
}
