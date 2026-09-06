import type { Terminal } from '@xterm/xterm';

interface Renderer {
  handleResize(cols: number, rows: number): void;
  renderRows(start: number, end: number): void;
  clear(): void;
}

type RenderInternals = {
  _core?: { _renderService?: { _renderer?: { value?: Renderer } } };
};

/**
 * xterm's synchronized output protects row painting, but not handleResize:
 * WebGL clears its canvas and DOM removes rows immediately. Keep the existing
 * surface until the next parsed tmux frame, then resize and repaint together.
 * This only fences local reflow; a tmux frame is not an application-ready signal.
 * All model resizes and PTY requests still happen at their original time.
 * Keep the dependency on xterm's renderer slot isolated here and fail open if
 * an upgraded xterm changes that interface.
 */
export function createResizePresentation(terminal: Terminal) {
  let restore: (() => void) | undefined;
  let geometry: [number, number] | undefined;
  let frameEnded = false;
  let generation = 0;
  const endFrame = terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
    if (restore && params.some(value => value === 2026)) frameEnded = true;
    return false;
  });

  const finish = (paint: boolean) => {
    const undo = restore;
    if (!undo) return;
    const size = geometry;
    restore = undefined;
    geometry = undefined;
    frameEnded = false;
    undo();
    if (paint) {
      const renderer = (terminal as unknown as RenderInternals)._core?._renderService?._renderer?.value;
      // Resizing WebGL can request an immediate redraw itself. Restore all
      // methods first so that redraw uses the newly parsed model in this task.
      if (size) renderer?.handleResize(...size);
      renderer?.renderRows(0, terminal.rows - 1);
      terminal.refresh(0, terminal.rows - 1);
    }
  };

  return {
    begin() {
      generation++;
      frameEnded = false;
      if (restore) return;
      const renderer = (terminal as unknown as RenderInternals)._core?._renderService?._renderer?.value;
      if (!renderer || typeof renderer.handleResize !== 'function'
        || typeof renderer.renderRows !== 'function' || typeof renderer.clear !== 'function') return;
      const resize = renderer.handleResize;
      const render = renderer.renderRows;
      const clear = renderer.clear;
      renderer.handleResize = (cols, rows) => { geometry = [cols, rows]; };
      renderer.renderRows = () => {};
      renderer.clear = () => {};
      restore = () => {
        renderer.handleResize = resize;
        renderer.renderRows = render;
        renderer.clear = clear;
      };
    },
    get generation() { return generation; },
    written(writeGeneration: number) {
      if (writeGeneration === generation && frameEnded && !terminal.modes.synchronizedOutputMode) {
        finish(true);
      }
    },
    cancel() { finish(true); },
    dispose() { finish(false); endFrame.dispose(); },
  };
}
