import { ArrowUp, Home, RefreshCw } from 'lucide-react';
import { useI18n } from '../../i18n';

interface Action {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  title?: string;
}

/** Shared controls; callers supply their scope and keep their selection actions. */
export function FileBrowserNavigationActions({ parent, root, refresh, buttonClassName, iconSize = 14 }: {
  parent: Action;
  root?: Action;
  refresh?: Action;
  buttonClassName?: string;
  iconSize?: number;
}) {
  const { t } = useI18n();
  const className = buttonClassName ?? 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:opacity-30';
  return <>{[
    { action: parent, Icon: ArrowUp, label: t('rightSidebar.parentFolder') },
    { action: root, Icon: Home, label: t('rightSidebar.backToProjectRoot') },
    { action: refresh, Icon: RefreshCw, label: t('rightSidebar.refreshFiles') },
  ].map(({ action, Icon, label }, index) => action && <button key={index} type="button" onClick={action.onClick} disabled={action.disabled} className={className} aria-label={action.label ?? label} title={action.title ?? action.label ?? label}><Icon size={iconSize} /></button>)}</>;
}
