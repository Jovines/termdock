import type { CollaborationStore, CollaborationMessage } from './collaborationStore.js';
import type { CollaborationRouteState } from './collaborationRouting.js';

export interface CollaborationRoute {
  state: CollaborationRouteState;
  reason?: string;
  write?: (messages: CollaborationMessage[]) => Promise<void>;
}

export class CollaborationDeliveryWorker {
  private running = new Map<string, Promise<void>>();
  private states = new Map<string, { state: CollaborationRouteState; reason: string | null; checkedAt: number }>();
  private failures = new Map<string, number>();
  private submitted = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;

  constructor(private readonly options: {
    store: CollaborationStore;
    peers: () => string[];
    isLocal: (id: string) => boolean;
    resolve: (id: string) => Promise<CollaborationRoute>;
    onError: (error: unknown) => void;
  }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 2_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(id: string) {
    const state = this.states.get(id);
    return state && Date.now() - state.checkedAt < 15_000 ? state
      : { state: 'recovering' as const, reason: 'ROUTE_NOT_CHECKED', checkedAt: state?.checkedAt ?? null };
  }

  wake(id: string): void {
    void this.run(id).catch(this.options.onError);
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.tickOnce().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    try {
      const ids = [...new Set([...this.options.peers(), ...this.options.store.pendingRecipients()])].filter(this.options.isLocal);
      // Bound process probes/attachments while keeping a broken peer from
      // serially blocking the entire queue.
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (cursor < ids.length) await this.run(ids[cursor++]!).catch(this.options.onError);
      }));
    } catch (error) { this.options.onError(error); }
  }

  run(id: string): Promise<void> {
    const running = this.running.get(id);
    if (running) return running;
    if (!this.options.isLocal(id)) return Promise.resolve();
    const operation = Promise.resolve().then(() => this.deliver(id)).finally(() => {
      if (this.running.get(id) === operation) this.running.delete(id);
    });
    this.running.set(id, operation);
    return operation;
  }

  reconfigure(id: string, configure: () => Promise<void>): Promise<void> {
    const previous = this.running.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await configure();
      this.failures.delete(id);
      this.states.delete(id);
      for (const message of this.options.store.inbox(id, { pendingOnly: true, limit: 200 })) {
        const diagnostic = this.options.store.diagnostic(message.id);
        if (diagnostic) this.options.store.recordTransport(message.id, { ...diagnostic, next_retry_at: null, last_error: null });
      }
    }).finally(() => {
      if (this.running.get(id) === operation) this.running.delete(id);
    });
    this.running.set(id, operation);
    return operation;
  }

  private async deliver(id: string): Promise<void> {
    const { store } = this.options;
    const first = store.inbox(id, { pendingOnly: true, limit: 1 })[0];
    if (!first && Date.now() - (this.states.get(id)?.checkedAt ?? 0) < 5_000) return;
    if (first && this.submitted.has(first.id)) {
      this.complete(id, first);
      return;
    }
    if (first && (store.diagnostic(first.id)?.next_retry_at ?? 0) > Date.now()) return;
    this.states.set(id, { state: 'recovering', reason: null, checkedAt: Date.now() });
    let route: CollaborationRoute;
    try { route = await this.options.resolve(id); }
    catch (error) { route = { state: 'unavailable', reason: `ROUTE_RECOVERY_FAILED: ${error instanceof Error ? error.message : String(error)}` }; }
    this.states.set(id, { state: route.state, reason: route.reason ?? null, checkedAt: Date.now() });
    // Re-read after asynchronous recovery: a consumer may have read the
    // message, or its TTL may have elapsed while tmux was being inspected.
    const pending = store.inbox(id, { pendingOnly: true, limit: 1 });
    if (!pending.length) return;
    if (route.state !== 'ready' || !route.write) {
      this.retry(id, pending, route.reason ?? route.state, false);
      return;
    }
    const message = pending[0]!;
    if (!this.submitted.has(message.id)) {
      store.recordTransport(message.id, {
        relay_online: null, peer_reachable: true,
        attempt_count: (store.diagnostic(message.id)?.attempt_count ?? 0) + 1,
        next_retry_at: Date.now() + 2_000, last_error: 'DELIVERY_IN_PROGRESS', checked_at: Date.now(),
      });
      try { await route.write(pending); }
      catch (error) {
        this.retry(id, pending, `TERMINAL_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`, true);
        return;
      }
      this.submitted.add(message.id);
    }
    // If persistence fails after writing, the in-process guard avoids a
    // second write on retry. Across a crash, transport is at-least-once.
    this.complete(id, message);
  }

  private complete(id: string, message: CollaborationMessage): void {
    const { store } = this.options;
    store.markDelivered([message.id]);
    this.submitted.delete(message.id);
    store.recordTransport(message.id, {
      relay_online: null, peer_reachable: true, attempt_count: store.diagnostic(message.id)?.attempt_count ?? 1,
      next_retry_at: null, last_error: null, checked_at: Date.now(),
    });
    this.failures.delete(id);
  }

  private retry(id: string, messages: CollaborationMessage[], reason: string, reachable: boolean): void {
    const failures = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, failures);
    const next = Date.now() + Math.min(30_000, 2_000 * 2 ** Math.min(failures - 1, 4));
    for (const message of messages) this.options.store.recordTransport(message.id, {
      relay_online: null, peer_reachable: reachable,
      attempt_count: this.options.store.diagnostic(message.id)?.attempt_count ?? 0,
      next_retry_at: next, last_error: reason, checked_at: Date.now(),
    });
  }
}
