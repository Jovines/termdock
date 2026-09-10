import fs from 'node:fs';
import path from 'node:path';

export type CollaborationRouteState = 'recovering' | 'detached' | 'ready' | 'agent-exited' | 'offline' | 'ambiguous' | 'identity-mismatch' | 'unavailable';

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
    if (!pane.agentSlug) return { state: 'agent-exited', reason: 'AGENT_NOT_RUNNING' };
    if (pane.agentSlug !== previous.agentSlug || (previous.nativeSessionId && pane.nativeSessionId && previous.nativeSessionId !== pane.nativeSessionId)) {
      return { state: 'identity-mismatch', reason: 'AGENT_IDENTITY_CHANGED' };
    }
    return { state: 'ready', pane };
  }
  const candidates = panes.filter((pane) => pane.agentSlug && (!binding.agentSlug || binding.agentSlug === pane.agentSlug)
    && (!binding.nativeSessionId || !pane.nativeSessionId || binding.nativeSessionId === pane.nativeSessionId));
  const exact = binding.nativeSessionId ? candidates.filter((pane) => pane.nativeSessionId === binding.nativeSessionId) : [];
  const matches = exact.length ? exact : candidates;
  if (matches.length === 1) return { state: 'ready', pane: matches[0] };
  if (!matches.length && panes.some((pane) => pane.agentSlug)) return { state: 'identity-mismatch', reason: 'AGENT_IDENTITY_CHANGED' };
  return matches.length > 1 ? { state: 'ambiguous', reason: 'MULTIPLE_AGENT_PANES' }
    : { state: 'agent-exited', reason: 'AGENT_NOT_RUNNING_OR_IDENTITY_CHANGED' };
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
