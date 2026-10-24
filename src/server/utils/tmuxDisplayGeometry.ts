import type { TerminalClientAttachment } from './terminalClientAttachment.js';
import { claimTmuxSize } from './tmuxSizeOwnership.js';
import { readTmuxObserverSize, retainTmuxObserverSize } from './tmuxObserverSize.js';

type Size = { cols: number; rows: number };
type Observer = Size & { ptyProcess: { pid?: number; resize(cols: number, rows: number): void } };

/** All tmux display entries use this owner/observer transaction. Resizing a
 * display without its observer makes refreshing the page shrink the window.
 * The session's existing I/O queue serializes these operations across clients.
 */
export class TmuxDisplayGeometry {
  private current: Size;

  constructor(
    private readonly observer: Observer,
    private readonly run: (args: string[]) => Promise<string>,
    private readonly sessionName: string,
    private readonly displayPids: () => ReadonlySet<number>,
    private readonly initialSize?: Size,
  ) { this.current = { cols: initialSize?.cols ?? observer.cols, rows: initialSize?.rows ?? observer.rows }; }

  get size(): Size { return { cols: this.current.cols, rows: this.current.rows }; }
  readServerSize(): Promise<Size> { return readTmuxObserverSize(this.run, this.sessionName); }

  async prepareAttach(size: Size, supportsOwnership: boolean): Promise<void> {
    const clients = (await this.run(['list-clients', '-t', this.sessionName, '-F', '#{client_pid} #{client_tty} #{client_flags}']))
      .split('\n').map(line => line.trim().split(/\s+/));
    const metadata = clients.find(([pid]) => pid === String(this.observer.ptyProcess.pid));
    if (metadata?.[1] && supportsOwnership) {
      await this.run(['refresh-client', '-t', metadata[1], '-f', 'ignore-size']);
    }
    const hasSizeOwner = clients.some(([pid, tty, flags]) => tty && pid !== String(this.observer.ptyProcess.pid)
      && !flags?.split(',').includes('ignore-size'));
    if (this.initialSize && supportsOwnership && !hasSizeOwner) retainTmuxObserverSize(this.observer, size.cols, size.rows);
  }

  async resize(display: TerminalClientAttachment, requested: Size, supportsOwnership: boolean) {
    if (!display.attached || !Number.isFinite(requested.cols) || !Number.isFinite(requested.rows) || requested.cols < 1 || requested.rows < 1) {
      return { ok: false, ...this.size, redraw: false, changed: false };
    }
    const size = { cols: Math.floor(requested.cols), rows: Math.floor(requested.rows) };
    const same = this.current.cols === size.cols && this.current.rows === size.rows;
    const server = await this.readServerSize();
    const serverMatches = server.cols === size.cols && server.rows === size.rows;
    if (same && serverMatches) {
      retainTmuxObserverSize(this.observer, size.cols, size.rows);
      return { ok: true, ...this.size, redraw: false, changed: false };
    }
    if (supportsOwnership && !serverMatches) await claimTmuxSize(this.run, this.sessionName, display.pid, this.displayPids());
    const ok = same ? display.attached : display.resize(size.cols, size.rows);
    if (!ok) return { ok: false, ...this.size, redraw: false, changed: false };
    retainTmuxObserverSize(this.observer, size.cols, size.rows);
    this.current = size;
    return { ok: true, ...this.size, redraw: false, changed: !serverMatches };
  }
}
