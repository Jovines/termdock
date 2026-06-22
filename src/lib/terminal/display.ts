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
): { primary: string; secondary: string | null } {
  if (session.customName) return { primary: session.name, secondary: getCwdLeafName(cwd) };

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
): string {
  return getSessionDisplayLines(session, activeProgram, cwd, shellNames).primary;
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

// 单一真相：根据分组开关，派生出贯穿式分组顺序。
// 顶栏 tab 与 Swiper 各自调用、结果确定性一致，保证「渲染顺序严格同序同集合」。
//   - arranged：分组聚拢后的完整顺序（所有 session）→ 驱动 DOM 渲染顺序 + Swiper
//   - groups：  顶栏胶囊 / 侧边栏渲染组用
// 注：所有 tab 常显、滑动连续穿过全部，不做折叠 / 激活组隐藏。
export function deriveGroupedOrder<T extends { id: string }>(
  sessions: T[],
  cwdOf: (session: T) => string | null,
  groupByFolder: boolean,
  ungroupedLabel: string,
): { arranged: T[]; groups: FolderGroup<T>[] } {
  if (!groupByFolder) {
    return { arranged: sessions, groups: [] };
  }
  const groups = buildFolderGroups(sessions, cwdOf, ungroupedLabel);
  const arranged = groups.flatMap((g) => g.sessions);
  return { arranged, groups };
}


