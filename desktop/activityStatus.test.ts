import { describe, expect, it } from 'vitest';
import {
  desktopStatusTooltip,
  formatCompactDesktopStatus,
  mergeServiceActivity,
  nextServiceOrigin,
  normalizeServiceActivity,
  summarizeServiceActivity,
} from './activityStatus.js';

describe('desktop activity status', () => {
  it('normalizes untrusted renderer counts', () => {
    expect(normalizeServiceActivity({ runningCount: 2.9, reviewCount: -4 })).toEqual({
      runningCount: 2,
      reviewCount: 0,
    });
    expect(normalizeServiceActivity({ runningCount: Number.POSITIVE_INFINITY, reviewCount: 5000 })).toEqual({
      runningCount: 0,
      reviewCount: 999,
    });
  });

  it('keeps native observation when an old or stale page reports zero', () => {
    expect(mergeServiceActivity(
      { runningCount: 0, reviewCount: 0 },
      { runningCount: 2, reviewCount: 1 },
    )).toEqual({ runningCount: 2, reviewCount: 1 });
  });

  it('summarizes services and omits zero activity from compact text', () => {
    const services = [
      { origin: 'https://a.test', label: 'A', current: true, focused: true, runningCount: 2, reviewCount: 0 },
      { origin: 'https://b.test', label: 'B', current: false, focused: false, runningCount: 0, reviewCount: 1 },
    ];
    const summary = summarizeServiceActivity(services);
    expect(summary).toEqual({ runningCount: 2, reviewCount: 1, serviceCount: 2 });
    expect(formatCompactDesktopStatus(summary)).toBe('运行2  待办1  服务2');
    expect(formatCompactDesktopStatus({ runningCount: 0, reviewCount: 0, serviceCount: 3 })).toBe('服务3');
    expect(desktopStatusTooltip(summary)).toContain('2 个 Agent 运行中');
  });

  it('cycles review first, then running services, and falls back to all', () => {
    const services = [
      { origin: 'a', label: 'A', current: false, focused: false, runningCount: 1, reviewCount: 0 },
      { origin: 'b', label: 'B', current: true, focused: true, runningCount: 1, reviewCount: 1 },
      { origin: 'c', label: 'C', current: false, focused: false, runningCount: 1, reviewCount: 0 },
      { origin: 'd', label: 'D', current: false, focused: false, runningCount: 0, reviewCount: 0 },
    ];
    expect(nextServiceOrigin(services, 'a', 'attention')).toBe('c');
    expect(nextServiceOrigin(services, 'c', 'attention')).toBe('b');
    expect(nextServiceOrigin(services, 'b', 'review')).toBe('b');
    expect(nextServiceOrigin(services, 'd', 'running')).toBe('a');
    expect(nextServiceOrigin(services, 'd', 'all')).toBe('a');
  });
});
