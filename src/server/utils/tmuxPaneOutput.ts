import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** Consume protocol framing only. Never retain or decode pane contents, even
 * when tmux sends a multi-megabyte line without a newline until its end. */
export class TmuxPaneOutputParser {
  private prefix = '';
  private line: 'header' | 'output' | 'ignore' = 'header';

  feed(bytes: Buffer): boolean {
    let output = false;
    for (let start = 0; start < bytes.length;) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (this.line === 'header') {
        const fragment = bytes.subarray(start, Math.min(end, start + 64 - this.prefix.length)).toString('ascii');
        this.prefix += fragment;
        const header = /^%output %\d+ /.exec(this.prefix);
        if (header) {
          // The protocol escapes embedded newlines and backslashes; a pane
          // cannot forge a second notification inside its output payload.
          output ||= this.prefix.length > header[0].length || end - start > fragment.length;
          this.line = 'output';
          this.prefix = '';
        } else if (this.prefix.length >= 64) {
          this.line = 'ignore'; this.prefix = '';
        }
      } else if (this.line === 'output' && end > start) {
        output = true;
      }
      if (newline < 0) break;
      this.prefix = ''; this.line = 'header';
      start = newline + 1;
    }
    return output;
  }
}

/** One read-only source per backend session, shared by every browser. Control
 * mode reports actual pane writes, not attach snapshots or display redraws.
 * No PTY, resize, input, capture-pane polling or command execution is involved. */
export class TmuxPaneOutputObserver {
  private child: ChildProcess | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private failures = 0;
  private startedAt = 0;

  constructor(
    private readonly binary: string,
    private readonly target: string,
    private readonly onOutput: () => void,
    private readonly onUnavailable: () => void,
    private readonly spawnControl = (binary: string, args: string[], options: SpawnOptions): ChildProcess => spawn(binary, args, options),
  ) {}

  start(): void {
    if (this.disposed || this.child || this.retry !== undefined) return;
    this.startedAt = performance.now();
    const parser = new TmuxPaneOutputParser();
    let child: ChildProcess;
    try {
      // -r is read-only,ignore-size: this client must never take ownership of
      // the task's grid. It stays on the exact session, including hidden panes.
      const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
      child = this.spawnControl(this.binary, ['-u', '-C', 'attach-session', '-r', '-t', this.target], { stdio: ['pipe', 'pipe', 'ignore'], env });
    } catch {
      this.failed(); return;
    }
    this.child = child;
    child.stdout?.on('data', (bytes: Buffer) => {
      if (this.child === child && !this.disposed && parser.feed(bytes)) this.onOutput();
    });
    const failed = () => {
      if (this.child !== child || this.disposed) return;
      this.child = null;
      child.stdout?.removeAllListeners('data');
      child.stdin?.destroy();
      child.kill();
      this.failed();
    };
    child.stdout?.once('error', failed);
    child.once('error', failed);
    child.once('exit', failed);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
    const child = this.child; this.child = null;
    child?.stdout?.removeAllListeners('data');
    child?.stdin?.destroy();
    // Kill only this control client; never the pane, session or tmux server.
    child?.kill();
  }

  private failed(): void {
    if (this.disposed) return;
    this.onUnavailable();
    if (performance.now() - this.startedAt >= 5_000) this.failures = 0;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.failures++, 5));
    this.retry = setTimeout(() => { this.retry = undefined; this.start(); }, delay);
    this.retry.unref?.();
  }
}
