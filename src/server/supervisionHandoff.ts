/** The prepared process becomes the supervisor once the old service has exited. */
import fs from 'node:fs';
import { runSupervisor, type SupervisorConfig } from './supervisor.js';
import { isProcessRunning } from './utils/termdockState.js';

const { parentPid, config } = JSON.parse(process.argv[2]) as { parentPid: number; config: SupervisorConfig };
if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || !process.connected) process.exit(1);
fs.accessSync(config.childEntry, fs.constants.R_OK);
if (config.healthCaPath) fs.accessSync(config.healthCaPath, fs.constants.R_OK);
let committed = false;
const expiry = setTimeout(() => process.exit(1), 10_000);
process.on('disconnect', () => { if (!committed) process.exit(1); });
process.once('message', (message) => {
  if ((message as { type?: string })?.type !== 'handoff-commit') process.exit(1);
  committed = true;
  clearTimeout(expiry);
  const deadline = Date.now() + 30_000;
  const timer = setInterval(() => {
    if (isProcessRunning(parentPid)) {
      if (Date.now() >= deadline) {
        console.error('[supervisor] old service did not exit; handoff cancelled');
        process.exit(1);
      }
      return;
    }
    clearInterval(timer);
    runSupervisor(config);
  }, 100);
});
process.send?.({ type: 'handoff-ready' });
