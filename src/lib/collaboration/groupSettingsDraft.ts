import type { CollaborationGroup } from '../terminal/api';

export interface GroupSettingsDraft {
  name: string;
  rules: string;
  savedName: string;
  savedRules: string;
  updatedAt: number;
  rulesVersion: string;
  rulesMemberId: string;
  // The explicitly confirmed member snapshot must survive closing/reopening.
  sessionIds?: string[];
}

// null records a failed removal so an older stored draft cannot reappear.
const fallbackDrafts = new Map<string, GroupSettingsDraft | null>();
const storageKey = (id: string) => `termdock-group-settings:${window.location.origin}:${id}`;
export function groupSettingsDirty(draft: GroupSettingsDraft): boolean {
  return draft.name !== draft.savedName || draft.rules !== draft.savedRules;
}

export function freshGroupSettingsDraft(group: CollaborationGroup, rulesMemberId = ''): GroupSettingsDraft {
  return { name: group.name, savedName: group.name, rules: group.instructions?.text ?? '',
    savedRules: group.instructions?.text ?? '', updatedAt: group.updatedAt,
    rulesVersion: group.instructions?.version ?? '', rulesMemberId };
}

export function rebaseGroupSettingsDraft(draft: GroupSettingsDraft, group: CollaborationGroup): GroupSettingsDraft {
  return { ...freshGroupSettingsDraft(group, group.sessionIds.includes(draft.rulesMemberId) ? draft.rulesMemberId : ''),
    name: draft.name !== draft.savedName ? draft.name : group.name,
    rules: draft.rules !== draft.savedRules ? draft.rules : group.instructions?.text ?? '',
    sessionIds: [...group.sessionIds] };
}

export function readGroupSettingsDraft(group: CollaborationGroup, memberId: string): GroupSettingsDraft {
  const fresh = freshGroupSettingsDraft(group, memberId);
  const key = storageKey(group.id);
  if (fallbackDrafts.has(key)) return fallbackDrafts.get(key) ?? fresh;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fresh;
    const draft = JSON.parse(raw) as GroupSettingsDraft;
    if (typeof draft.updatedAt !== 'number' || !Number.isFinite(draft.updatedAt)
      || ['name', 'rules', 'savedName', 'savedRules', 'rulesVersion', 'rulesMemberId'].some(key => typeof draft[key as keyof GroupSettingsDraft] !== 'string')
      || (draft.sessionIds !== undefined && (!Array.isArray(draft.sessionIds) || draft.sessionIds.some(id => typeof id !== 'string')))) return fresh;
    return groupSettingsDirty(draft) ? draft : fresh;
  } catch { return fresh; }
}

// Keep drafts in this browser tab. These writes never publish names or group rules.
export function writeGroupSettingsDraft(id: string, draft: GroupSettingsDraft): void {
  const key = storageKey(id);
  try {
    if (groupSettingsDirty(draft)) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
    fallbackDrafts.delete(key);
  } catch {
    fallbackDrafts.set(key, groupSettingsDirty(draft) ? draft : null);
  }
}
