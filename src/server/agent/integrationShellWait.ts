import { CollaborationError } from './collaborationProtocol.js';
import type { CollaborationPaneBinding } from './collaborationRouting.js';

export interface IntegrationShellObservation {
  binding: CollaborationPaneBinding | null;
  confirmed: boolean;
  agent: boolean;
  reason: string | null;
  pgid: number | null;
  tpgid: number | null;
}
export interface IntegrationShellEvidence {
  samples: number; waited_ms: number; reason: string | null;
  binding: CollaborationPaneBinding | null; pgid: number | null; tpgid: number | null;
}
export class IntegrationShellWaitError extends CollaborationError {
  constructor(code: string, readonly shellEvidence: IntegrationShellEvidence) {
    super(code, 'The original runtime did not prove a unique foreground shell before launch', 409);
  }
}
const samePane = (a: CollaborationPaneBinding, b: CollaborationPaneBinding) =>
  a.serverPid === b.serverPid && a.sessionId === b.sessionId && a.paneId === b.paneId && a.panePid === b.panePid;

/** Wait for kernel/process evidence, never a prompt, fixed startup sleep, or
 * application readiness. This observes one runtime and never sends input. */
export async function waitForIntegrationShell(input: {
  observe(): Promise<IntegrationShellObservation>;
  expected?: CollaborationPaneBinding | null;
  now?: () => number; pause?: (ms: number) => Promise<void>; timeoutMs?: number;
}): Promise<CollaborationPaneBinding> {
  const now = input.now ?? Date.now, started = now();
  const pause = input.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let pinned = input.expected ?? null, samples = 0;
  for (;;) {
    const observation = await input.observe(); samples++;
    const evidence: IntegrationShellEvidence = { samples, waited_ms: now() - started,
      reason: observation.reason, binding: observation.binding, pgid: observation.pgid, tpgid: observation.tpgid };
    if (!observation.binding || pinned && !samePane(pinned, observation.binding)) {
      throw new IntegrationShellWaitError('SESSION_IDENTITY_MISMATCH', evidence);
    }
    pinned ??= observation.binding;
    if (observation.agent) throw new IntegrationShellWaitError('SESSION_TARGET_NOT_SHELL', evidence);
    if (observation.confirmed) return pinned;
    if (now() - started >= (input.timeoutMs ?? 5000)) throw new IntegrationShellWaitError('SESSION_TARGET_NOT_SHELL', evidence);
    await pause(Math.min(100, (input.timeoutMs ?? 5000) - (now() - started)));
  }
}
