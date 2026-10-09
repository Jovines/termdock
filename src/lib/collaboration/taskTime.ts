/** A task record timestamp, never an estimate of Agent progress. */
export function collaborationUpdatedLabel(updatedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60000);
  if (minutes < 1) return '刚刚更新';
  if (minutes < 60) return `${minutes} 分钟前更新`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前更新`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} 天前更新`;
  return `${new Date(updatedAt).toLocaleDateString([], { month: 'numeric', day: 'numeric' })} 更新`;
}
