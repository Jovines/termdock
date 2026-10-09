export type ComputerKeyEvent = [number, string | null, boolean];

/** IME/paste commits may contain hundreds of characters. Keep them ordered
 * without flooding the shared encrypted packet queue in one event turn. */
export function computerKeyQueue(send: (event: ComputerKeyEvent) => void) {
  let events: ComputerKeyEvent[] = [], frame: number | null = null;
  const held = new Map<number, ComputerKeyEvent>();
  const drain = () => {
    frame = null;
    events.splice(0, 32).forEach(event => {
      send(event);
      if (event[2]) held.set(event[0], event);
      else held.delete(event[0]);
    });
    if (events.length) frame = requestAnimationFrame(drain);
  };
  return {
    send(keys: ComputerKeyEvent[]) { events.push(...keys); if (frame === null) drain(); },
    clear() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null; events = [];
      const releases = [...held.values()].reverse(); held.clear();
      for (const [key, code] of releases) {
        try { send([key, code, false]); } catch { /* Cleanup must continue after a transport closes. */ }
      }
    },
  };
}
