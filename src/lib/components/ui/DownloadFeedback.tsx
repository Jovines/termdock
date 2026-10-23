import type { FileDownloadStatus } from '../../hooks/useFileDownload';
import { useI18n } from '../../i18n';

export function useDownloadFeedback({ status, error }: { status: FileDownloadStatus; error: string | null }): string {
  const { t } = useI18n();
  return status === 'error' ? `${t('rightSidebar.downloadFailed')}: ${error || ''}`
    : status === 'saved' ? t('rightSidebar.downloadSaved')
    : status === 'canceled' ? t('rightSidebar.downloadCanceled')
    : status === 'started' ? t('rightSidebar.downloadStarted')
    : status === 'pending' ? t('common.cancel') : t('rightSidebar.downloadFile');
}

/** Saved bytes, browser handoff and cancellation mean the same thing everywhere. */
export function DownloadFeedback({ status, error, cancel, className = 'mt-2 text-xs' }: {
  status: FileDownloadStatus; error: string | null; cancel?: () => void; className?: string;
}) {
  const message = useDownloadFeedback({ status, error });
  if (status === 'idle') return null;
  if (status === 'pending') return cancel ? <button type="button" className="min-h-9 rounded-md px-2 text-xs text-muted-foreground hover:bg-surface-2" onClick={event => { event.stopPropagation(); cancel(); }}>{message}</button> : null;
  return <div role={status === 'error' ? 'alert' : 'status'} className={`${className} ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</div>;
}
