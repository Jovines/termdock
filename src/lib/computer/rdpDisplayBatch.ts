interface DisplayFlush {
  flush(callback: () => void, timestamp?: number, logicalFrames?: number): void;
}

/** Draw ready updates from one transport record together. Guacamole otherwise
 * presents every sync as a separate RAF, even when all updates already arrived.
 * Preserve every drawing operation and completion callback, with bounded groups. */
export function batchRdpDisplay(display: DisplayFlush) {
  const original = display.flush;
  let remaining = 0, callbacks: Array<() => void> = [], frames = 0, cancelled = false;
  display.flush = (callback, timestamp, logicalFrames) => {
    if (!remaining) { original.call(display, callback, timestamp, logicalFrames); return; }
    remaining--; callbacks.push(callback); frames += logicalFrames || 0;
    if (remaining && callbacks.length < 64) return;
    const completed = callbacks, count = frames; callbacks = []; frames = 0;
    original.call(display, () => { if (!cancelled) completed.forEach(done => done()); }, timestamp, count);
  };
  return {
    run(deliver: () => void, syncs: number) {
      remaining = syncs;
      try { deliver(); }
      finally { remaining = 0; callbacks = []; frames = 0; }
    },
    cancel() { cancelled = true; remaining = 0; callbacks = []; display.flush = original; },
  };
}
