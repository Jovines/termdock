// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { freshGroupSettingsDraft, readGroupSettingsDraft, writeGroupSettingsDraft } from './groupSettingsDraft';
const group = { id: 'storage-failure', name: '已保存名称', sessionIds: [], createdAt: 1, updatedAt: 1 };
const otherGroup = { ...group, id: 'other-storage-group', name: '另一组已保存名称' };
const key = (id: string) => `termdock-group-settings:${location.origin}:${id}`;
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  for (const item of [group, otherGroup]) writeGroupSettingsDraft(item.id, freshGroupSettingsDraft(item));
});
it('keeps drafts when storage writes fail but storage reads continue to return null', () => {
  sessionStorage.clear();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  writeGroupSettingsDraft(group.id, { ...freshGroupSettingsDraft(group), name: '未保存名称', rules: '尚未发布的群规' });
  expect(sessionStorage.getItem(`termdock-group-settings:${location.origin}:${group.id}`)).toBeNull();
  expect(readGroupSettingsDraft(group, '')).toMatchObject({ name: '未保存名称', rules: '尚未发布的群规', updatedAt: 1 });
  writeGroupSettingsDraft(group.id, freshGroupSettingsDraft(group));
  expect(readGroupSettingsDraft(group, '').name).toBe('已保存名称');
});

it('prefers the latest failed write over an older persisted draft and clears fallback after storage recovers', () => {
  writeGroupSettingsDraft(group.id, { ...freshGroupSettingsDraft(group), name: '旧名称草稿', rules: '旧群规草稿' });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  writeGroupSettingsDraft(group.id, { ...freshGroupSettingsDraft(group), name: '最新名称草稿', rules: '最新群规草稿' });
  expect(JSON.parse(sessionStorage.getItem(key(group.id))!).name).toBe('旧名称草稿');
  expect(readGroupSettingsDraft(group, '')).toMatchObject({ name: '最新名称草稿', rules: '最新群规草稿' });

  writeGroupSettingsDraft(group.id, { ...freshGroupSettingsDraft(group), name: '恢复后的草稿', rules: '恢复后的群规' });
  expect(readGroupSettingsDraft(group, '')).toMatchObject({ name: '恢复后的草稿', rules: '恢复后的群规' });
  // Observe storage directly after recovery so a lingering memory copy cannot mask this assertion.
  sessionStorage.setItem(key(group.id), JSON.stringify({ ...freshGroupSettingsDraft(group), name: '存储中的后续草稿' }));
  expect(readGroupSettingsDraft(group, '').name).toBe('存储中的后续草稿');
});

it('does not resurrect a discarded dirty draft when removal fails, and reads the current saved values', () => {
  writeGroupSettingsDraft(group.id, { ...freshGroupSettingsDraft(group), name: '将放弃的名称', rules: '将放弃的群规' });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new DOMException('Blocked', 'SecurityError'); });
  writeGroupSettingsDraft(group.id, freshGroupSettingsDraft(group));
  expect(sessionStorage.getItem(key(group.id))).not.toBeNull();
  const updatedGroup = { ...group, name: '服务端新名称', updatedAt: 2,
    instructions: { text: '服务端新群规', version: 'v2', updatedAt: 2, updatedBy: 'current-member' } };
  expect(readGroupSettingsDraft(updatedGroup, 'current-member')).toEqual(freshGroupSettingsDraft(updatedGroup, 'current-member'));

  writeGroupSettingsDraft(group.id, freshGroupSettingsDraft(updatedGroup));
  expect(sessionStorage.getItem(key(group.id))).toBeNull();
  // A later valid stored draft is observable after successful removal clears the tombstone.
  sessionStorage.setItem(key(group.id), JSON.stringify({ ...freshGroupSettingsDraft(updatedGroup), rules: '后来编辑的群规' }));
  expect(readGroupSettingsDraft(updatedGroup, '').rules).toBe('后来编辑的群规');
});

it('retains all conflict and publisher metadata through failed writes and unavailable reads until a successful write', () => {
  const saved = { ...group, updatedAt: 10,
    instructions: { text: '已保存群规', version: 'v10', updatedAt: 10, updatedBy: 'saved-member' } };
  const draft = { ...freshGroupSettingsDraft(saved, 'draft-member'), name: '新名称草稿', rules: '新群规草稿' };
  writeGroupSettingsDraft(group.id, { ...draft, name: '旧名称草稿', rules: '旧群规草稿' });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  writeGroupSettingsDraft(group.id, draft);
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  const changedServer = { ...saved, name: '其他客户端名称', updatedAt: 20,
    instructions: { ...saved.instructions, text: '其他客户端群规', version: 'v20' } };
  expect(readGroupSettingsDraft(changedServer, 'other-member')).toEqual(draft);
  expect(readGroupSettingsDraft(otherGroup, 'other-member')).toEqual(freshGroupSettingsDraft(otherGroup, 'other-member'));
  get.mockRestore();
  // A readable stale raw is still subordinate to the latest failed write.
  expect(readGroupSettingsDraft(changedServer, 'other-member')).toEqual(draft);
  writeGroupSettingsDraft(group.id, draft);
  const next = { ...draft, rules: '恢复后的存储草稿', rulesMemberId: 'next-member', rulesVersion: 'v11', updatedAt: 11 };
  sessionStorage.setItem(key(group.id), JSON.stringify(next));
  expect(readGroupSettingsDraft(changedServer, 'other-member')).toEqual(next);
});

it('uses fresh values when reads fail without a fallback, then reads storage after recovery', () => {
  const draft = { ...freshGroupSettingsDraft(group, 'draft-member'), rules: '存储草稿' };
  writeGroupSettingsDraft(group.id, draft);
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => { throw new DOMException('Blocked', 'SecurityError'); });
  expect(readGroupSettingsDraft(group, 'current-member')).toEqual(freshGroupSettingsDraft(group, 'current-member'));
  get.mockRestore();
  expect(readGroupSettingsDraft(group, 'current-member')).toEqual(draft);
});

it('keeps failed-write and failed-discard state isolated by group', () => {
  writeGroupSettingsDraft(group.id, { ...freshGroupSettingsDraft(group), rules: '原群规草稿' });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  writeGroupSettingsDraft(group.id, { ...freshGroupSettingsDraft(group), rules: '最新群规草稿' });
  writeGroupSettingsDraft(otherGroup.id, { ...freshGroupSettingsDraft(otherGroup), name: '另一组名称草稿' });
  expect(readGroupSettingsDraft(group, '').rules).toBe('最新群规草稿');
  expect(readGroupSettingsDraft(otherGroup, '').name).toBe('另一组名称草稿');

  vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new DOMException('Blocked', 'SecurityError'); });
  writeGroupSettingsDraft(group.id, freshGroupSettingsDraft(group));
  expect(readGroupSettingsDraft(group, '')).toEqual(freshGroupSettingsDraft(group));
  expect(readGroupSettingsDraft(otherGroup, '').name).toBe('另一组名称草稿');
});
