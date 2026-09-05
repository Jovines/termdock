let lastInteraction = 0;
let installed = false;
let pointers = 0;
function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const touch = () => { lastInteraction = performance.now(); };
  window.addEventListener('pointerdown', () => { pointers += 1; touch(); }, { passive: true, capture: true });
  for (const name of ['pointerup', 'pointercancel']) {
    window.addEventListener(name, () => { pointers = Math.max(0, pointers - 1); touch(); }, { passive: true, capture: true });
  }
  for (const name of ['pointermove', 'wheel', 'keydown']) window.addEventListener(name, touch, { passive: true, capture: true });
  window.addEventListener('blur', () => { pointers = 0; touch(); });
}

/** Nonessential work waits through pointer gestures and their release animation. */
export function scheduleInteractionIdle(task: () => void, delay = 500): () => void {
  install();
  let cancelled = false;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const attempt = () => {
    if (cancelled) return;
    if (pointers > 0 || performance.now() - lastInteraction < 400) {
      timer = setTimeout(attempt, 100);
      return;
    }
    const run = () => {
      if (cancelled) return;
      if (pointers > 0 || performance.now() - lastInteraction < 400) { timer = setTimeout(attempt, 100); return; }
      task();
    };
    if ('requestIdleCallback' in window) idle = window.requestIdleCallback(run);
    else timer = setTimeout(run, 16);
  };
  timer = setTimeout(attempt, delay);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
}
