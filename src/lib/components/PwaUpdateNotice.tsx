import { useState } from 'react';
import { useI18n } from '../i18n';
import { applyPwaUpdate, usePwaUpdateAvailable } from '../utils/pwaUpdate';

export function PwaUpdateNotice() {
  const available = usePwaUpdateAvailable();
  const [dismissed, setDismissed] = useState(false);
  const { locale } = useI18n();
  if (!available || dismissed) return null;
  const chinese = locale === 'zh';
  return (
    <div role="status" className="fixed bottom-16 left-1/2 z-toast flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground shadow-lg">
      <span>{chinese ? '新版本已就绪' : 'An update is ready'}</span>
      <button type="button" className="whitespace-nowrap text-primary" onClick={applyPwaUpdate}>
        {chinese ? '重新加载' : 'Reload'}
      </button>
      <button type="button" className="whitespace-nowrap text-muted-foreground" onClick={() => setDismissed(true)}>
        {chinese ? '稍后' : 'Later'}
      </button>
    </div>
  );
}
