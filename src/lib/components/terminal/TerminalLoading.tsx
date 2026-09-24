import { useI18n } from '../../i18n';
import { LoadingStatus } from '../ui/Loading';

interface TerminalLoadingProps {
  message?: string;
}

export function TerminalLoading({ message }: TerminalLoadingProps) {
  const { t } = useI18n();
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4">
      <LoadingStatus dots label={message ?? t('terminal.loading')}
        className="max-w-full rounded-full bg-surface-2 px-4 py-2 text-center shadow-sm" />
    </div>
  );
}

export function TerminalInitializing() {
  const { t } = useI18n();
  return <TerminalLoading message={t('terminal.initializing')} />;
}
