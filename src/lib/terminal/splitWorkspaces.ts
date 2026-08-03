export type SplitLayout = 'horizontal' | 'vertical' | 'grid';

export interface SplitWorkspace {
  id: string;
  name?: string;
  sessionIds: string[];
  layout: SplitLayout;
  ratios: number[];
}

export interface SplitWorkspaceSummary {
  id: string;
  name?: string;
  sessionIds: string[];
  layout: SplitLayout;
}

const DEFAULT_LAYOUT: SplitLayout = 'horizontal';

export function equalRatios(count: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, () => 1 / count);
}

export function normalizeRatios(ratios: unknown, count: number): number[] {
  if (!Array.isArray(ratios) || ratios.length !== count) return equalRatios(count);
  const numeric = ratios.map(Number);
  if (numeric.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) return equalRatios(count);
  const total = numeric.reduce((sum, ratio) => sum + ratio, 0);
  if (total <= 0) return equalRatios(count);
  return numeric.map((ratio) => ratio / total);
}

function isSplitLayout(value: unknown): value is SplitLayout {
  return value === 'horizontal' || value === 'vertical' || value === 'grid';
}

export function normalizeSplitWorkspaces(value: unknown): SplitWorkspace[] {
  if (!Array.isArray(value)) return [];
  const claimedSessionIds = new Set<string>();
  const claimedWorkspaceIds = new Set<string>();
  const result: SplitWorkspace[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<SplitWorkspace>;
    if (typeof candidate.id !== 'string' || !candidate.id || claimedWorkspaceIds.has(candidate.id)) continue;
    const sessionIds = Array.isArray(candidate.sessionIds)
      ? candidate.sessionIds.filter((id): id is string => (
          typeof id === 'string' && !!id && !claimedSessionIds.has(id)
        ))
      : [];
    const uniqueSessionIds = [...new Set(sessionIds)];
    if (uniqueSessionIds.length < 2) continue;
    uniqueSessionIds.forEach((id) => claimedSessionIds.add(id));
    claimedWorkspaceIds.add(candidate.id);
    result.push({
      id: candidate.id,
      ...(typeof candidate.name === 'string' && candidate.name.trim()
        ? { name: candidate.name.trim().slice(0, 80) }
        : {}),
      sessionIds: uniqueSessionIds,
      layout: isSplitLayout(candidate.layout) ? candidate.layout : DEFAULT_LAYOUT,
      ratios: normalizeRatios(candidate.ratios, uniqueSessionIds.length),
    });
  }
  return result;
}

export function pruneSplitWorkspaces(
  workspaces: SplitWorkspace[],
  validSessionIds: Iterable<string>,
): SplitWorkspace[] {
  const valid = new Set(validSessionIds);
  return workspaces.flatMap((workspace) => {
    const sessionIds = workspace.sessionIds.filter((id) => valid.has(id));
    if (sessionIds.length < 2) return [];
    return [{
      ...workspace,
      sessionIds,
      ratios: sessionIds.length === workspace.sessionIds.length
        ? normalizeRatios(workspace.ratios, sessionIds.length)
        : equalRatios(sessionIds.length),
    }];
  });
}

export function findSplitWorkspace(
  workspaces: SplitWorkspace[],
  sessionId: string | null | undefined,
): SplitWorkspace | undefined {
  if (!sessionId) return undefined;
  return workspaces.find((workspace) => workspace.sessionIds.includes(sessionId));
}

export function combineSplitWorkspaces(
  workspaces: SplitWorkspace[],
  primaryId: string,
  secondaryId: string,
): SplitWorkspace[] {
  if (!primaryId || !secondaryId || primaryId === secondaryId) return workspaces;
  const primaryWorkspace = findSplitWorkspace(workspaces, primaryId);
  const secondaryWorkspace = findSplitWorkspace(workspaces, secondaryId);
  if (primaryWorkspace && primaryWorkspace.id === secondaryWorkspace?.id) return workspaces;

  const mergedIds = [
    ...(primaryWorkspace?.sessionIds ?? [primaryId]),
    ...(secondaryWorkspace?.sessionIds ?? [secondaryId]),
  ];
  const sessionIds = [...new Set(mergedIds)];
  const nextWorkspace: SplitWorkspace = {
    id: primaryWorkspace?.id ?? `split:${primaryId}`,
    ...(primaryWorkspace?.name ? { name: primaryWorkspace.name } : {}),
    sessionIds,
    layout: primaryWorkspace?.layout ?? DEFAULT_LAYOUT,
    ratios: equalRatios(sessionIds.length),
  };
  const consumedIds = new Set([primaryWorkspace?.id, secondaryWorkspace?.id].filter(Boolean));
  const remaining = workspaces.filter((workspace) => !consumedIds.has(workspace.id));
  const insertionIndex = primaryWorkspace
    ? Math.max(0, workspaces.findIndex((workspace) => workspace.id === primaryWorkspace.id))
    : remaining.length;
  remaining.splice(Math.min(insertionIndex, remaining.length), 0, nextWorkspace);
  return remaining;
}

export function removeSplitWorkspaceForSession(
  workspaces: SplitWorkspace[],
  sessionId: string | null | undefined,
): SplitWorkspace[] {
  const workspace = findSplitWorkspace(workspaces, sessionId);
  return workspace ? workspaces.filter((candidate) => candidate.id !== workspace.id) : workspaces;
}

export function reorderSplitWorkspaceSessions(
  workspaces: SplitWorkspace[],
  workspaceId: string,
  sessionIds: string[],
): SplitWorkspace[] {
  return workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace;
    const requested = [...new Set(sessionIds)];
    const currentIds = new Set(workspace.sessionIds);
    const hasSameMembers = requested.length === workspace.sessionIds.length
      && requested.every((id) => currentIds.has(id));
    return hasSameMembers ? { ...workspace, sessionIds: requested } : workspace;
  });
}

export function renameSplitWorkspace(
  workspaces: SplitWorkspace[],
  workspaceId: string,
  name: string,
): SplitWorkspace[] {
  const trimmed = name.trim().slice(0, 80);
  return workspaces.map((workspace) => (
    workspace.id === workspaceId
      ? { ...workspace, ...(trimmed ? { name: trimmed } : { name: undefined }) }
      : workspace
  ));
}
