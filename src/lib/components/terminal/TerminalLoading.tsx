import React from 'react';
import { useI18n } from '../../i18n';

interface TerminalLoadingProps {
  message?: string;
}

export const TerminalLoading: React.FC<TerminalLoadingProps> = ({ message }) => {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="rounded-full bg-surface-2 px-4 py-2 flex items-center gap-3 shadow-sm">
        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">{message ?? t('terminal.loading')}</span>
      </div>
    </div>
  );
};

export const TerminalInitializing: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="rounded-full bg-surface-2 px-4 py-2 flex items-center gap-3 shadow-sm">
        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">{t('terminal.initializing')}</span>
      </div>
    </div>
  );
};
