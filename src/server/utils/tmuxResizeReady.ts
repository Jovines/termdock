/** PTY output wakes the check; tmux's exact client dimensions prove readiness.
 * No polling or grace period. The timeout rejects failure, never grants success.
 */
export function waitForTmuxClientSize(
  readClients: () => Promise<string>,
  onOutput: (notify: () => void) => () => void,
  pid: number,
  cols: number,
  rows: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let checking = false;
    let dirty = false;
    let dispose = () => {};
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      dispose();
      if (error) reject(error); else resolve();
    };
    const timeout = setTimeout(() => finish(new Error('tmux client has not applied PTY dimensions')), 500);
    const check = async () => {
      if (finished) return;
      dirty = true;
      if (checking) return;
      checking = true;
      try {
        do {
          dirty = false;
          const clients = await readClients();
          if (finished) return;
          const ready = clients.split('\n').some((line) => {
            const [clientPid, width, height] = line.trim().split(/\s+/).map(Number);
            return clientPid === pid && width === cols && height === rows;
          });
          if (ready) { finish(); return; }
        } while (dirty && !finished);
      } catch (error) {
        finish(error);
      } finally {
        checking = false;
      }
    };
    // Subscribe before reading so output arriving during the query is not lost.
    dispose = onOutput(() => { void check(); });
    void check();
  });
}
