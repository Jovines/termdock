/** One TD input operation per actual transport, independent of application state. */
const objectInputs = new WeakMap<object, Promise<unknown>>();
const namedInputs = new Map<string, Promise<unknown>>();

export function serializeTerminalInput<T>(target: object | string, action: () => Promise<T>): Promise<T> {
  return typeof target === 'string' ? serializeInQueue(namedInputs, target, action)
    : serializeInQueue(objectInputs, target, action);
}

function serializeInQueue<K extends object | string, T>(store: {
  get: (key: K) => Promise<unknown> | undefined;
  set: (key: K, value: Promise<unknown>) => unknown;
  delete: (key: K) => unknown;
}, target: K, action: () => Promise<T>): Promise<T> {
  const previous = store.get(target) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(action).finally(() => {
    if (store.get(target) === operation) store.delete(target);
  });
  store.set(target, operation);
  return operation;
}

export type TerminalInputCheckPhase = 'guard_capture' | 'launch_persisted' | 'runtime_resolve' | 'runtime_resolved'
  | 'queue_acquired' | 'before_paste' | 'before_submit' | 'launch_state_commit';
export type TerminalInputGuard = (phase?: TerminalInputCheckPhase) => void;
export type PromptWriteStage = 'guard_captured' | 'runtime_resolving' | 'runtime_resolved'
  | 'queue_wait' | 'queue_acquired' | 'paste_attempted' | 'paste_written' | 'submit_attempted' | 'submit_written';
export type PromptWriteProgress = (stage: PromptWriteStage) => void;
export class TerminalInputTargetChangedError extends Error {
  readonly code = 'TERMINAL_INPUT_TARGET_CHANGED';
  constructor(readonly evidence?: {
    expected_backend_session_id: string | null; current_backend_session_id: string | null;
    expected_launch_id: string | null; current_launch_id: string | null; backend_instance_matches: boolean;
    check_phase?: TerminalInputCheckPhase; guard_captured_at?: number; checked_at?: number;
    expected_route_revision?: string | null; current_route_revision?: string | null;
  }) { super('TERMINAL_INPUT_TARGET_CHANGED'); }
}

export interface RuntimeInputIdentity {
  backendSessionId: string | null;
  backendInstance: object | undefined;
  launchId: string | null;
  routeRevision: string | null;
}
/** Capture once, including for a launch's own command. Never adopt a newer
 * generation simply because the physical backend has stayed the same. */
export function captureRuntimeInputGuard(current: () => RuntimeInputIdentity,
  expected = current()): TerminalInputGuard {
  const capturedAt = Date.now();
  return (phase = 'guard_capture') => {
    const actual = current();
    const matches = actual.backendInstance === expected.backendInstance;
    if (actual.backendSessionId !== expected.backendSessionId || !matches
      || actual.launchId !== expected.launchId || actual.routeRevision !== expected.routeRevision) {
      throw new TerminalInputTargetChangedError({ expected_backend_session_id: expected.backendSessionId,
        current_backend_session_id: actual.backendSessionId, expected_launch_id: expected.launchId,
        current_launch_id: actual.launchId, backend_instance_matches: matches, check_phase: phase,
        guard_captured_at: capturedAt, checked_at: Date.now(), expected_route_revision: expected.routeRevision,
        current_route_revision: actual.routeRevision });
    }
  };
}

/** Clearing a one-time launch check does not change the runtime generation. */
export function captureTerminalInputGuard<T>(current: () => T, expected = current()): TerminalInputGuard {
  return () => {
    if (current() !== expected) throw new TerminalInputTargetChangedError();
  };
}

/** Await the actual write instead of leaving detached timers after reporting success. */
export async function waitAndWriteTerminalInput(input: {
  assertCurrent: TerminalInputGuard;
  ready: (attempt: number) => Promise<boolean>;
  write: () => Promise<void>;
}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    input.assertCurrent();
    const ready = await input.ready(attempt);
    input.assertCurrent();
    if (ready) {
      await input.write();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
