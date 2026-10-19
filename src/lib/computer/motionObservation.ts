import type { ComputerPointer } from './pointer';
import type { ComputerMotionTrace } from './motionTrace';

/** Passive diagnostics only. Never cancel, capture, synthesize or route input.
 * Run frame observation only while a finger/pen is down, and read inline
 * cursor styles rather than forcing layout in the movement path. */
export function observeComputerMotion(viewport: HTMLElement, pointer: ComputerPointer, trace: ComputerMotionTrace): () => void {
  const controller = new AbortController();
  const pointers = new Set<number>(), touches = new Set<number>();
  let frame: number | undefined, previousFrame: number | undefined, stopped = false;
  let lastInputTime = performance.now();
  const active = () => pointers.size > 0 || touches.size > 0;
  const observeFrame = (time: number) => {
    frame = undefined;
    if (stopped || !active()) return;
    if (performance.now() - lastInputTime > 1000) return;
    trace.record('browser-frame', { time, interval: previousFrame === undefined ? null : time - previousFrame,
      logical: pointer.position?.(), renderer: pointer.observeCursor?.() });
    previousFrame = time; frame = requestAnimationFrame(observeFrame);
  };
  const schedule = () => {
    if (active()) { if (frame === undefined) { previousFrame = undefined; frame = requestAnimationFrame(observeFrame); } }
    else { if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; previousFrame = undefined; }
  };
  const pointerEvent = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    lastInputTime = performance.now();
    if (event.type === 'pointerdown') pointers.add(event.pointerId);
    else if (event.type === 'pointerup' || event.type === 'pointercancel' || event.type === 'lostpointercapture') pointers.delete(event.pointerId);
    const samples = event.getCoalescedEvents?.() ?? [];
    trace.record('raw-pointer', { type: event.type, time: event.timeStamp, id: event.pointerId,
      pointerType: event.pointerType, client: [event.clientX, event.clientY], trusted: event.isTrusted,
      coalesced: samples.slice(-16).map(sample => [sample.timeStamp, sample.clientX, sample.clientY]) });
    schedule();
  };
  const touchEvent = (event: TouchEvent) => {
    lastInputTime = performance.now();
    touches.clear(); for (const touch of Array.from(event.touches)) touches.add(touch.identifier);
    trace.record('raw-touch', { type: event.type, time: event.timeStamp, trusted: event.isTrusted,
      touches: Array.from(event.touches, touch => [touch.identifier, touch.clientX, touch.clientY]),
      changed: Array.from(event.changedTouches, touch => [touch.identifier, touch.clientX, touch.clientY]) });
    schedule();
  };
  const options = { capture: true, passive: true, signal: controller.signal };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(type, pointerEvent as EventListener, options);
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) viewport.addEventListener(type, touchEvent as EventListener, options);
  trace.record('observation-start', { version: 2, pointerEvents: typeof PointerEvent !== 'undefined', touchEvents: 'ontouchstart' in window });
  return () => {
    stopped = true; controller.abort(); if (frame !== undefined) cancelAnimationFrame(frame);
    trace.record('observation-stop'); trace.flush('observation-stop');
  };
}
