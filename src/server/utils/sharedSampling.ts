/** Bounded snapshots with one refresh per key, including forced refreshes.
 * Failures are never cached; a later observation can retry immediately. */
export class SharedSnapshotCache<K, V> {
  private readonly entries = new Map<K, { value: V; at: number }>();
  private readonly pending = new Map<K, Promise<V>>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 256) {}

  get(key: K, load: () => Promise<V>, refresh = false): Promise<V> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const entry = this.entries.get(key);
    if (!refresh && entry && Date.now() - entry.at < this.ttlMs) return Promise.resolve(entry.value);
    const promise = Promise.resolve().then(load).then(value => {
      this.entries.delete(key);
      this.entries.set(key, { value, at: Date.now() });
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      return value;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }
}

export interface SampleEvent { type: string; [key: string]: unknown }

/** One non-overlapping sampler per session. Observers receive a full initial
 * snapshot and subsequent changes, including observers joining during a poll. */
export class SharedSessionSampler {
  private readonly observers = new Set<(event: SampleEvent) => void>();
  private readonly latest = new Map<string, { event: SampleEvent; signature: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private epoch = 0;

  constructor(
    private readonly sample: () => Promise<SampleEvent[]>,
    private readonly intervalMs: () => number,
    private readonly onError: (error: unknown) => void,
  ) {}

  subscribe(observer: (event: SampleEvent) => void): () => void {
    this.observers.add(observer);
    for (const { event } of this.latest.values()) observer(event);
    if (!this.timer) {
      this.timer = setInterval(() => { void this.poll(); }, this.intervalMs());
      this.timer.unref?.();
      void this.poll();
    }
    return () => {
      this.observers.delete(observer);
      if (this.observers.size === 0) this.stop();
    };
  }

  stop(): void {
    this.epoch += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.latest.clear();
    this.observers.clear();
  }

  private poll(): Promise<void> {
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    this.pending = Promise.resolve().then(this.sample).then(events => {
      if (epoch !== this.epoch) return;
      for (const event of events) {
        const signature = JSON.stringify(event);
        if (this.latest.get(event.type)?.signature === signature) continue;
        this.latest.set(event.type, { event, signature });
        for (const observer of this.observers) {
          try { observer(event); } catch (error) { this.onError(error); }
        }
      }
    }).catch(this.onError).finally(() => { this.pending = null; });
    return this.pending;
  }
}
