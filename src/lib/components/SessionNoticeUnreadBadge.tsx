import { useSessionNoticeStore } from '../stores/useSessionNoticeStore';
import { useI18n } from '../i18n';

export function SessionNoticeUnreadBadge({ sessionIds }: { sessionIds: readonly string[] }) {
  const count = useSessionNoticeStore(state => sessionIds.reduce((total, id) => total + (state.unread[id]?.length ?? 0), 0));
  const { locale } = useI18n();
  if (!count) return null;
  const label = locale === 'zh' ? `${count} 条未读进展` : `${count} unread progress updates`;
  return <span title={label} aria-label={label}
    className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-medium text-primary">
    {count > 99 ? '99+' : count}
  </span>;
}
