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

export type TerminalInputGuard = () => void;

/** Clearing a one-time launch check does not change the runtime generation. */
export function captureTerminalInputGuard<T>(current: () => T, expected = current()): TerminalInputGuard {
  return () => {
    if (current() !== expected) throw new Error('TERMINAL_INPUT_TARGET_CHANGED');
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
