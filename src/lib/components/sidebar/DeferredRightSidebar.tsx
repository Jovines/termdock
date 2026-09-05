import { lazy, Suspense, useEffect, useRef, type ComponentProps } from 'react';
import { scheduleInteractionIdle } from '../../utils/interactionIdle';
import { Sidebar } from './Sidebar';
import { useI18n } from '../../i18n';

const loadSidebar = () => import('./RightSidebar').then((module) => ({ default: module.RightSidebar }));
const LoadedSidebar = lazy(loadSidebar);
type Props = ComponentProps<typeof LoadedSidebar>;

/** Keep the edge gesture available without loading preview engines at startup. */
export function DeferredRightSidebar(props: Props) {
  const opened = useRef(false);
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (connection?.saveData || /2g|3g/.test(connection?.effectiveType ?? '')) return;
    return scheduleInteractionIdle(() => { void loadSidebar().catch(() => undefined); }, 3000);
  }, []);
  const { t } = useI18n();
  if (props.isOpen || props.pinned) opened.current = true;
  const shell = (
    <Sidebar side="right" isOpen={props.isOpen} drawerWidthPx={props.drawerWidthPx}
      onClose={props.onClose} onOpen={props.onOpen} pinned={props.pinned}>
      <div className="p-4 text-sm text-muted-foreground" role="status">{t('common.loading')}</div>
    </Sidebar>
  );
  return opened.current ? <Suspense fallback={shell}><LoadedSidebar {...props} /></Suspense> : shell;
}
