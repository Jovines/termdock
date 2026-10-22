/** Give the first small response to an interaction a chance to reach xterm
 * without waiting for the store's next animation frame. Continuous output
 * retains normal batching, including while a command is starting. */
export class InteractiveOutput {
  private until = -Infinity;
  private lastFlush = -Infinity;
  input(now: number): void { this.until = now + 1500; }
  consume(length: number, now: number, visible: boolean): boolean {
    const pending = now <= this.until;
    this.until = -Infinity;
    if (!pending || !visible || length > 8192 || now - this.lastFlush < 16) return false;
    this.lastFlush = now;
    return true;
  }
}
