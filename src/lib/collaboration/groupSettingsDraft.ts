import type { CollaborationGroup } from '../terminal/api';

export interface GroupSettingsDraft {
  name: string;
  rules: string;
  savedName: string;
  savedRules: string;
  updatedAt: number;
  rulesVersion: string;
  rulesMemberId: string;
}

const fallbackDrafts = new Map<string, GroupSettingsDraft>();
const storageKey = (id: string) => `termdock-group-settings:${window.location.origin}:${id}`;
export function groupSettingsDirty(draft: GroupSettingsDraft): boolean {
  return draft.name !== draft.savedName || draft.rules !== draft.savedRules;
}

export function freshGroupSettingsDraft(group: CollaborationGroup, rulesMemberId = ''): GroupSettingsDraft {
  return { name: group.name, savedName: group.name, rules: group.instructions?.text ?? '',
    savedRules: group.instructions?.text ?? '', updatedAt: group.updatedAt,
    rulesVersion: group.instructions?.version ?? '', rulesMemberId };
}

export function readGroupSettingsDraft(group: CollaborationGroup, memberId: string): GroupSettingsDraft {
  const fresh = freshGroupSettingsDraft(group, memberId);
  try {
    const raw = sessionStorage.getItem(storageKey(group.id));
    if (!raw) return fallbackDrafts.get(storageKey(group.id)) ?? fresh;
    const draft = JSON.parse(raw) as GroupSettingsDraft;
    if (typeof draft.updatedAt !== 'number' || !Number.isFinite(draft.updatedAt)
      || ['name', 'rules', 'savedName', 'savedRules', 'rulesVersion', 'rulesMemberId'].some(key => typeof draft[key as keyof GroupSettingsDraft] !== 'string')) return fresh;
    return groupSettingsDirty(draft) ? draft : fresh;
  } catch { return fallbackDrafts.get(storageKey(group.id)) ?? fresh; }
}

// Keep drafts in this browser tab. These writes never publish names or group rules.
export function writeGroupSettingsDraft(id: string, draft: GroupSettingsDraft): void {
  const key = storageKey(id);
  fallbackDrafts.delete(key);
  try {
    if (groupSettingsDirty(draft)) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {
    if (groupSettingsDirty(draft)) fallbackDrafts.set(key, draft);
  }
}
