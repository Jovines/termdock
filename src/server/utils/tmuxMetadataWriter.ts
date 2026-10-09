export interface DynamicTmuxMetadata { program: string | null; cwd: string | null; label: string }

export function batchTmuxOptions(name: string, options: Record<string, string>): string[] {
  const args: string[] = [];
  // tmux parses a trailing semicolon as a command separator even when argv
  // came from execFile. Escape data arguments, leaving our separators intact.
  const literal = (value: string) => value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value;
  for (const [key, value] of Object.entries(options)) {
    if (args.length) args.push(';');
    args.push('set-option', '-t', literal(name), key, literal(value));
  }
  return args;
}

/** Deduplicate across observers and inventory. Keep only the newest desired
 * state during a slow write; commit the snapshot only after a successful write. */
export class TmuxMetadataWriter {
  private readonly states = new Map<string, {
    desired: DynamicTmuxMetadata;
    written?: string;
    at: number;
    pending?: Promise<void>;
  }>();

  constructor(
    private readonly write: (name: string, options: Record<string, string>) => Promise<unknown>,
    private readonly heartbeatMs = 30_000,
  ) {}

  sync(name: string, metadata: DynamicTmuxMetadata): Promise<void> {
    let state = this.states.get(name);
    if (!state) {
      state = { desired: metadata, at: 0 };
      this.states.set(name, state);
    }
    state.desired = metadata;
    if (state.pending) return state.pending;
    const current = state;
    current.pending = Promise.resolve().then(async () => {
      while (this.states.get(name) === current) {
        const desired = current.desired;
        const signature = JSON.stringify(desired);
        const changed = signature !== current.written;
        const now = Date.now();
        if (!changed && now - current.at < this.heartbeatMs) return;
        await this.write(name, {
          ...(changed ? {
            '@termdock-label': desired.label,
            '@termdock-program': desired.program ?? '',
            '@termdock-cwd': desired.cwd ?? '',
          } : {}),
          '@termdock-last-active-at': String(now),
        });
        current.written = signature;
        current.at = now;
      }
    }).finally(() => { current.pending = undefined; });
    return current.pending;
  }

  retain(names: Set<string>): void {
    for (const name of this.states.keys()) if (!names.has(name)) this.states.delete(name);
  }

  forget(name: string): void { this.states.delete(name); }
}
