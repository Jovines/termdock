import type { CollaborationStore, CollaborationMessage } from './collaborationStore.js';
import type { CollaborationRouteState } from './collaborationRouting.js';

export interface CollaborationRoute {
  state: CollaborationRouteState;
  reason?: string;
  write?: (messages: CollaborationMessage[]) => Promise<void>;
  /** Best-effort capture of the recipient terminal after a successful write. */
  capture?: () => Promise<string>;
  /** History-inclusive capture used to confirm the agent actually rendered a
   *  first delivery (its transcript contains our message) instead of a boot
   *  sequence wiping it. Absent on routes without terminal access. */
  confirm?: () => Promise<string | null>;
  /** Dismiss an interactive approval dialog on the recipient pane (Enter on
   *  the highlighted option). Returns false when no dialog is showing. */
  approve?: () => Promise<boolean>;
}

export class CollaborationDeliveryWorker {
  private running = new Map<string, Promise<void>>();
  private states = new Map<string, { state: CollaborationRouteState; reason: string | null; checkedAt: number }>();
  private failures = new Map<string, number>();
  private submitted = new Set<string>();
  /** Sessions whose first delivery was confirmed consumed (or settled) in
   *  this process. Only first deliveries pass the confirm gate — a write to
   *  an agent that has been interacting is consumed by definition of pty
   *  semantics, and every delivery after the first rides that assumption. */
  private confirmedSessions = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;

  constructor(private readonly options: {
    store: CollaborationStore;
    peers: () => string[];
    isLocal: (id: string) => boolean;
    resolve: (id: string) => Promise<CollaborationRoute>;
    onError: (error: unknown) => void;
    /** First-delivery confirmation delay: after writing to a session whose
     *  first delivery is still unsettled, wait this long and check the
     *  recipient's terminal history for our message before marking it
     *  delivered. 0 disables the gate; routes without `confirm` (no terminal
     *  access) are unaffected either way. */
    firstDeliveryConfirmMs?: number;
    /** Total write attempts a first delivery may take while unconfirmed.
     *  After this many writes the message settles as delivered regardless —
     *  the gate tightens the boot window, never wedges the queue. */
    maxUnconfirmedWrites?: number;
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
    const attempts = store.diagnostic(message.id)?.attempt_count ?? 0;
    if (!this.submitted.has(message.id)) {
      store.recordTransport(message.id, {
        relay_online: null, peer_reachable: true,
        attempt_count: attempts + 1,
        next_retry_at: Date.now() + 2_000, last_error: 'DELIVERY_IN_PROGRESS', checked_at: Date.now(),
      });
      try { await route.write(pending); }
      catch (error) {
        this.retry(id, pending, `TERMINAL_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`, true);
        return;
      }
      this.submitted.add(message.id);
      // Capture the recipient terminal before marking delivered, so a sender
      // waiting on delivered always finds the snapshot present. The capture is
      // strictly best-effort: a failure must never block delivery completion.
      if (route.capture) {
        try {
          const snapshot = await route.capture();
          if (snapshot) store.setSnapshot(message.id, snapshot);
        } catch { /* best-effort */ }
      }
    }
    // First-delivery confirm gate: the route becoming ready only proves the
    // agent process is up, not that its TUI is reading — a write inside the
    // boot window can be wiped by the startup clear while the message is
    // already marked delivered. When the route can read terminal history,
    // hold the first delivery until our message actually appears there (the
    // agent rendered it), dismissing any approval dialog blocking the agent
    // on the way. Unconfirmed writes are re-attempted up to the configured
    // bound; at-least-once transport is preserved throughout.
    const confirmMs = this.options.firstDeliveryConfirmMs ?? 1_500;
    if (route.confirm && confirmMs > 0 && !this.confirmedSessions.has(id)
      && attempts + 1 < (this.options.maxUnconfirmedWrites ?? 3)) {
      if (!(await this.confirmConsumed(pending, route, confirmMs))) {
        this.submitted.delete(message.id);
        store.recordTransport(message.id, {
          relay_online: null, peer_reachable: true,
          attempt_count: attempts + 1,
          next_retry_at: Date.now() + 4_000, last_error: 'AGENT_CONSUME_UNCONFIRMED', checked_at: Date.now(),
        });
        this.failures.delete(id);
        return;
      }
    }
    // If persistence fails after writing, the in-process guard avoids a
    // second write on retry. Across a crash, transport is at-least-once.
    this.complete(id, message);
  }

  /** Wait out the confirm window, then look for the written messages in the
   *  recipient's terminal history. While the agent is blocked on an approval
   *  dialog (its first Bash call needs permission) dismiss it once per cycle
   *  — the delivery itself told the agent to run td collab, and the pane
   *  must show an actual dialog for the key to be sent. */
  private async confirmConsumed(
    messages: CollaborationMessage[],
    route: CollaborationRoute,
    delayMs: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? delayMs : Math.min(1_200, delayMs)));
      let content: string | null = null;
      try { content = await route.confirm!(); } catch { content = null; }
      if (content && messages.some((message) => content.includes(message.id))) return true;
      if (content && route.approve) {
        try { await route.approve(); } catch { /* a failed dismiss must not settle delivery */ }
      }
    }
    return false;
  }

  private complete(id: string, message: CollaborationMessage): void {
    const { store } = this.options;
    this.confirmedSessions.add(id);
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
