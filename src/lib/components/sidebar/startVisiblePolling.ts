/** Keep periodic refreshes from waking a hidden document. Poll immediately on
 * visibility restoration and selected lifecycle events. */
export function startVisiblePolling(poll: () => void, intervalMs: number, wakeEvents: string[] = []): () => void {
  let timer: number | undefined;
  const run = () => { if (!document.hidden) poll(); };
  const stop = () => {
    if (timer === undefined) return;
    window.clearInterval(timer);
    timer = undefined;
  };
  const onVisibilityChange = () => {
    stop();
    if (document.hidden) return;
    run();
    timer = window.setInterval(run, intervalMs);
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  for (const event of wakeEvents) window.addEventListener(event, run);
  onVisibilityChange();
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    for (const event of wakeEvents) window.removeEventListener(event, run);
  };
}
