import { CollaborationError } from './collaborationProtocol.js';

/** Runtime ownership is independent of messages, tasks, and the calling
 * identity. Callers persist intent in their descriptor store before effects. */
export interface SessionRuntimeFacts {
  exists: boolean; running: boolean; shell: boolean;
  agentSlug: string | null; nativeId: string | null;
}
export type RecoverableSessionState = 'starting' | 'binding_pending' | 'ready' | 'restoring' | 'failed' | 'releasing' | 'released';
export interface SessionLifecycleDescriptor {
  session_id: string; operation_id: string; generation?: number;
  state: RecoverableSessionState; runtime_present?: boolean | null;
  agent_slug: string; agent_native_session_id: string | null;
  operation_uncertain?: boolean;
}
const fail = (code: string, message: string): never => { throw new CollaborationError(code, message, 409); };

/** One coordinator per service. A reservation covers validation and launch;
 * persisted unresolved intents also block a second identity after restart.
 * This does not promise atomic exclusion of independently launched programs. */
export class SessionLifecycleCoordinator {
  private operations = new Set<string>();
  private natives = new Map<string, string>();
  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.operations.has(id)) fail('SESSION_OPERATION_IN_PROGRESS', 'Another lifecycle operation is in progress');
    this.operations.add(id);
    try { return await action(); } finally { this.operations.delete(id); }
  }
  active(id: string): boolean { return this.operations.has(id); }
  reserveNative(record: SessionLifecycleDescriptor, descriptors: SessionLifecycleDescriptor[]): () => void {
    const key = JSON.stringify([record.agent_slug, record.agent_native_session_id]);
    const owner = this.natives.get(key);
    if (owner && owner !== record.session_id || descriptors.some(other => other.session_id !== record.session_id
      && other.agent_slug === record.agent_slug && other.agent_native_session_id === record.agent_native_session_id
      && (['starting', 'restoring', 'binding_pending'].includes(other.state) || other.operation_uncertain))) {
      fail('SESSION_NATIVE_OPERATION_IN_PROGRESS', 'Another descriptor has an unresolved operation for this native identity');
    }
    this.natives.set(key, record.session_id);
    return () => { if (this.natives.get(key) === record.session_id) this.natives.delete(key); };
  }
}
export function assertReleaseGeneration(record: SessionLifecycleDescriptor, generation: unknown): void {
  if (!Number.isSafeInteger(generation) || Number(generation) < 1) fail('INVALID_SESSION_GENERATION', 'release requires the generation returned by session get');
  if (generation !== (record.generation ?? 1)) fail('SESSION_GENERATION_MISMATCH', 'Session generation changed; read its current state before releasing');
}
export function assertReleaseFacts(record: SessionLifecycleDescriptor, facts: SessionRuntimeFacts): void {
  if (!record.agent_native_session_id) fail('NATIVE_SESSION_ID_MISSING', 'Release requires a durable exact native identity');
  if (['starting', 'restoring', 'binding_pending', 'releasing'].includes(record.state)) fail('SESSION_OPERATION_IN_PROGRESS', 'Prior operation is unresolved');
  if (facts.running) fail('SESSION_STILL_RUNNING', 'Agent is still running; explicitly exit it before releasing the runtime');
  if (facts.exists && !facts.shell) fail('SESSION_IDENTITY_MISMATCH', 'Runtime is not the verified original empty shell');
}
export function assertMessageRuntime(record: SessionLifecycleDescriptor | undefined): void {
  if (!record) return;
  if (record.state === 'released') fail('SESSION_RELEASED', 'Runtime was released; explicitly restore this session before sending');
  if (record.state === 'releasing') fail('SESSION_OPERATION_IN_PROGRESS', 'Runtime release is in progress; message was not enqueued');
  if (record.operation_uncertain) fail('OPERATION_OUTCOME_UNCONFIRMED', 'Lifecycle outcome needs reconciliation before sending');
}

export interface SessionRuntimeReleaseAdapter {
  barrier(action: () => Promise<void>): Promise<void>;
  exists(): Promise<boolean>;
  pendingMessages(): number;
  verifyOwnership(): Promise<void>;
  inspect(): Promise<SessionRuntimeFacts>;
  destroy(): Promise<void>;
  /** Remove remaining PTY/inventory/membership only after tmux is absent. */
  forgetRuntime(): Promise<void>;
}
/** Shared release protocol. No Agent idle inference, task result, or UI
 * visibility participates in deciding whether a process may be destroyed. */
export async function releaseSessionRuntime(adapter: SessionRuntimeReleaseAdapter, reconcile: boolean): Promise<void> {
  await adapter.barrier(async () => {
    if (adapter.pendingMessages()) fail('SESSION_PENDING_MESSAGES', 'Pending messages appeared before runtime release');
    if (await adapter.exists()) {
      if (reconcile) fail('OPERATION_OUTCOME_UNCONFIRMED', 'Original runtime still exists; restart reconciliation will not terminate it');
      await adapter.verifyOwnership();
      const facts = await adapter.inspect();
      if (facts.running) fail('SESSION_STILL_RUNNING', 'Agent restarted before release');
      if (!facts.exists || !facts.shell) fail('SESSION_IDENTITY_MISMATCH', 'Original runtime is not a verified foreground shell');
      await adapter.destroy();
    }
    if (await adapter.exists()) fail('OPERATION_OUTCOME_UNCONFIRMED', 'Owned runtime still exists after release');
    await adapter.forgetRuntime();
  });
}
