import fs from 'node:fs';
import path from 'node:path';

export type CollaborationRouteState = 'unchecked' | 'shell' | 'recovering' | 'detached' | 'ready' | 'agent-exited' | 'offline' | 'ambiguous' | 'identity-mismatch' | 'unavailable';

export interface CollaborationPaneBinding {
  serverPid: number;
  sessionId: string;
  paneId: string;
  panePid: number;
  agentSlug: string;
  nativeSessionId: string | null;
}

export interface CollaborationBinding {
  sessionId: string;
  backendSessionId: string | null;
  mode: 'shell' | 'tmux';
  tmuxSessionName: string | null;
  agentSlug: string | null;
  nativeSessionId: string | null;
  pane: CollaborationPaneBinding | null;
  routeRevision?: string;
  lastRecovery?: { kind: 'native-identity' | 'owner-confirmed'; at: number; previousPane: CollaborationPaneBinding | null };
}

export class CollaborationRoutingStore {
  private bindings = new Map<string, CollaborationBinding>();
  private loadError: unknown = null;

  constructor(private readonly file: string) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.bindings)) throw new Error('Invalid collaboration routing store');
      for (const binding of data.bindings) {
        if (!binding || typeof binding.sessionId !== 'string' || !['shell', 'tmux'].includes(binding.mode)
          || ![binding.backendSessionId, binding.tmuxSessionName, binding.agentSlug, binding.nativeSessionId].every((value) => value === null || typeof value === 'string')
          || (binding.pane !== null && (!binding.pane || !Number.isInteger(binding.pane.serverPid) || !Number.isInteger(binding.pane.panePid)
            || !/^%\d+$/.test(binding.pane.paneId) || !/^\$\d+$/.test(binding.pane.sessionId) || typeof binding.pane.agentSlug !== 'string'))) {
          throw new Error('Invalid collaboration binding');
        }
        if (binding.routeRevision !== undefined && (typeof binding.routeRevision !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(binding.routeRevision))) throw new Error('Invalid route revision');
        if (binding.lastRecovery !== undefined && (!binding.lastRecovery || !['native-identity', 'owner-confirmed'].includes(binding.lastRecovery.kind)
          || !Number.isSafeInteger(binding.lastRecovery.at))) throw new Error('Invalid route recovery record');
        this.bindings.set(binding.sessionId, binding);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.bindings.clear();
        this.loadError = error;
      }
    }
  }

  get(id: string): CollaborationBinding | null {
    const binding = this.bindings.get(id);
    return binding ? structuredClone(binding) : null;
  }

  assertReadable(): void {
    if (this.loadError) throw new Error('COLLABORATION_ROUTING_STORE_UNREADABLE', { cause: this.loadError });
  }

  ownerOfBackend(id: string): string | null {
    return [...this.bindings.values()].find((binding) => binding.backendSessionId === id)?.sessionId ?? null;
  }

  hasOtherPaneOwner(id: string, pane: CollaborationPaneBinding): boolean {
    return [...this.bindings.values()].some(binding => binding.sessionId !== id && binding.pane
      && binding.pane.serverPid === pane.serverPid && binding.pane.sessionId === pane.sessionId && binding.pane.paneId === pane.paneId);
  }

  bind(binding: CollaborationBinding): void {
    this.assertReadable();
    const owner = binding.backendSessionId ? this.ownerOfBackend(binding.backendSessionId) : null;
    if (owner && owner !== binding.sessionId) throw new Error('BACKEND_ALREADY_BOUND');
    if (JSON.stringify(this.bindings.get(binding.sessionId)) === JSON.stringify(binding)) return;
    const next = new Map(this.bindings);
    next.set(binding.sessionId, structuredClone(binding));
    this.persist(next);
  }

  remove(id: string): void {
    if (!this.bindings.has(id)) return;
    const next = new Map(this.bindings);
    next.delete(id);
    this.persist(next);
  }

  private persist(next: Map<string, CollaborationBinding>): void {
    this.assertReadable();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, bindings: [...next.values()] }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.bindings = next;
  }
}

export interface CollaborationPaneCandidate extends CollaborationPaneBinding {
  cwd: string;
  isShell?: boolean;
  nativeIdentitySource?: 'argv' | 'linux-flock-owner' | null;
  nativeIdentityFailure?: string | null;
  nativeIdentityVerified?: boolean;
}

/** Metadata only: never terminal text, argv, environment or credentials. */
export interface CollaborationRouteIdentity {
  expected: CollaborationPaneBinding | null;
  observed: Array<CollaborationPaneBinding & { nativeIdentitySource: string | null; nativeIdentityFailure: string | null; nativeIdentityVerified: boolean }>;
  truncated: boolean;
  recovery: 'unchanged' | 'automatic' | 'confirmation-required';
  reason: string | null;
  rebind_command: string;
}

export function assessCollaborationRouteIdentity(binding: CollaborationBinding, panes: CollaborationPaneCandidate[], ownershipConfirmed: boolean, unconfirmedWrite: boolean) {
  const selected = selectCollaborationPane(binding, panes);
  const metadata = (pane: CollaborationPaneCandidate): CollaborationPaneBinding => ({ serverPid: pane.serverPid, sessionId: pane.sessionId,
    paneId: pane.paneId, panePid: pane.panePid, agentSlug: pane.agentSlug, nativeSessionId: pane.nativeSessionId });
  const diagnostics: CollaborationRouteIdentity = { expected: binding.pane ? { ...binding.pane } : null,
    observed: panes.slice(0, 20).map(pane => ({ ...metadata(pane), nativeIdentitySource: pane.nativeIdentitySource ?? null, nativeIdentityFailure: pane.nativeIdentityFailure ?? null, nativeIdentityVerified: pane.nativeIdentityVerified === true })),
    truncated: panes.length > 20, recovery: 'unchanged', reason: null,
    rebind_command: `td collab --session ${binding.sessionId} rebind${panes.length === 1 ? ` --pane ${panes[0].paneId}` : ''}` };
  if (selected.state !== 'identity-mismatch') return { ...selected, diagnostics };
  const nativeId = binding.pane?.nativeSessionId ?? binding.nativeSessionId;
  const slug = binding.pane?.agentSlug || binding.agentSlug;
  const matching = panes.filter(pane => !pane.isShell && pane.agentSlug === slug && pane.nativeSessionId === nativeId
    && !pane.nativeIdentityFailure && pane.nativeIdentityVerified === true);
  diagnostics.recovery = 'confirmation-required';
  diagnostics.reason = unconfirmedWrite ? 'DELIVERY_OUTCOME_UNCONFIRMED' : !ownershipConfirmed ? 'ROUTE_OWNERSHIP_UNCONFIRMED'
    : !nativeId || !slug ? 'NATIVE_IDENTITY_UNCONFIRMED' : matching.length > 1 ? 'MULTIPLE_NATIVE_IDENTITY_MATCHES'
      : matching.length !== 1 ? 'NATIVE_IDENTITY_UNCONFIRMED' : null;
  if (diagnostics.reason) return { ...selected, diagnostics };
  diagnostics.recovery = 'automatic';
  return { state: 'ready' as const, pane: matching[0], diagnostics };
}

// Once pinned, changing the active pane cannot change the recipient. A reused
// tmux name/pane after a server restart must not inherit an old peer's inbox.
export function selectCollaborationPane(
  binding: CollaborationBinding,
  panes: CollaborationPaneCandidate[],
): { state: CollaborationRouteState; pane?: CollaborationPaneCandidate; reason?: string } {
  if (binding.pane) {
    const previous = binding.pane;
    const pane = panes.find((candidate) => candidate.serverPid === previous.serverPid
      && candidate.sessionId === previous.sessionId && candidate.paneId === previous.paneId && candidate.panePid === previous.panePid);
    if (!pane) return { state: 'identity-mismatch', reason: 'TMUX_PANE_CHANGED' };
    return { state: 'ready', pane };
  }
  const candidates = panes.filter((pane) => pane.agentSlug && (!binding.agentSlug || binding.agentSlug === pane.agentSlug)
    && (!binding.nativeSessionId || !pane.nativeSessionId || binding.nativeSessionId === pane.nativeSessionId));
  const exact = binding.nativeSessionId ? candidates.filter((pane) => pane.nativeSessionId === binding.nativeSessionId) : [];
  const matches = exact.length ? exact : candidates;
  if (matches.length === 1) return { state: 'ready', pane: matches[0] };
  if (matches.length > 1) return { state: 'ambiguous', reason: 'MULTIPLE_AGENT_PANES' };
  // Agent recognition is a hint for initial selection, never a delivery gate.
  if (panes.length === 1) return { state: 'ready', pane: panes[0] };
  return panes.length ? { state: 'ambiguous', reason: 'MULTIPLE_TERMINAL_PANES' }
    : { state: 'offline', reason: 'TMUX_PANE_NOT_FOUND' };
}

/** Drive-side pane resolution. Message delivery needs an Agent (only a TUI
 *  consumes the formatted prompt, and the confirm gate searches its
 *  transcript), but driving is a terminal operation — `run` submits one line
 *  and `capture` reads the screen, both of which a plain shell answers. So an
 *  Agent pane wins when one is selectable, and the session's own pane is the
 *  fallback when there is nothing but a shell. The caller still re-asserts
 *  pane identity on every write. */
export function selectDrivePane(
  binding: CollaborationBinding,
  panes: CollaborationPaneCandidate[],
  activePaneId: string,
): { state: CollaborationRouteState; pane?: CollaborationPaneCandidate; reason?: string } {
  const agent = selectCollaborationPane(binding, panes);
  if (agent.state === 'ready' && agent.pane?.agentSlug) return agent;
  const plain = panes.find((pane) => pane.paneId === activePaneId) ?? panes[0];
  if (!plain) return agent;
  return { state: 'ready', pane: plain };
}
