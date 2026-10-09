// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { freshGroupSettingsDraft, readGroupSettingsDraft, writeGroupSettingsDraft } from './groupSettingsDraft';
const group = { id: 'storage-failure', name: '已保存名称', sessionIds: [], createdAt: 1, updatedAt: 1 };
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); writeGroupSettingsDraft(group.id, freshGroupSettingsDraft(group)); });
it('keeps drafts when storage writes fail but storage reads continue to return null', () => {
  sessionStorage.clear();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  writeGroupSettingsDraft(group.id, { ...freshGroupSettingsDraft(group), name: '未保存名称', rules: '尚未发布的群规' });
  expect(sessionStorage.getItem(`termdock-group-settings:${location.origin}:${group.id}`)).toBeNull();
  expect(readGroupSettingsDraft(group, '')).toMatchObject({ name: '未保存名称', rules: '尚未发布的群规', updatedAt: 1 });
  writeGroupSettingsDraft(group.id, freshGroupSettingsDraft(group));
  expect(readGroupSettingsDraft(group, '').name).toBe('已保存名称');
});
