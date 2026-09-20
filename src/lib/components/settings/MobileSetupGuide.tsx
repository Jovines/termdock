import { useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';
import { useI18n } from '../../i18n';
import type { LocalAccessState } from '../../terminal/api';

export function MobileSetupGuide({ state, onCopy, copied }: {
  state: LocalAccessState;
  onCopy: (url: string) => void;
  copied: boolean;
}) {
  const { t } = useI18n();
  const [qr, setQr] = useState<string | null>(null);
  // Older services still return the removed guide URL; both support /ca.
  const certificateUrl = state.caAvailable && state.onboardingUrl
    ? new URL('/ca', state.onboardingUrl).href : null;
  useEffect(() => {
    let canceled = false;
    setQr(null);
    if (certificateUrl) {
      void toDataURL(certificateUrl, { width: 180, margin: 2, errorCorrectionLevel: 'M' })
        .then((data) => { if (!canceled) setQr(data); })
        .catch(() => { /* The copyable URL remains available. */ });
    }
    return () => { canceled = true; };
  }, [certificateUrl]);
  return (
    <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
      <p>{t('settings.mobileSetupIntro')}</p>
      {state.httpsEnabled && (
        <section className="space-y-3 rounded-xl bg-surface-2 p-3">
          <h3 className="font-medium text-foreground">{t('settings.mobileSetupDownload')}</h3>
          {certificateUrl ? (
            <>
              {qr && <img src={qr} alt={t('settings.mobileSetupDownload')} className="h-44 w-44 rounded-lg" />}
              <button type="button" onClick={() => onCopy(certificateUrl)} className="flex w-full items-center justify-between gap-3 rounded-lg bg-surface p-2 text-left">
                <span className="break-all">{certificateUrl}</span>
                <span className="shrink-0 text-primary">{copied ? t('rightSidebar.copied') : t('common.copy')}</span>
              </button>
            </>
          ) : <p>{t('settings.caMissing')}</p>}
          <p>{t('settings.mobileSetupIos')}</p>
          <p>{t('settings.mobileSetupAndroid')}</p>
        </section>
      )}
      <h3 className="font-medium text-foreground">{state.httpsEnabled ? t('settings.mobileSetupConnect') : t('settings.localAccess')}</h3>
      <p>{t('settings.mobileSetupConnectHint')}</p>
    </div>
  );
}
