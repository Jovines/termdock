/** Terminal byte activity only; no agent hooks, transcript inspection or polling. */
export const OUTPUT_START_DELAY_MS = 2_000;
export const OUTPUT_START_RECENCY_MS = 500;
export const OUTPUT_IDLE_MS = 2_000;

export class TerminalOutputActivity {
  private phase: 'idle' | 'pending' | 'active' = 'idle';
  private lastOutput = 0;
  private deadline = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly publish: (active: boolean) => void, private readonly now = () => performance.now()) {}

  get active(): boolean {
    // A delayed event loop must not put an expired value in a reconnect snapshot.
    this.settle();
    return this.phase === 'active';
  }

  record(): void {
    if (this.disposed) return;
    // Expire the previous window before accepting a packet after a long stall.
    this.settle();
    this.lastOutput = this.now();
    if (this.phase === 'idle') {
      this.phase = 'pending';
      this.deadline = this.lastOutput + OUTPUT_START_DELAY_MS;
      this.schedule(this.deadline);
    }
    // Active/pending windows retain one timer; packets only update this number.
  }

  dispose(): void {
    this.disposed = true;
    this.phase = 'idle';
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private settle(): void {
    if (this.disposed || this.phase === 'idle') return;
    const now = this.now();
    if (this.phase === 'pending') {
      if (now < this.deadline) return;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      if (now - this.lastOutput > OUTPUT_START_RECENCY_MS) {
        this.phase = 'idle';
        return;
      }
      this.phase = 'active';
      this.schedule(this.lastOutput + OUTPUT_IDLE_MS);
      this.publish(true);
    } else if (now - this.lastOutput >= OUTPUT_IDLE_MS) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      this.phase = 'idle';
      this.publish(false);
    }
  }

  private schedule(deadline: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.settle();
      if (this.phase === 'active' && this.timer === undefined) this.schedule(this.lastOutput + OUTPUT_IDLE_MS);
    }, Math.max(1, deadline - this.now()));
    this.timer.unref?.();
  }
}
