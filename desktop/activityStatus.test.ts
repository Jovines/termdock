import { describe, expect, it } from 'vitest';
import {
  desktopStatusTooltip,
  formatCompactDesktopStatus,
  menuBarStatusRows,
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
    expect(formatCompactDesktopStatus(summary)).toBe('运2 待1 服2');
    expect(formatCompactDesktopStatus({ runningCount: 0, reviewCount: 0, serviceCount: 3 })).toBe('服3');
    expect(desktopStatusTooltip(summary)).toContain('2 个 Agent 运行中');
  });

  it('removes a redundant single-service row and recenters activity', () => {
    expect(menuBarStatusRows({ runningCount: 2, reviewCount: 0, serviceCount: 1 })).toEqual([
      { metric: 'running', value: 2, y: 2 },
      { metric: 'review', value: 0, y: 11 },
    ]);
  });

  it('keeps the service row for disconnected and multi-service states', () => {
    expect(menuBarStatusRows({ runningCount: 0, reviewCount: 0, serviceCount: 0 }))
      .toEqual([
        { metric: 'running', value: 0, y: 0 },
        { metric: 'review', value: 0, y: 6 },
        { metric: 'services', value: 0, y: 12 },
      ]);
    expect(menuBarStatusRows({ runningCount: 1, reviewCount: 3, serviceCount: 2 }).at(-1))
      .toEqual({ metric: 'services', value: 2, y: 12 });
  });

  it('keeps general attention clicks on review windows before running services', () => {
    const services = [
      { origin: 'a', label: 'A', current: false, focused: false, runningCount: 1, reviewCount: 0 },
      { origin: 'b', label: 'B', current: true, focused: true, runningCount: 1, reviewCount: 1 },
      { origin: 'c', label: 'C', current: false, focused: false, runningCount: 1, reviewCount: 0 },
      { origin: 'd', label: 'D', current: false, focused: false, runningCount: 0, reviewCount: 0 },
    ];
    expect(nextServiceOrigin(services, 'a', 'attention')).toBe('b');
    expect(nextServiceOrigin(services, 'c', 'attention')).toBe('b');
    expect(nextServiceOrigin(services, 'b', 'review')).toBe('b');
    expect(nextServiceOrigin(services, 'd', 'running')).toBe('a');
    expect(nextServiceOrigin(services, 'd', 'all')).toBe('a');
    const withoutReview = services.map((service) => ({ ...service, reviewCount: 0 }));
    expect(nextServiceOrigin(withoutReview, 'a', 'attention')).toBe('b');
    expect(nextServiceOrigin(withoutReview, 'c', 'attention')).toBe('d');
  });
});
