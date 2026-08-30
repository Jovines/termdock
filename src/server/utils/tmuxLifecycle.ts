/**
 * Serializes tmux lifecycle mutations across session names. tmux has one
 * shared server, so create/detach/destroy operations are one failure domain
 * even when they target different sessions.
 */
export class TmuxLifecycleCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const duplicate = this.pending.get(key);
    if (duplicate) return duplicate as Promise<T>;

    const scheduled = this.tail.then(operation, operation);
    this.tail = scheduled.then(() => undefined, () => undefined);
    this.pending.set(key, scheduled);
    void scheduled.finally(() => {
      if (this.pending.get(key) === scheduled) this.pending.delete(key);
    }).catch(() => undefined);
    return scheduled;
  }
}
