import { useI18n } from '../../i18n';

/** Shared by the lazy sidebar shell and the first Git request. */
export function ChangesLoadingSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t('rightSidebar.loadingGitChanges')} className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <span className="sr-only">{t('rightSidebar.loadingGitChanges')}</span>
      <div aria-hidden="true" className="shrink-0 border-b border-border/15 px-3 py-2">
        <div className="mb-2 flex h-5 items-center gap-1">
          <div className="h-4 w-16 rounded bg-surface-2" />
          <div className="h-4 w-7 rounded bg-surface-2" />
          <div className="h-4 w-12 rounded bg-surface-2" />
        </div>
        <div className="flex h-[15px] items-center justify-between">
          <div className="h-2 w-14 rounded bg-surface-2" />
          <div className="h-2 w-6 rounded bg-surface-2" />
        </div>
        <div className="mt-2 flex h-7 items-center gap-1.5">
          <div className="h-7 w-12 rounded-full bg-surface-2" />
          <div className="h-7 w-16 rounded-full bg-surface-2" />
          <div className="h-3 w-24 max-w-[30%] rounded bg-surface-2" />
          <div className="ml-auto h-4 w-4 rounded-full bg-surface-2" />
        </div>
      </div>
      <div aria-hidden="true" className="overflow-hidden px-3 py-2">
        <div className="flex h-8 items-center gap-2">
          <div className="h-3 w-3 rounded-sm bg-surface-2" />
          <div className="h-2 w-32 max-w-[55%] rounded bg-surface-2" />
        </div>
        {['w-3/5', 'w-2/5', 'w-1/2', 'w-1/3'].map((width, index) => (
          <div key={width} className="flex h-9 items-center gap-2 pl-5" style={{ opacity: 1 - index * 0.15 }}>
            <div className="h-3 w-3 shrink-0 rounded-sm bg-surface-2" />
            <div className={`h-2 rounded bg-surface-2 ${width}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
