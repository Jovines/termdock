import type { CollaborationBinding, CollaborationRoutingStore } from './collaborationRouting.js';

interface SessionRecord {
  sessionId: string;
  backendSessionId: string | null;
  mode: string;
  tmuxSessionName: string | null;
  agentResume?: { slug: string; sessionId: string | null } | null;
}

interface LiveBackend {
  mode: string;
  tmuxSessionName: string | null;
  agent: { slug: string } | null;
  agentSession: { sessionId: string | null } | null;
}

export function resolveCollaborationBackend<T extends LiveBackend>(
  record: SessionRecord,
  records: readonly SessionRecord[],
  backends: ReadonlyMap<string, T>,
  routing: CollaborationRoutingStore,
): [string, T] | null {
  routing.assertReadable();
  const binding = routing.get(record.sessionId);
  const target = binding ? { ...record, mode: binding.mode, tmuxSessionName: binding.tmuxSessionName,
    backendSessionId: binding.backendSessionId,
    agentResume: binding.agentSlug ? { slug: binding.agentSlug, sessionId: binding.nativeSessionId } : record.agentResume } : record;
  const existing = target.backendSessionId ? backends.get(target.backendSessionId) : null;
  const recovered = existing && existing.mode === target.mode && existing.tmuxSessionName === target.tmuxSessionName
    ? [target.backendSessionId!, existing] as [string, T]
    : recoverSessionBinding({ ...target, backendSessionId: null }, records, backends, binding);
  if (!recovered) return null;
  const [id, backend] = recovered;
  if (backend.mode !== 'shell' && backend.mode !== 'tmux') return null;
  const owner = routing.ownerOfBackend(id);
  if (owner && owner !== record.sessionId) return null;
  if (records.some((other) => other.sessionId !== record.sessionId && other.backendSessionId === id)) return null;
  routing.bind({ sessionId: record.sessionId, backendSessionId: id, mode: backend.mode,
    tmuxSessionName: backend.tmuxSessionName,
    agentSlug: binding?.agentSlug ?? backend.agent?.slug ?? record.agentResume?.slug ?? null,
    nativeSessionId: binding?.nativeSessionId ?? backend.agentSession?.sessionId ?? record.agentResume?.sessionId ?? null,
    pane: binding?.pane ?? null });
  return recovered;
}

// Match live runtime evidence, never the search index or a title/cwd heuristic.
export function recoverSessionBinding<T extends LiveBackend>(
  record: SessionRecord,
  records: readonly SessionRecord[],
  backends: ReadonlyMap<string, T>,
  binding: CollaborationBinding | null,
): [string, T] | null {
  if (binding && binding.sessionId !== record.sessionId) return null;
  if (record.backendSessionId && backends.has(record.backendSessionId)) return null;
  const nativeSessionId = binding?.nativeSessionId ?? record.agentResume?.sessionId;
  const agentSlug = binding?.agentSlug ?? record.agentResume?.slug;
  const candidates = [...backends].filter(([id, backend]) => {
    if (records.some((other) => other.sessionId !== record.sessionId && other.backendSessionId === id)) return false;
    if (backend.mode !== record.mode) return false;
    if (record.tmuxSessionName && backend.tmuxSessionName !== record.tmuxSessionName) return false;
    const nativeId = backend.agentSession?.sessionId;
    const slug = backend.agent?.slug;
    if (agentSlug && slug && agentSlug !== slug) return false;
    if (nativeSessionId && nativeId && nativeSessionId !== nativeId) return false;
    if (record.agentResume && slug && record.agentResume.slug !== slug) return false;
    if (record.agentResume?.sessionId && nativeId && record.agentResume.sessionId !== nativeId) return false;
    const tmuxMatch = record.mode === 'tmux' && Boolean(record.tmuxSessionName)
      && backend.tmuxSessionName === record.tmuxSessionName;
    const nativeMatch = Boolean(nativeId) && nativeSessionId === nativeId && agentSlug === slug;
    return tmuxMatch || nativeMatch;
  });
  return candidates.length === 1 ? candidates[0] : null;
}
