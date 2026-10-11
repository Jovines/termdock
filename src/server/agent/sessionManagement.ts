import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CollaborationError } from './collaborationProtocol.js';
import type { CollaborationPaneBinding } from './collaborationRouting.js';

/** No argv, environment, output, or application state is retained. */
export interface SessionCloseTarget {
  binding: CollaborationPaneBinding;
  tmux_server_start_id: string;
  kind: 'shell' | 'agent';
  process_pid: number;
  process_start_id: string;
  native_id: string | null;
}
const fail = (code: string, message: string): never => { throw new CollaborationError(code, message, 409); };
/** Read the live foreground process instance, not a historical PID. */
export async function foregroundProcessInstance(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid < 1) return fail('SESSION_CLOSE_TARGET_UNCONFIRMED', 'Foreground process is unavailable');
  try {
    if (process.platform === 'linux') {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (fields[0] === 'Z' || Number(fields[2]) <= 0 || fields[2] !== fields[5] || !/^\d+$/.test(fields[19])) throw new Error();
      return `linux:${fields[19]}`;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'pgid=,tpgid=,stat=,lstart='], { timeout: 2000 });
      const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match || Number(match[1]) < 1 || match[1] !== match[2] || match[3].startsWith('Z')) throw new Error();
      return `darwin:${match[4]}`;
    }
  } catch { /* Never fall back to PID existence. */ }
  return fail('SESSION_CLOSE_TARGET_UNCONFIRMED', 'Current foreground process instance cannot be verified');
}
/** A missing PID is absence; inaccessible identity remains an error. */
export async function processStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (fields[0] === 'Z') return null;
      if (!/^\d+$/.test(fields[19])) throw new Error();
      return `linux:${fields[19]}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; }
  } else if (process.platform === 'darwin') {
    try {
      const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'stat=,lstart='], { timeout: 2000 });
      const match = stdout.trim().match(/^(\S+)\s+(.+)$/);
      if (match) return match[1].startsWith('Z') ? null : `darwin:${match[2]}`;
    } catch { try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null; } }
  }
  return fail('SESSION_CLOSE_TARGET_UNCONFIRMED', 'Process disappearance cannot be verified');
}
export interface SessionCloseRuntimeAdapter {
  barrier(action: () => Promise<void>): Promise<void>;
  exists(): Promise<boolean>;
  pendingMessages(): number;
  /** Validate unique logical/group ownership and return freshly read facts. */
  observe(): Promise<SessionCloseTarget>;
  destroy(target: SessionCloseTarget): Promise<void>;
  forgetRuntime(): Promise<void>;
}
/** Restart reconciliation never issues termination. External tmux/process
 * changes are outside the service lock; final fresh checks reduce, not erase,
 * that race. The exact tmux session ID is used for teardown. */
export async function closeSessionRuntime(adapter: SessionCloseRuntimeAdapter, target: SessionCloseTarget | null, reconcile: boolean): Promise<void> {
  await adapter.barrier(async () => {
    if (adapter.pendingMessages()) fail('SESSION_PENDING_MESSAGES', 'Pending messages must be resolved before closing');
    if (await adapter.exists()) {
      if (reconcile) fail('OPERATION_OUTCOME_UNCONFIRMED', 'Runtime still exists; reconciliation will not terminate a process');
      if (!target || JSON.stringify(await adapter.observe()) !== JSON.stringify(target)) fail('SESSION_CLOSE_TARGET_CHANGED', 'Runtime or process instance changed after close intent');
      await adapter.destroy(target!);
      const deadline = Date.now() + 2000;
      // Observe actual disappearance; do not issue repeated termination.
      while (await adapter.exists() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (await adapter.exists()) fail('OPERATION_OUTCOME_UNCONFIRMED', 'Runtime absence cannot be confirmed');
    await adapter.forgetRuntime();
  });
}
