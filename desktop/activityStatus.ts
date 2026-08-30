import type { DesktopServiceActivity, DesktopStatusSummary } from './types.js';

export interface ServiceActivityCount {
  runningCount: number;
  reviewCount: number;
}

export type ActivityFocusScope = 'attention' | 'running' | 'review' | 'all';

export function normalizeActivityCount(value: unknown): number {
  return Math.min(999, Math.max(0,
    typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0,
  ));
}

export function normalizeServiceActivity(activity: {
  runningCount?: unknown;
  reviewCount?: unknown;
} | null | undefined): ServiceActivityCount {
  return {
    runningCount: normalizeActivityCount(activity?.runningCount),
    reviewCount: normalizeActivityCount(activity?.reviewCount),
  };
}

export function mergeServiceActivity(
  reported: ServiceActivityCount | undefined,
  observed: ServiceActivityCount | undefined,
): ServiceActivityCount {
  return {
    runningCount: Math.max(reported?.runningCount ?? 0, observed?.runningCount ?? 0),
    reviewCount: Math.max(reported?.reviewCount ?? 0, observed?.reviewCount ?? 0),
  };
}

export function summarizeServiceActivity(
  services: DesktopServiceActivity[],
): DesktopStatusSummary {
  return {
    runningCount: services.reduce((total, service) => total + service.runningCount, 0),
    reviewCount: services.reduce((total, service) => total + service.reviewCount, 0),
    serviceCount: services.length,
  };
}

export function formatCompactDesktopStatus(summary: DesktopStatusSummary): string {
  const parts: string[] = [];
  if (summary.runningCount > 0) parts.push(`运行${summary.runningCount}`);
  if (summary.reviewCount > 0) parts.push(`待办${summary.reviewCount}`);
  parts.push(`服务${summary.serviceCount}`);
  return parts.join('  ');
}

export function desktopStatusTooltip(summary: DesktopStatusSummary): string {
  return [
    `${summary.runningCount} 个 Agent 运行中`,
    `${summary.reviewCount} 个待处理`,
    `${summary.serviceCount} 个服务已连接`,
  ].join(' · ');
}

export function nextServiceOrigin(
  services: DesktopServiceActivity[],
  currentOrigin: string | null,
  scope: ActivityFocusScope,
): string | null {
  const review = services.filter((service) => service.reviewCount > 0);
  const running = services.filter((service) => service.runningCount > 0);
  let candidates: DesktopServiceActivity[];
  if (scope === 'review') {
    candidates = review;
  } else if (scope === 'running') {
    candidates = running;
  } else if (scope === 'attention') {
    candidates = [
      ...review,
      ...running.filter((service) => service.reviewCount === 0),
    ];
  } else {
    candidates = services;
  }
  if (candidates.length === 0) candidates = services;
  if (candidates.length === 0) return null;
  const currentIndex = currentOrigin
    ? candidates.findIndex((service) => service.origin === currentOrigin)
    : -1;
  return candidates[(currentIndex + 1) % candidates.length]?.origin ?? null;
}
