import { expect, it } from 'vitest';
import { collaborationUpdatedLabel } from './taskTime';
it('shows elapsed record time with minute, hour and day boundaries', () => {
  const now = new Date('2026-10-09T11:00:00+08:00').getTime();
  expect(collaborationUpdatedLabel(now + 1000, now)).toBe('刚刚更新');
  expect(collaborationUpdatedLabel(now - 59000, now)).toBe('刚刚更新');
  expect(collaborationUpdatedLabel(now - 60000, now)).toBe('1 分钟前更新');
  expect(collaborationUpdatedLabel(now - 3600000, now)).toBe('1 小时前更新');
  expect(collaborationUpdatedLabel(now - 86400000, now)).toBe('1 天前更新');
});
