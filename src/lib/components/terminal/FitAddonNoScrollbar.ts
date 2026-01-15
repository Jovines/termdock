import type { ITerminalAddon, ITerminalCore } from 'ghostty-web';

// Constants - No scrollbar reservation
const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;
const RESIZE_DEBOUNCE_MS = 100;

export interface ITerminalDimensions {
  cols: number;
  rows: number;
}

export class FitAddonNoScrollbar implements ITerminalAddon {
  private _terminal?: ITerminalCore;
  private _resizeObserver?: ResizeObserver;
  private _resizeDebounceTimer?: ReturnType<typeof setTimeout>;
  private _lastCols?: number;
  private _lastRows?: number;
  private _isResizing: boolean = false;

  public activate(terminal: ITerminalCore): void {
    this._terminal = terminal;
  }

  public dispose(): void {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = undefined;
    }
    if (this._resizeDebounceTimer) {
      clearTimeout(this._resizeDebounceTimer);
      this._resizeDebounceTimer = undefined;
    }
    this._lastCols = undefined;
    this._lastRows = undefined;
    this._terminal = undefined;
  }

  public fit(): void {
    if (this._isResizing) {
      return;
    }

    const dims = this.proposeDimensions();
    if (!dims || !this._terminal) {
      return;
    }

    const terminal = this._terminal as any;
    const currentCols = terminal.cols;
    const currentRows = terminal.rows;

    if (
      (dims.cols === this._lastCols && dims.rows === this._lastRows) ||
      (dims.cols === currentCols && dims.rows === currentRows)
    ) {
      return;
    }

    this._lastCols = dims.cols;
    this._lastRows = dims.rows;
    this._isResizing = true;

    try {
      if (terminal.resize && typeof terminal.resize === 'function') {
        terminal.resize(dims.cols, dims.rows);
      }
    } finally {
      setTimeout(() => {
        this._isResizing = false;
      }, 50);
    }
  }

  public proposeDimensions(): ITerminalDimensions | undefined {
    if (!this._terminal?.element) {
      return undefined;
    }

    const terminal = this._terminal as any;
    const renderer = terminal.renderer;

    if (!renderer || typeof renderer.getMetrics !== 'function') {
      return undefined;
    }

    const metrics = renderer.getMetrics();
    if (!metrics || metrics.width === 0 || metrics.height === 0) {
      return undefined;
    }

    const terminalElement = this._terminal.element;

    if (typeof terminalElement.clientWidth === 'undefined') {
      return undefined;
    }

    const elementStyle = window.getComputedStyle(terminalElement);

    const paddingTop = Number.parseInt(elementStyle.getPropertyValue('padding-top')) || 0;
    const paddingBottom = Number.parseInt(elementStyle.getPropertyValue('padding-bottom')) || 0;
    const paddingLeft = Number.parseInt(elementStyle.getPropertyValue('padding-left')) || 0;
    const paddingRight = Number.parseInt(elementStyle.getPropertyValue('padding-right')) || 0;

    const containerWidth = terminalElement.clientWidth;
    const containerHeight = terminalElement.clientHeight;

    if (containerWidth === 0 || containerHeight === 0) {
      return undefined;
    }

    // No scrollbar width reservation - use full container width
    const availableWidth = containerWidth - paddingLeft - paddingRight;
    const availableHeight = containerHeight - paddingTop - paddingBottom;

    const cols = Math.max(MINIMUM_COLS, Math.floor(availableWidth / metrics.width));
    const rows = Math.max(MINIMUM_ROWS, Math.floor(availableHeight / metrics.height));

    return { cols, rows };
  }

  public observeResize(): void {
    if (!this._terminal?.element) {
      return;
    }

    if (this._resizeObserver) {
      return;
    }

    this._resizeObserver = new ResizeObserver((entries) => {
      if (this._isResizing) {
        return;
      }

      const entry = entries[0];
      if (!entry) return;

      if (this._resizeDebounceTimer) {
        clearTimeout(this._resizeDebounceTimer);
      }

      this._resizeDebounceTimer = setTimeout(() => {
        this.fit();
      }, RESIZE_DEBOUNCE_MS);
    });

    this._resizeObserver.observe(this._terminal.element);
  }
}
