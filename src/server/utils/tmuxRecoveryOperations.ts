import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type TmuxRecoveryItemState = 'queued' | 'resource_wait' | 'running' | 'succeeded' | 'failed';
export type TmuxRecoveryOperationState = 'queued' | 'resource_wait' | 'running' | 'paused' | 'succeeded' | 'partial_failure';

export interface TmuxRecoveryItem {
  sessionId: string;
  state: TmuxRecoveryItemState;
  attempt: number;
  phase: string;
  startedAt: number | null;
  completedAt: number | null;
  errorCode?: string;
  error?: string;
  resourceWaitReason?: string;
  memAvailableBytes?: number;
  estimatedRssBytes?: number;
  actualRssBytes?: number;
}

export interface TmuxRecoveryScope {
  kind: 'incident' | 'group' | 'principal' | 'sessions';
  id?: string;
  sessionIds?: string[];
}

export interface TmuxRecoveryOperation {
  id: string;
  incidentId: string;
  idempotencyKey: string;
  requestHash: string;
  scope: TmuxRecoveryScope;
  state: TmuxRecoveryOperationState;
  paused: boolean;
  concurrency: number;
  createdAt: number;
  updatedAt: number;
  items: TmuxRecoveryItem[];
}

interface PersistedState {
  version: 1;
  operations: TmuxRecoveryOperation[];
}

export interface TmuxRecoveryCounts {
  total: number;
  queued: number;
  resource_wait: number;
  running: number;
  succeeded: number;
  failed: number;
}

export function summarizeRecoveryOperation(operation: TmuxRecoveryOperation): TmuxRecoveryOperation & TmuxRecoveryCounts {
  const counts = operation.items.reduce<TmuxRecoveryCounts>((total, item) => {
    total.total += 1;
    total[item.state] += 1;
    return total;
  }, { total: 0, queued: 0, resource_wait: 0, running: 0, succeeded: 0, failed: 0 });
  return { ...structuredClone(operation), ...counts };
}

export interface AgentLaunchAdmission {
  admitted: boolean;
  reason?: string;
  memAvailableBytes?: number;
  estimatedRssBytes?: number;
}
export interface TmuxRecoveryRunResult { actualRssBytes?: number }

export class TmuxRecoveryOperationError extends Error {
  constructor(readonly code: string, message: string, readonly operationId?: string) {
    super(message);
    this.name = 'TmuxRecoveryOperationError';
  }
}

function requestHash(input: { incidentId: string; sessionIds: string[]; scope: TmuxRecoveryScope; concurrency: number }): string {
  return JSON.stringify(input);
}

function terminalState(state: TmuxRecoveryOperationState): boolean {
  return state === 'succeeded' || state === 'partial_failure';
}

/** Durable, bounded-concurrency queue for explicit tmux recovery operations. */
export class TmuxRecoveryOperationStore {
  private state: PersistedState = { version: 1, operations: [] };
  private writeChain: Promise<void> = Promise.resolve();
  private active = 0;
  private pumping = false;
  private pumpRequested = false;
  private runner?: (operationId: string, sessionId: string, reportPhase: (phase: string) => void) => Promise<void | TmuxRecoveryRunResult>;
  private admission?: (operationId: string, sessionId: string) => Promise<AgentLaunchAdmission>;
  private listeners = new Set<() => void>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    readonly concurrencyLimit: number,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 16) {
      throw new Error('tmux recovery concurrency must be between 1 and 16');
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setRunner(runner: (operationId: string, sessionId: string, reportPhase: (phase: string) => void) => Promise<void | TmuxRecoveryRunResult>): void {
    this.runner = runner;
  }

  setAdmission(admission: (operationId: string, sessionId: string) => Promise<AgentLaunchAdmission>): void {
    this.admission = admission;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as PersistedState;
      if (parsed.version !== 1 || !Array.isArray(parsed.operations)) throw new Error('Invalid tmux recovery operation state');
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const now = Date.now();
    let recovered = false;
    for (const operation of this.state.operations) {
      for (const item of operation.items) {
        if (item.state === 'running') {
          // A killed worker may have submitted the native resume before it died.
          // The runner always performs an exact-owner reconciliation before it launches.
          item.state = 'queued';
          item.phase = 'restart_reconciliation';
          item.errorCode = 'RECOVERY_WORKER_RESTARTED';
          item.error = 'Service restarted during recovery; exact runtime ownership will be reconciled before retry.';
          recovered = true;
        }
      }
      if (!terminalState(operation.state) && !operation.paused) operation.state = 'queued';
      operation.updatedAt = recovered ? now : operation.updatedAt;
    }
    if (recovered) await this.persist();
  }

  async create(input: {
    incidentId: string;
    sessionIds: string[];
    scope: TmuxRecoveryScope;
    idempotencyKey: string;
    concurrency?: number;
  }): Promise<TmuxRecoveryOperation> {
    if (!this.loaded) await this.load();
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
      throw new TmuxRecoveryOperationError('INVALID_IDEMPOTENCY_KEY', 'A non-empty idempotency key of at most 200 characters is required.');
    }
    const sessionIds = [...new Set(input.sessionIds)].sort();
    if (sessionIds.length === 0) throw new TmuxRecoveryOperationError('RECOVERY_SCOPE_EMPTY', 'The selected recovery scope contains no recoverable sessions.');
    const concurrency = input.concurrency ?? this.concurrencyLimit;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > this.concurrencyLimit) {
      throw new TmuxRecoveryOperationError('INVALID_RECOVERY_CONCURRENCY', `Concurrency must be between 1 and ${this.concurrencyLimit}.`);
    }
    const scope = input.scope.kind === 'sessions'
      ? { ...input.scope, sessionIds: [...new Set(input.scope.sessionIds ?? [])].sort() }
      : structuredClone(input.scope);
    const fingerprint = requestHash({ incidentId: input.incidentId, sessionIds, scope, concurrency });
    const existingKey = this.state.operations.find(operation => operation.idempotencyKey === input.idempotencyKey);
    if (existingKey) {
      if (existingKey.requestHash !== fingerprint) throw new TmuxRecoveryOperationError('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used for a different recovery request.');
      return structuredClone(existingKey);
    }
    if (this.state.operations.length >= 2000) throw new TmuxRecoveryOperationError('RECOVERY_OPERATION_LIMIT', 'Recovery operation history is full; archive diagnostics before creating another operation.');
    const inProgress = this.state.operations.find(operation => !terminalState(operation.state)
      && operation.items.some(item => sessionIds.includes(item.sessionId) && (item.state === 'queued' || item.state === 'resource_wait' || item.state === 'running')));
    if (inProgress) throw new TmuxRecoveryOperationError('RECOVERY_SESSION_IN_PROGRESS', 'At least one selected session is already in a recovery operation.', inProgress.id);
    const now = Date.now();
    const operation: TmuxRecoveryOperation = {
      id: randomUUID(), incidentId: input.incidentId, idempotencyKey: input.idempotencyKey,
      requestHash: fingerprint, scope, state: 'queued', paused: false,
      concurrency, createdAt: now, updatedAt: now,
      items: sessionIds.map(sessionId => ({ sessionId, state: 'queued', attempt: 0, phase: 'queued', startedAt: null, completedAt: null, estimatedRssBytes: 512 * 1024 ** 2 })),
    };
    this.state.operations.push(operation);
    try { await this.persist(); }
    catch (error) { this.state.operations = this.state.operations.filter(candidate => candidate.id !== operation.id); throw error; }
    this.emit();
    void this.pump();
    return structuredClone(operation);
  }

  get(id: string): ReturnType<typeof summarizeRecoveryOperation> | null {
    const operation = this.state.operations.find(candidate => candidate.id === id);
    return operation ? summarizeRecoveryOperation(operation) : null;
  }

  latest(): ReturnType<typeof summarizeRecoveryOperation> | null {
    const operation = this.state.operations.at(-1);
    return operation ? summarizeRecoveryOperation(operation) : null;
  }

  all(): Array<ReturnType<typeof summarizeRecoveryOperation>> {
    return this.state.operations.map(summarizeRecoveryOperation);
  }

  async pause(id: string): Promise<TmuxRecoveryOperation | null> {
    const operation = this.state.operations.find(candidate => candidate.id === id);
    if (!operation) return null;
    if (!terminalState(operation.state)) {
      operation.paused = true;
      operation.state = 'paused';
      operation.updatedAt = Date.now();
      await this.persist(); this.emit();
    }
    return this.get(id);
  }

  async resume(id: string): Promise<TmuxRecoveryOperation | null> {
    const operation = this.state.operations.find(candidate => candidate.id === id);
    if (!operation) return null;
    if (!terminalState(operation.state)) {
      operation.paused = false;
      operation.state = 'queued';
      operation.updatedAt = Date.now();
      await this.persist(); this.emit();
      void this.pump();
    }
    return this.get(id);
  }

  stats(): { queued: number; resource_wait: number; running: number; activeLaunches: number; lastCompletedAt: number | null; lastCompletedSessionId: string | null } {
    const operations = this.state.operations;
    const items = operations.flatMap(operation => operation.items);
    const lastCompleted = [...items].filter(item => item.completedAt !== null).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
    return {
      queued: items.filter(item => item.state === 'queued').length,
      resource_wait: items.filter(item => item.state === 'resource_wait').length,
      running: items.filter(item => item.state === 'running').length,
      activeLaunches: this.active,
      lastCompletedAt: lastCompleted?.completedAt ?? null,
      lastCompletedSessionId: lastCompleted?.sessionId ?? null,
    };
  }

  async resumePending(): Promise<void> {
    if (!this.loaded) await this.load();
    void this.pump();
  }

  notifyResourcesChanged(): void {
    if (this.pumping) { this.pumpRequested = true; return; }
    void this.pump();
  }

  async flush(): Promise<void> { await this.writeChain; }

  private async pump(): Promise<void> {
    if (this.pumping || !this.runner || !this.loaded) return;
    this.pumping = true;
    try {
      const deferred = new Set<string>();
      while (this.active < this.concurrencyLimit) {
        const candidate = this.state.operations.find(operation => !operation.paused && !terminalState(operation.state)
          && operation.items.filter(item => item.state === 'running').length < operation.concurrency
          && operation.items.some(item => (item.state === 'queued' || item.state === 'resource_wait') && !deferred.has(`${operation.id}:${item.sessionId}`)));
        const item = candidate?.items.find(entry => (entry.state === 'queued' || entry.state === 'resource_wait') && !deferred.has(`${candidate.id}:${entry.sessionId}`));
        if (!candidate || !item) break;
        if (this.admission) {
          let admission: AgentLaunchAdmission;
          try { admission = await this.admission(candidate.id, item.sessionId); }
          catch (error) { admission = { admitted: false, reason: error instanceof Error ? error.message : 'RESOURCE_SNAPSHOT_UNAVAILABLE' }; }
          item.memAvailableBytes = admission.memAvailableBytes;
          item.estimatedRssBytes = admission.estimatedRssBytes ?? item.estimatedRssBytes;
          if (!admission.admitted) {
            item.state = 'resource_wait'; item.phase = 'resource_wait';
            item.resourceWaitReason = admission.reason ?? 'Resource budget is not currently available.';
            candidate.state = 'resource_wait'; candidate.updatedAt = Date.now();
            deferred.add(`${candidate.id}:${item.sessionId}`);
            await this.persist(); this.emit();
            continue;
          }
          item.resourceWaitReason = undefined;
        }
        if (candidate.paused) break;
        candidate.state = 'running';
        item.state = 'running'; item.phase = item.phase === 'restart_reconciliation' ? item.phase : 'restoring';
        item.attempt += 1; item.startedAt = Date.now(); item.completedAt = null;
        candidate.updatedAt = Date.now(); this.active += 1;
        await this.persist(); this.emit();
        void this.execute(candidate, item);
      }
      if (this.state.operations.some(operation => !operation.paused && !terminalState(operation.state)
        && operation.items.some(item => item.state === 'resource_wait'))) {
        const retry = setTimeout(() => void this.pump(), 5_000);
        retry.unref?.();
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.pumping = false;
      if (this.pumpRequested) { this.pumpRequested = false; queueMicrotask(() => void this.pump()); }
    }
  }

  private async execute(operation: TmuxRecoveryOperation, item: TmuxRecoveryItem): Promise<void> {
    try {
      const result = await this.runner!(operation.id, item.sessionId, phase => {
        item.phase = phase.slice(0, 80);
        operation.updatedAt = Date.now();
        void this.persist().then(() => this.emit()).catch(error => this.onError(error));
      });
      if (result?.actualRssBytes !== undefined) item.actualRssBytes = result.actualRssBytes;
      item.state = 'succeeded'; item.phase = 'completed'; item.error = undefined; item.errorCode = undefined;
    } catch (error) {
      const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof value.code === 'string' ? value.code
        : message.includes('TERMINAL_INPUT_TARGET_CHANGED') ? 'TERMINAL_INPUT_TARGET_CHANGED' : 'TMUX_RECOVERY_FAILED';
      item.state = 'failed'; item.phase = code === 'TERMINAL_INPUT_TARGET_CHANGED' ? 'target_changed' : 'failed';
      item.errorCode = code; item.error = message.slice(0, 1000);
      this.onError({ operationId: operation.id, sessionId: item.sessionId, code, message });
    } finally {
      item.completedAt = Date.now(); operation.updatedAt = item.completedAt;
      const hasPending = operation.items.some(candidate => candidate.state === 'queued' || candidate.state === 'resource_wait' || candidate.state === 'running');
      if (!hasPending) {
        operation.paused = false;
        operation.state = operation.items.some(candidate => candidate.state === 'failed') ? 'partial_failure' : 'succeeded';
      } else {
        operation.state = operation.paused ? 'paused'
          : operation.items.some(candidate => candidate.state === 'running') ? 'running'
            : operation.items.some(candidate => candidate.state === 'queued') ? 'queued' : 'resource_wait';
      }
      this.active = Math.max(0, this.active - 1);
      try { await this.persist(); } catch (error) { this.onError(error); }
      this.emit();
      void this.pump();
    }
  }

  private emit(): void { for (const listener of this.listeners) { try { listener(); } catch { /* observer failure is isolated */ } } }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const write = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tempPath, snapshot, { mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
    });
    this.writeChain = write.catch(error => { this.onError(error); });
    return write;
  }
}

export function configuredTmuxRecoveryConcurrency(value = process.env.TD_TMUX_RECOVERY_CONCURRENCY): number {
  if (value === undefined || value.trim() === '') return 3;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) throw new Error('Recovery concurrency must be an integer from 1 to 16');
  return parsed;
}
