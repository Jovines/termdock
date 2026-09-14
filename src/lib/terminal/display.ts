import type { TerminalMode } from './types';

export const DEFAULT_SESSION_DISPLAY_SHELL_NAMES = new Set([
  'bash',
  'zsh',
  'fish',
  'sh',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
]);

export function getCwdLeafName(cwd: string | null): string | null {
  if (!cwd) return null;
  if (cwd === '/') return '/';
  const segments = cwd.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || cwd;
}

export function getSessionDisplayLines(
  session: { name: string; customName?: boolean; mode?: TerminalMode },
  activeProgram: string | null,
  cwd: string | null,
  shellNames: ReadonlySet<string> = DEFAULT_SESSION_DISPLAY_SHELL_NAMES,
  shellTitle: string | null = null,
  promptState: 'idle' | 'running' | null = null,
): { primary: string; secondary: string | null } {
  if (session.customName) return { primary: session.name, secondary: getCwdLeafName(cwd) };

  // Shell integration (OSC 2) provides real-time title: command name when running,
  // cwd when idle. This is faster and more accurate than server-side process polling.
  if (shellTitle) {
    const cwdLeaf = getCwdLeafName(cwd);
    const titleLooksLikeCwd = shellTitle === cwd || shellTitle === cwdLeaf;
    // If the shell reports a running state, the title is the command name.
    if (promptState !== 'idle' && !shellNames.has(shellTitle) && !titleLooksLikeCwd) {
      return { primary: shellTitle, secondary: cwdLeaf };
    }
    // If idle, the title is typically the cwd — fall through to show cwd leaf.
  }

  if (activeProgram && !shellNames.has(activeProgram)) {
    return { primary: activeProgram, secondary: getCwdLeafName(cwd) };
  }

  const dir = getCwdLeafName(cwd);
  if (dir) return { primary: dir, secondary: null };
  return { primary: session.name, secondary: null };
}

export function getSessionDisplayName(
  session: { name: string; customName?: boolean; mode?: TerminalMode },
  activeProgram: string | null,
  cwd: string | null,
  shellNames: ReadonlySet<string> = DEFAULT_SESSION_DISPLAY_SHELL_NAMES,
  shellTitle: string | null = null,
  promptState: 'idle' | 'running' | null = null,
): string {
  return getSessionDisplayLines(session, activeProgram, cwd, shellNames, shellTitle, promptState).primary;
}

export interface FolderGroup<T> {
  // 完整 cwd 作为稳定 key（折叠状态持久化用）；无 cwd 的会话归到 '' 组。
  key: string;
  label: string;
  sessions: T[];
}

// 按 cwd 把会话归组，组的先后顺序 = 该组首个会话在列表中的出现顺序，
// 这样开/关分组时视觉跳动最小。无 cwd 的会话统一进末尾的「其他」组。
export function buildFolderGroups<T extends { id: string }>(
  sessions: T[],
  cwdOf: (session: T) => string | null,
  ungroupedLabel: string,
): FolderGroup<T>[] {
  const groups: FolderGroup<T>[] = [];
  const byKey = new Map<string, FolderGroup<T>>();
  for (const session of sessions) {
    const cwd = cwdOf(session);
    const key = cwd && cwd.trim().length > 0 ? cwd : '';
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: key ? (getCwdLeafName(key) ?? key) : ungroupedLabel, sessions: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.sessions.push(session);
  }
  // 「其他」组永远排最后。
  return groups.sort((a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0));
}

// 折叠组归属判断用的 group key（与 buildFolderGroups 一致）。
export function folderGroupKeyForCwd(cwd: string | null): string {
  return cwd && cwd.trim().length > 0 ? cwd : '';
}

// 整组顺序拖动：把第 sourceGroupIndex 个组整体移动到 destGroupIndex，
// 返回扁平的 session id 列表（组内顺序不变）。回写后 buildFolderGroups 会按
// 首次出现顺序重新派生出同样的组顺序，实现「组之间排序」。
// 注：'' 组（未分组）始终被 buildFolderGroups 排到最后，调用方应禁用其拖动。
export function reorderGroupedSessionIds<T extends { id: string }>(
  groups: FolderGroup<T>[],
  sourceGroupIndex: number,
  destGroupIndex: number,
): string[] {
  const next = [...groups];
  const [moved] = next.splice(sourceGroupIndex, 1);
  if (!moved) return groups.flatMap((g) => g.sessions.map((s) => s.id));
  next.splice(destGroupIndex, 0, moved);
  return next.flatMap((g) => g.sessions.map((s) => s.id));
}

// 组内排序：把指定组里第 sourceIndex 个 session 移动到 destIndex，
// 其他组保持原样，返回扁平的 session id 列表。
export function reorderSessionsWithinGroup<T extends { id: string }>(
  groups: FolderGroup<T>[],
  groupKey: string,
  sourceIndex: number,
  destIndex: number,
): string[] {
  return groups.flatMap((group) => {
    if (group.key !== groupKey) return group.sessions.map((s) => s.id);
    const ids = group.sessions.map((s) => s.id);
    const [moved] = ids.splice(sourceIndex, 1);
    if (moved === undefined) return group.sessions.map((s) => s.id);
    ids.splice(destIndex, 0, moved);
    return ids;
  });
}

export interface SessionOrderGroup {
  sessionIds: string[];
  federated?: boolean;
}

export function normalizeSessionOrderGroups<T extends SessionOrderGroup>(
  groups: readonly T[],
  availableSessionIds: ReadonlySet<string>,
): T[] {
  const claimed = new Set<string>();
  return groups.flatMap((group) => {
    const sessionIds = [...new Set(group.sessionIds)].filter((id) => availableSessionIds.has(id) && !claimed.has(id));
    if (sessionIds.length < (group.federated ? 1 : 2)) return [];
    sessionIds.forEach((id) => claimed.add(id));
    return [{ ...group, sessionIds }];
  });
}

// Shared visual order for the sidebar, tabs and terminal navigation. Collaboration
// owns its members; a fully contained split orders panes inside that collaboration.
// Cross-folder entities follow their first member's directory.
export function deriveGroupedOrder<T extends { id: string }>(
  sessions: T[],
  cwdOf: (session: T) => string | null,
  groupByFolder: boolean,
  ungroupedLabel: string,
  workspaces: readonly SessionOrderGroup[] = [],
  collaborations: readonly SessionOrderGroup[] = [],
): { arranged: T[]; groups: FolderGroup<T>[] } {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const groups = normalizeSessionOrderGroups(collaborations, new Set(byId.keys()));
  const entityById = new Map<string, string[]>();
  const anchorById = new Map<string, T>();
  const validSplits = workspaces.filter((workspace) => workspace.sessionIds.length >= 2
    && workspace.sessionIds.every((id) => byId.has(id)));
  const attach = (ids: string[], anchorId: string) => {
    const anchor = byId.get(anchorId)!;
    ids.forEach((id) => { entityById.set(id, ids); anchorById.set(id, anchor); });
  };
  for (const group of groups) {
    const memberIds = new Set(group.sessionIds);
    const splitById = new Map<string, string[]>();
    for (const split of validSplits) {
      if (split.sessionIds.every((id) => memberIds.has(id))) {
        split.sessionIds.forEach((id) => splitById.set(id, split.sessionIds));
      }
    }
    const emitted = new Set<string>();
    const orderedIds = group.sessionIds.flatMap((id) => {
      if (emitted.has(id)) return [];
      const ids = splitById.get(id) ?? [id];
      ids.forEach((memberId) => emitted.add(memberId));
      return ids;
    });
    attach(orderedIds, group.sessionIds[0]);
  }
  for (const split of validSplits) {
    if (!split.sessionIds.some((id) => entityById.has(id))) attach(split.sessionIds, split.sessionIds[0]);
  }
  const arrange = (items: T[]) => {
    const emitted = new Set<string>();
    return items.flatMap((session) => {
      if (emitted.has(session.id)) return [];
      const ids = entityById.get(session.id) ?? [session.id];
      ids.forEach((id) => emitted.add(id));
      return ids.map((id) => byId.get(id)!);
    });
  };
  if (!groupByFolder) return { arranged: arrange(sessions), groups: [] };
  const folderGroups = buildFolderGroups(
    sessions,
    (session) => cwdOf(anchorById.get(session.id) ?? session),
    ungroupedLabel,
  ).map((group) => ({ ...group, sessions: arrange(group.sessions) }));
  return { arranged: folderGroups.flatMap((group) => group.sessions), groups: folderGroups };
}
