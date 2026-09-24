import { useI18n } from '../../i18n';

export function FileTreeLoadingSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" className="td-loading-skeleton overflow-hidden px-3 py-2">
      <span className="sr-only">{t('common.loading')}</span>
      <div aria-hidden="true">
        {['w-2/5', 'w-3/5', 'w-1/3', 'w-1/2', 'w-2/5', 'w-1/3'].map((width, index) => (
          <div key={index} className="flex h-8 items-center gap-2" style={{ paddingLeft: index > 1 && index < 5 ? 20 : 0 }}>
            <div className="h-3 w-3 shrink-0 rounded-sm bg-surface-2" />
            <div className={`h-2 rounded bg-surface-2 ${width}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
