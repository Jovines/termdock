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
  /** Submit a paste that arrived during the agent's turn handover and still
   *  sits unsubmitted in its input box. Only acts on differential evidence —
   *  a paste marker that appeared since the write-time baseline — so stale
   *  markers or foreign drafts are never submitted. Returns whether Enter
   *  was sent. */
  recoverStuck?: (baseline: string) => Promise<boolean>;
}

export class CollaborationDeliveryWorker {
  private running = new Map<string, Promise<void>>();
  private states = new Map<string, { state: CollaborationRouteState; reason: string | null; checkedAt: number }>();
  private failures = new Map<string, number>();
  private submitted = new Set<string>();
  /** Sessions whose latest delivery was confirmed rendered in this process,
   *  mapped to the timestamp until which confirmations are skipped. A recent
   *  confirmed delivery means the agent is actively consuming input, so
   *  follow-up messages settle immediately; once the cooldown lapses the
   *  agent's state is unknown again (it may be mid-turn, or finishing one)
   *  and the gate re-engages. Settled-but-unconfirmed deliveries never grant
   *  cooldown — that would re-open the turn-handover hole the gate closes. */
  private confirmedUntil = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;

  constructor(private readonly options: {
    store: CollaborationStore;
    peers: () => string[];
    isLocal: (id: string) => boolean;
    resolve: (id: string) => Promise<CollaborationRoute>;
    onError: (error: unknown) => void;
    /** Confirmation delay: after writing to a session outside its confirm
     *  cooldown, wait this long and check the recipient's terminal history
     *  for our message before marking it delivered. 0 disables the gate;
     *  routes without `confirm` (no terminal access) are unaffected. */
    firstDeliveryConfirmMs?: number;
    /** Total write attempts a delivery may take while unconfirmed. After
     *  this many writes the message settles as delivered regardless — the
     *  gate tightens the window, never wedges the queue. */
    maxUnconfirmedWrites?: number;
    /** How long one confirmed delivery exempts the session from the gate.
     *  Follow-up messages inside the cooldown ride the confirmed delivery's
     *  assumption that the agent is consuming; after it lapses the gate
     *  re-engages for the next delivery. */
    confirmCooldownMs?: number;
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
    // Confirm gate: the route becoming ready only proves the agent process is
    // up, not that its TUI is consuming — a write landing while the agent
    // finishes another turn can sit unsubmitted in its input box. When the
    // route can read terminal history, hold deliveries outside the session's
    // confirm cooldown until our message appears in the history (the agent
    // rendered it). Unconfirmed writes are re-attempted up to the configured
    // bound; at-least-once transport is preserved throughout.
    const confirmMs = this.options.firstDeliveryConfirmMs ?? 1_500;
    // A delivery that has already spent its confirm budget still has to be
    // written — the queue must never wedge — but it settles carrying the
    // unconfirmed reason instead of looking identical to a confirmed one.
    const boundReachedUnconfirmed = attempts + 1 >= (this.options.maxUnconfirmedWrites ?? 3);
    const gateActive = Boolean(route.confirm) && confirmMs > 0
      && Date.now() >= (this.confirmedUntil.get(id) ?? 0)
      && !boundReachedUnconfirmed;
    // Differential baseline for stuck-paste recovery: captured before the
    // write so a later screen diff can tell our paste apart from stale ones.
    let baseline = '';
    if (gateActive && route.recoverStuck && !this.submitted.has(message.id) && route.capture) {
      try { baseline = (await route.capture()) ?? ''; } catch { baseline = ''; }
    }
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
    if (gateActive) {
      if (!(await this.confirmConsumed(pending, route, confirmMs, baseline))) {
        this.submitted.delete(message.id);
        store.recordTransport(message.id, {
          relay_online: null, peer_reachable: true,
          attempt_count: attempts + 1,
          next_retry_at: Date.now() + 4_000, last_error: 'AGENT_CONSUME_UNCONFIRMED', checked_at: Date.now(),
        });
        this.failures.delete(id);
        return;
      }
      // Confirmed rendered: refresh the exemption window so follow-ups in the
      // agent's active turn settle immediately.
      this.confirmedUntil.set(id, Date.now() + (this.options.confirmCooldownMs ?? 30_000));
    }
    // If persistence fails after writing, the in-process guard avoids a
    // second write on retry. Across a crash, transport is at-least-once.
    this.complete(id, message, boundReachedUnconfirmed ? 'AGENT_CONSUME_UNCONFIRMED' : null);
  }

  /** Wait out the confirm window, then look for the written messages in the
   *  recipient's terminal history. A message found there was rendered by the
   *  agent and counts as consumed. While the agent is blocked on an approval
   *  dialog (its Bash call needs permission) dismiss it once per cycle, and
   *  on the first cycle submit a paste that arrived during turn handover and
   *  is still sitting unsubmitted (differential baseline evidence only, at
   *  most once per delivery). Each recovery sends Enter on evidence, never
   *  blind. */
  private async confirmConsumed(
    messages: CollaborationMessage[],
    route: CollaborationRoute,
    delayMs: number,
    baseline: string,
  ): Promise<boolean> {
    let recovered = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? delayMs : Math.min(1_200, delayMs)));
      let content: string | null = null;
      try { content = await route.confirm!(); } catch { content = null; }
      if (content && messages.some((message) => content.includes(message.id))) return true;
      if (!recovered && route.recoverStuck && baseline) {
        try { recovered = await route.recoverStuck(baseline); } catch { /* a failed submit must not settle delivery */ }
      }
      if (content && route.approve) {
        try { await route.approve(); } catch { /* a failed dismiss must not settle delivery */ }
      }
    }
    return false;
  }

  /** Settle a delivery as delivered. `unconfirmedReason`, when set, is a
   *  diagnosis that survives the settle: the write reached the pty (there is
   *  nothing more a retry may do) but the recipient never showed it, so the
   *  sender can still see why. Never re-queues — that is what would wedge the
   *  queue and duplicate the body. */
  private complete(id: string, message: CollaborationMessage, unconfirmedReason: string | null = null): void {
    const { store } = this.options;
    store.markDelivered([message.id]);
    this.submitted.delete(message.id);
    store.recordTransport(message.id, {
      relay_online: null, peer_reachable: true, attempt_count: store.diagnostic(message.id)?.attempt_count ?? 1,
      next_retry_at: null, last_error: unconfirmedReason, checked_at: Date.now(),
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
