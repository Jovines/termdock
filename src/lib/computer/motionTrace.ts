import { clientLog } from '../utils/clientLog';

export interface ComputerMotionTrace {
  record(event: string, data?: Record<string, unknown>): void;
  flush(reason: string): void;
  dispose(): void;
}

/** Opt in for one browser session, then reopen the computer tab to collect.
 * sessionStorage['termdock:computer-motion-trace'] = '1'
 * Disabled sessions create no observers, per-frame records, or uploads. */
export function createComputerMotionTraceIfEnabled(): ComputerMotionTrace | undefined {
  try {
    if (sessionStorage.getItem('termdock:computer-motion-trace') === '1') return createComputerMotionTrace();
  } catch { /* Diagnostics remain off when storage is unavailable. */ }
  return undefined;
}

/** Temporary device diagnostics: coordinates only, no desktop images or text.
 * Keep the input path in memory; upload after a gesture/idle, with bounded size. */
export function createComputerMotionTrace(): ComputerMotionTrace {
  const started = performance.now(), expires = started + 15 * 60_000;
  const id = `motion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let samples: Array<[number, string, Record<string, unknown>]> = [];
  let dropped = 0, sequence = 0, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (reason: string) => {
    clearTimeout(timer); timer = undefined;
    if (!samples.length) return;
    const batch = samples; samples = [];
    // Keep each keepalive request comfortably below the browser's 64 KiB cap.
    for (let offset = 0; offset < batch.length; offset += 64) {
      clientLog('info', 'COMPUTER_MOTION_TRACE', { version: 2, id, sequence: ++sequence,
        startedAt: performance.timeOrigin + started, reason, dropped: offset ? 0 : dropped,
        samples: batch.slice(offset, offset + 64) });
    }
    dropped = 0;
  };
  return {
    record(event, data = {}) {
      if (disposed) return;
      const elapsed = performance.now() - started;
      if (performance.now() >= expires) { flush('expired'); disposed = true; return; }
      // Retain the beginning and the newest tail if a gesture is very long.
      if (samples.length >= 8192) { samples.splice(2048, 1); dropped++; }
      samples.push([Math.round(elapsed * 10) / 10, event, data]);
      clearTimeout(timer); timer = setTimeout(() => flush('idle'), 750);
    },
    flush,
    dispose() { if (!disposed) { disposed = true; flush('dispose'); } },
  };
}
