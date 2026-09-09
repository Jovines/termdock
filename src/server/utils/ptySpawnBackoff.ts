/** Shared across WebSockets and sessions: PTYs/FDs are process-wide resources. */
export class PtySpawnDeferredError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`PTY creation cooling down for ${retryAfterMs}ms`);
  }
}

export class PtySpawnBackoff {
  private failures = 0;
  private retryAt = 0;
  constructor(private readonly now: () => number = Date.now) {}
  get retryAfterMs(): number { return Math.max(0, this.retryAt - this.now()); }
  check(): void {
    if (this.retryAfterMs > 0) throw new PtySpawnDeferredError(this.retryAfterMs);
  }
  spawn<T>(create: () => T): T {
    this.check();
    try {
      const result = create();
      this.failures = 0;
      this.retryAt = 0;
      return result;
    } catch (error) {
      this.failures = Math.min(this.failures + 1, 6);
      this.retryAt = this.now() + Math.min(30_000, 1000 * 2 ** (this.failures - 1));
      throw error; // Preserve errno and the original diagnostic in the real failure log.
    }
  }
}
