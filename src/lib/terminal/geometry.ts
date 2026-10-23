import { Terminal, type ITerminalOptions, type ITerminalInitOnlyOptions } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { decideFitHysteresis } from './fitHysteresis';
import { shouldPreserveBottomAfterFit } from './refreshRedraw';
import { repairXtermBufferInvariants } from './xtermBufferInvariant';
import type { TerminalSize } from './resizeSync';
import { ensureTerminalFontsReady } from './fontLoading';

export type TerminalGeometryPhase = 'initialize' | 'reveal' | 'update';
type BrowserTerminalOptions = ITerminalOptions & ITerminalInitOnlyOptions;

/** Single browser construction boundary. Options containing font estimates
 * are evaluated only after fonts load. Cancellation creates no stale xterm.
 */
export async function createBrowserTerminal(
  options: BrowserTerminalOptions | (() => BrowserTerminalOptions),
  current: () => boolean = () => true,
): Promise<Terminal | null> {
  await ensureTerminalFontsReady();
  if (!current()) return null;
  return new Terminal(typeof options === 'function' ? options() : options);
}

/** Owns local geometry for every browser terminal, including shared viewers.
 * Initialization may measure an offscreen layout box. Reveal is synchronous
 * and never waits for a remote redraw. Only callers decide whether a measured
 * size may be sent to the server; measurement itself performs no network I/O.
 */
export class TerminalGeometry {
  private measured: TerminalSize | null = null;

  constructor(
    private readonly terminal: Terminal,
    private readonly fitAddon: Pick<FitAddon, 'proposeDimensions'>,
    private readonly container: HTMLElement,
    private readonly options: { authority: 'viewport' | 'server'; beforeLiveResize?: () => void },
  ) {}

  /** Constructor defaults and estimates are never advertised as measurements. */
  get dimensions(): TerminalSize | null {
    return this.measured && this.measured.cols === this.terminal.cols && this.measured.rows === this.terminal.rows
      ? { ...this.measured } : null;
  }

  fit(phase: TerminalGeometryPhase, visible: boolean, reason: string = phase) {
    if (this.options.authority === 'server') return null;
    if (!visible && phase !== 'initialize') return null;
    const rect = this.container.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) return null;
    const proposed = this.fitAddon.proposeDimensions();
    if (!validSize(proposed)) return null;
    const terminal = this.terminal;
    const before = { cols: terminal.cols, rows: terminal.rows };
    const effectivePhase = this.measured ? phase : 'initialize';
    const hysteresis = decideFitHysteresis({
      reason: effectivePhase === 'initialize' ? 'init-fit' : effectivePhase === 'reveal' ? 'layout-visible' : reason,
      currentCols: before.cols, currentRows: before.rows,
      proposedCols: proposed.cols, proposedRows: proposed.rows,
    });
    const repairedBeforeResize = repairXtermBufferInvariants(terminal, before.rows);
    let repairedAfterResize = 0;
    if (hysteresis.accept) {
      // A hidden/first surface has no visible frame worth preserving.
      if (effectivePhase === 'update') this.options.beforeLiveResize?.();
      const buffer = terminal.buffer.active;
      const preserveBottom = shouldPreserveBottomAfterFit(buffer.type, buffer.baseY, buffer.viewportY);
      const smoothScrollDuration = terminal.options.smoothScrollDuration;
      try {
        terminal.options.smoothScrollDuration = 0;
        terminal.resize(proposed.cols, proposed.rows);
        repairedAfterResize = repairXtermBufferInvariants(terminal, proposed.rows);
        if (preserveBottom) terminal.scrollToBottom();
      } finally { terminal.options.smoothScrollDuration = smoothScrollDuration; }
    }
    if (repairedBeforeResize || repairedAfterResize) terminal.refresh(0, terminal.rows - 1);
    const next = { cols: terminal.cols, rows: terminal.rows };
    this.measured = next;
    return {
      reason, backend: 'xterm', width: Math.round(rect.width), height: Math.round(rect.height),
      before, proposed, next, hysteresis, repairedBeforeResize, repairedAfterResize,
      changed: before.cols !== next.cols || before.rows !== next.rows,
    };
  }

  /** Read-only viewers follow the server grid and scale its surface locally.
   * They must never fit that grid to their own window or claim resize rights.
   */
  applyRemoteSize(size: unknown): boolean {
    if (this.options.authority !== 'server' || !validSize(size)) return false;
    this.terminal.resize(size.cols, size.rows);
    this.measured = null;
    return true;
  }
}

function validSize(size: unknown): size is TerminalSize {
  const value = size as Partial<TerminalSize> | null | undefined;
  return !!value && Number.isSafeInteger(value.cols) && Number.isSafeInteger(value.rows)
    && value.cols! > 0 && value.rows! > 0;
}
