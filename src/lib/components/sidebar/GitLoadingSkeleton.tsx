import { useI18n } from '../../i18n';

/** Keep the Git action layout consistent across chunk, gesture and data loading. */
export function GitLoadingSkeleton({ slow = false }: { slow?: boolean }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t('rightSidebar.loadingGitChanges')} className="relative h-full min-h-0 overflow-hidden bg-surface px-3">
      <span className="sr-only">{t('rightSidebar.loadingGitChanges')}</span>
      <div aria-hidden="true">
        <div className="flex h-[76px] items-center gap-2 border-b border-border/40 px-2">
          <div className="h-6 w-6 rounded-md bg-surface-2" />
          <div className="space-y-2">
            <div className="h-3 w-16 rounded bg-surface-2" />
            <div className="h-2 w-12 rounded bg-surface-2" />
          </div>
        </div>
        <div className="flex h-11 items-center gap-2 px-1 pt-3">
          <div className="h-6 w-6 rounded-md bg-surface-2" />
          <div className="h-3 w-16 rounded bg-surface-2" />
          <div className="ml-auto h-4 w-12 rounded-full bg-surface-2" />
        </div>
        {[false, true].map((withHint) => (
          <div key={String(withHint)} className="border-b border-border/40 px-1 py-4">
            <div className="mb-2 flex h-8 items-center justify-between">
              <div className="space-y-2">
                <div className="h-3 w-14 rounded bg-surface-2" />
                {withHint && <div className="h-2 w-28 rounded bg-surface-2" />}
              </div>
              <div className="h-8 w-12 rounded-md bg-surface-2" />
            </div>
            <div className="h-10 rounded-md bg-surface-2" />
          </div>
        ))}
        <div className="flex h-[69px] items-center border-b border-border/40 px-2">
          <div className="h-3 w-16 rounded bg-surface-2" />
        </div>
        <div className="space-y-2 px-1 py-4">
          <div className="flex h-8 items-center justify-between">
            <div className="h-3 w-14 rounded bg-surface-2" />
            <div className="h-8 w-28 rounded-md bg-surface-2" />
          </div>
          <div className="h-7 rounded-md bg-surface-2" />
          <div className="h-10 rounded-md bg-surface-2" />
        </div>
      </div>
      {slow && (
        <div className="absolute inset-x-3 bottom-3 rounded-md bg-surface-elevated px-3 py-2 text-xs text-muted-foreground">
          {t('rightSidebar.loadingGitChangesSlow')}
        </div>
      )}
    </div>
  );
}
