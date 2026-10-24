import { collectionSessionPolicy, TodoError, type TodoStore } from './store.js';
import type { TodoRun } from './types.js';

/** Facts from a continuously observed runtime, never inferred Agent activity. */
export interface CollectionObservation { identity: string; ownershipIdentity: string; lastOutputAt: number; observedAt: number }
export interface CollectionSessionRuntime {
  observe(id: string): Promise<CollectionObservation | null>;
  reuse(run: TodoRun, id: string, prompt: string, beforePrompt: string): Promise<void>;
  close(id: string, expected: CollectionObservation): Promise<boolean>;
}
export class CollectionSessionLifecycle {
  private locks = new Set<string>();
  private observations = new Map<string, { identity: string; since: number }>();
  constructor(private readonly store: TodoStore, private readonly runtime: CollectionSessionRuntime, private readonly now = Date.now) {}
  private latest() {
    const runs = this.store.snapshot().runs, bySession = new Map<string, TodoRun>();
    for (const run of runs) if (run.sessionId) bySession.set(run.sessionId, run);
    return bySession;
  }
  /** A later handoff relinquishes collector ownership; its terminal is now user work. */
  private owned(run: TodoRun) { return run.kind === 'collect' && run.collectionSession?.owned !== false && !run.collectionSession?.recycledAt; }
  private policy(run: TodoRun) {
    return collectionSessionPolicy(this.store.snapshot().collectors.find(c => c.id === run.collectorId)?.session ?? run.collectionSession);
  }
  async collect(run: TodoRun, prompt: string, created: (id: string) => void, launch: () => Promise<void>): Promise<void> {
    const policy = collectionSessionPolicy(run.collectionSession);
    if (policy.mode !== 'reuse') return launch();
    const previous = [...this.latest().values()].reverse().find(r => this.owned(r) && r.collectorId === run.collectorId
      && r.config.agentSlug === run.config.agentSlug && r.config.command === run.config.command && r.config.cwd === run.config.cwd);
    const id = policy.targetSessionId ?? previous?.sessionId;
    if (!id) return launch();
    if (this.locks.has(id)) throw new TodoError('收集会话正在操作，请稍后重试', 409);
    this.locks.add(id);
    try {
      const observation = await this.runtime.observe(id);
      if (!observation) {
        if (policy.targetSessionId) throw new TodoError('指定的收集会话已关闭，请重新选择', 409);
        this.store.recycled(id); return await launch();
      }
      if (previous?.collectionSession?.runtimeIdentity && previous.collectionSession.runtimeIdentity !== observation.ownershipIdentity) throw new TodoError('原收集终端已被替换，不会向它发送命令；请选择其他会话', 409);
      if (previous?.sessionId === id && (['launching', 'delivered'].includes(previous.status) || previous.status === 'failed' && !previous.result)) throw new TodoError('上一轮尚未报告结束，请打开收集终端检查后再运行', 409);
      created(id); // Durable association before any reset or prompt can reach the terminal.
      if (!policy.targetSessionId) this.store.bindCollectionSession(id, observation.ownershipIdentity);
      await this.runtime.reuse(run, id, prompt, policy.beforePrompt);
      this.observations.set(id, { identity: observation.identity, since: this.now() });
    } finally { this.locks.delete(id); }
  }
  async recycle(): Promise<void> {
    const latest = this.latest();
    for (const [id] of this.observations) if (!latest.has(id)) this.observations.delete(id);
    for (const [id, run] of latest) {
      if (!this.owned(run) || run.status === 'launching' || this.locks.has(id)) continue;
      const minutes = this.policy(run).idleMinutes;
      if (!minutes) { this.observations.delete(id); continue; }
      this.locks.add(id);
      try {
        const observation = await this.runtime.observe(id);
        if (!observation) { this.observations.delete(id); continue; }
        if (run.collectionSession?.runtimeIdentity && run.collectionSession.runtimeIdentity !== observation.ownershipIdentity) continue;
        if (!run.collectionSession?.runtimeIdentity) this.store.bindCollectionSession(id, observation.ownershipIdentity);
        const now = this.now(), previous = this.observations.get(id);
        if (!previous || previous.identity !== observation.identity) {
          this.observations.set(id, { identity: observation.identity, since: now }); continue;
        }
        // Restart/reconnect gets a full observation window. Heartbeats and reports do not count as output.
        if (now - Math.max(previous.since, observation.lastOutputAt) < minutes * 60_000) continue;
        if (observation.observedAt < now - 5_000 || this.latest().get(id)?.id !== run.id) continue;
        if (await this.runtime.close(id, observation)) { this.store.recycled(id); this.observations.delete(id); }
      } catch (error) { console.warn('[todo-session-recycle]', id, error instanceof Error ? error.message : error); }
      finally { this.locks.delete(id); }
    }
  }
}
