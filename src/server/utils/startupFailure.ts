import type { StartupFailedMessage } from './supervisorProtocol.js';

/** Flush the failure to the supervisor before exiting; a log entry alone is not IPC. */
export function exitWithStartupFailure(reason: string, detail: string): void {
  if (!process.connected || !process.send) process.exit(1);
  const timeout = setTimeout(() => process.exit(1), 1_000);
  const finish = () => {
    clearTimeout(timeout);
    process.exit(1);
  };
  try {
    process.send({ type: 'termdock-startup-failed', reason, detail } satisfies StartupFailedMessage, finish);
  } catch {
    finish();
  }
}
