/** Serializes a terminal's input with its optional server-side preparation.
 * A slow preparation never permits later keys or paste segments to overtake it. */
export class TerminalInputQueue {
  private items: Array<{ data: string[]; before?: () => Promise<void>; bytes: number }> = [];
  private bytes = 0;
  private running = false;
  private stopped = false;
  constructor(private write: (data: string) => void | Promise<void>, private failed: (error: Error) => void) {}
  push(data: string[], before?: () => Promise<void>): void {
    if (this.stopped) return;
    const bytes = data.reduce((total, part) => total + Buffer.byteLength(part), 0);
    if (this.items.length >= 256 || this.bytes + bytes > 1024 * 1024) {
      this.fail(new Error('Terminal input queue exceeded its budget')); return;
    }
    this.items.push({ data, before, bytes }); this.bytes += bytes;
    if (!this.running) void this.drain();
  }
  close(): void { this.stopped = true; this.items = []; this.bytes = 0; }
  private fail(error: Error): void { this.close(); this.failed(error); }
  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (!this.stopped && this.items.length) {
        const item = this.items[0];
        if (item.before) await item.before();
        for (const part of item.data) {
          if (this.stopped) return;
          const result = this.write(part);
          if (result) await result;
        }
        if (this.stopped) return;
        this.items.shift(); this.bytes -= item.bytes;
      }
    } catch (error) { if (!this.stopped) this.fail(error instanceof Error ? error : new Error(String(error))); }
    finally { this.running = false; }
  }
}
