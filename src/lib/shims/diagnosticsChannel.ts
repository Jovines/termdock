interface BrowserDiagnosticsChannel {
  readonly name: string;
  readonly hasSubscribers: boolean;
  publish: (message: unknown) => void;
  subscribe: (listener: (message: unknown, name: string) => void) => void;
  unsubscribe: (listener: (message: unknown, name: string) => void) => boolean;
}

interface BrowserTracingChannel {
  start: BrowserDiagnosticsChannel;
  end: BrowserDiagnosticsChannel;
  asyncStart: BrowserDiagnosticsChannel;
  asyncEnd: BrowserDiagnosticsChannel;
  error: BrowserDiagnosticsChannel;
  traceSync: <T>(fn: (...args: unknown[]) => T, context?: unknown, thisArg?: unknown, ...args: unknown[]) => T;
  tracePromise: <T>(fn: (...args: unknown[]) => Promise<T>, context?: unknown, thisArg?: unknown, ...args: unknown[]) => Promise<T>;
  traceCallback: <T extends (...args: any[]) => any>(fn: T, position?: number, context?: unknown, thisArg?: unknown, ...args: unknown[]) => ReturnType<T>;
}

const listenersByName = new Map<string, Set<(message: unknown, name: string) => void>>();

export function channel(name: string): BrowserDiagnosticsChannel {
  return {
    name,
    get hasSubscribers() {
      return (listenersByName.get(name)?.size ?? 0) > 0;
    },
    publish(message: unknown) {
      const listeners = listenersByName.get(name);
      if (!listeners) return;
      for (const listener of listeners) {
        listener(message, name);
      }
    },
    subscribe(listener: (message: unknown, name: string) => void) {
      const listeners = listenersByName.get(name) ?? new Set();
      listeners.add(listener);
      listenersByName.set(name, listeners);
    },
    unsubscribe(listener: (message: unknown, name: string) => void) {
      const listeners = listenersByName.get(name);
      if (!listeners) return false;
      const deleted = listeners.delete(listener);
      if (listeners.size === 0) {
        listenersByName.delete(name);
      }
      return deleted;
    },
  };
}

export function hasSubscribers(name: string): boolean {
  return (listenersByName.get(name)?.size ?? 0) > 0;
}

export function tracingChannel(nameOrChannels: string | {
  start?: string;
  end?: string;
  asyncStart?: string;
  asyncEnd?: string;
  error?: string;
}): BrowserTracingChannel {
  const names = typeof nameOrChannels === 'string'
    ? {
        start: `${nameOrChannels}:start`,
        end: `${nameOrChannels}:end`,
        asyncStart: `${nameOrChannels}:asyncStart`,
        asyncEnd: `${nameOrChannels}:asyncEnd`,
        error: `${nameOrChannels}:error`,
      }
    : {
        start: nameOrChannels.start ?? 'trace:start',
        end: nameOrChannels.end ?? 'trace:end',
        asyncStart: nameOrChannels.asyncStart ?? 'trace:asyncStart',
        asyncEnd: nameOrChannels.asyncEnd ?? 'trace:asyncEnd',
        error: nameOrChannels.error ?? 'trace:error',
      };

  const trace = {
    start: channel(names.start),
    end: channel(names.end),
    asyncStart: channel(names.asyncStart),
    asyncEnd: channel(names.asyncEnd),
    error: channel(names.error),
    traceSync<T>(fn: (...args: unknown[]) => T, context?: unknown, thisArg?: unknown, ...args: unknown[]): T {
      trace.start.publish(context);
      try {
        const result = fn.apply(thisArg, args);
        trace.end.publish(context);
        return result;
      } catch (error) {
        trace.error.publish(error);
        throw error;
      }
    },
    async tracePromise<T>(fn: (...args: unknown[]) => Promise<T>, context?: unknown, thisArg?: unknown, ...args: unknown[]): Promise<T> {
      trace.asyncStart.publish(context);
      try {
        const result = await fn.apply(thisArg, args);
        trace.asyncEnd.publish(context);
        return result;
      } catch (error) {
        trace.error.publish(error);
        throw error;
      }
    },
    traceCallback<T extends (...args: any[]) => any>(
      fn: T,
      _position?: number,
      context?: unknown,
      thisArg?: unknown,
      ...args: unknown[]
    ): ReturnType<T> {
      trace.start.publish(context);
      try {
        const result = fn.apply(thisArg, args) as ReturnType<T>;
        trace.end.publish(context);
        return result;
      } catch (error) {
        trace.error.publish(error);
        throw error;
      }
    },
  };

  return trace;
}
