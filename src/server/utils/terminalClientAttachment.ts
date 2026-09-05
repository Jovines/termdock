export interface AttachedPty {
  pid?: number;
  onData(handler: (data: string) => void): { dispose(): void };
  onExit(handler: (event: { exitCode: number; signal: number | null }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** A display connection owns its PTY parser stream; the tmux task is separate.
 * Epoch checks also cover disconnect/unsubscribe while spawning asynchronously.
 */
export class TerminalClientAttachment {
  private epoch = 0;
  private process: AttachedPty | null = null;
  private subscriptions: Array<{ dispose(): void }> = [];

  constructor(
    private readonly spawn: (cols: number, rows: number) => Promise<AttachedPty>,
    private readonly onData: (data: string) => void,
    private readonly onExit: () => void,
  ) {}

  get pid(): number | undefined { return this.process?.pid; }
  get attached(): boolean { return this.process !== null; }

  async open(cols: number, rows: number): Promise<boolean> {
    this.close();
    const epoch = this.epoch;
    const process = await this.spawn(cols, rows);
    if (epoch !== this.epoch) {
      process.kill();
      return false;
    }
    this.process = process;
    this.subscriptions = [
      process.onData(data => { if (epoch === this.epoch) this.onData(data); }),
      process.onExit(() => {
        if (epoch !== this.epoch) return;
        this.process = null;
        this.disposeSubscriptions();
        this.onExit();
      }),
    ];
    return true;
  }

  write(data: string): void { this.process?.write(data); }
  resize(cols: number, rows: number): boolean {
    if (!this.process) return false;
    this.process.resize(cols, rows);
    return true;
  }

  close(): void {
    this.epoch += 1;
    this.disposeSubscriptions();
    const process = this.process;
    this.process = null;
    // This is the attached tmux CLI process, never a pane or tmux server.
    if (process) process.kill();
  }

  private disposeSubscriptions(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
  }
}
