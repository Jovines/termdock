import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupervisorConfig } from '../supervisor.js';
import { getSupervisorStatus } from './supervisorClient.js';
import { SERVER_LOG_PATH } from './termdockState.js';

let config: SupervisorConfig | null = null;
let pending = false;

// Only the production CLI registers a launch recipe. Desktop and development
// runtimes must remain owned by their original launcher.
export function configureSupervisionEnable(value: SupervisorConfig): void {
  config = value;
}

export function canEnableSupervision(): boolean {
  return config !== null && !(process.env.TERMDOCK_SUPERVISED === '1' && process.connected)
    && !process.env.TERMDOCK_DESKTOP && !process.env.TERMDOCK_DESKTOP_OWNER_SOCKET
    && !process.env.INVOCATION_ID && !process.env.NOTIFY_SOCKET && !process.env.PM2_HOME
    && !getSupervisorStatus()?.alive;
}

/** Prepare the replacement before stopping anything; commit after HTTP flush. */
export async function prepareSupervisionEnable(): Promise<() => void> {
  if (pending) throw new Error('Automatic recovery is already being enabled.');
  if (!canEnableSupervision() || !config) throw new Error('Enable automatic recovery through the service launcher.');
  pending = true;
  try {
    const script = fileURLToPath(new URL('../supervisionHandoff.js', import.meta.url));
    fs.accessSync(script, fs.constants.R_OK);
    fs.accessSync(config.childEntry, fs.constants.R_OK);
    const fd = fs.openSync(SERVER_LOG_PATH, 'a', 0o600);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [script, JSON.stringify({ parentPid: process.pid, config })], {
        detached: true,
        stdio: ['ignore', fd, fd, 'ipc'],
      });
    } finally {
      fs.closeSync(fd);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Automatic recovery did not become ready.'));
      }, 5000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => {
        clearTimeout(timer);
        pending = false;
        reject(new Error('Automatic recovery could not start.'));
      });
      child.once('message', (message) => {
        if ((message as { type?: string })?.type !== 'handoff-ready') return;
        clearTimeout(timer);
        resolve();
      });
    });
    let committed = false;
    return () => {
      if (committed) return;
      committed = true;
      // Never terminate the working service if the prepared process vanished.
      child.send({ type: 'handoff-commit' }, (error) => {
        if (error) { pending = false; return; }
        child.disconnect();
        child.unref();
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 750).unref();
      });
    };
  } catch (error) {
    pending = false;
    throw error;
  }
}
