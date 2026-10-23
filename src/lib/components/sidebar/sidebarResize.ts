import { observeDragLifetime } from '../../gesture/dragLifetime';

/** Keep pointer tracking out of React/global persistence; commit once on release. */
export function beginSidebarResize(panel: HTMLElement, startX: number, startWidth: number,
  clamp: (width: number) => number, commit: (width: number) => void, direction: 1 | -1 = 1): () => void {
  let latestX = startX;
  let frame: number | null = null;
  let finished = false;
  const originalWidth = panel.style.width;
  const cursor = document.body.style.cursor;
  const userSelect = document.body.style.userSelect;
  const width = () => clamp(startWidth + (latestX - startX) * direction);
  const paint = () => { frame = null; panel.style.width = `${width()}px`; };
  const move = (event: MouseEvent) => {
    latestX = event.clientX;
    if (frame === null) frame = requestAnimationFrame(paint);
  };
  const finish = (save: boolean) => {
    if (finished) return;
    finished = true;
    window.removeEventListener('mousemove', move);
    stopLifetime();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = userSelect;
    if (save) { paint(); if (width() !== startWidth) commit(width()); }
    else panel.style.width = originalWidth;
  };
  const stopLifetime = observeDragLifetime({ onFinish: (reason, event) => {
    if (reason === 'release' && event) latestX = event.clientX;
    finish(reason !== 'dispose' && reason !== 'escape');
  } });
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', move);
  return () => finish(false);
}
