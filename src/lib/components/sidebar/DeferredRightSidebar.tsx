import { lazy, Suspense, useEffect, useRef, type ComponentProps } from 'react';
import { X } from 'lucide-react';
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 px-3 py-2">
          <div aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 motion-safe:animate-pulse">
            <div className="h-7 w-7 rounded-lg bg-surface-elevated" />
            <div className="h-2 w-28 max-w-[50%] rounded-full bg-surface-elevated" />
          </div>
          <button type="button" onClick={props.onClose} aria-label={t('common.close')}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95">
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden bg-surface px-4 py-5" role="status" aria-label={t('common.loading')}>
          <span className="sr-only">{t('common.loading')}</span>
          <div aria-hidden="true" className="space-y-5 motion-safe:animate-pulse">
            <div className="mb-7 flex items-center gap-2">
              <div className="h-2 w-16 rounded-full bg-surface-elevated" />
              <div className="h-4 w-6 rounded-md bg-surface-2" />
            </div>
            {['w-3/5', 'w-4/5', 'w-1/2', 'w-2/3', 'w-2/5'].map((width, index) => (
              <div key={width} className="flex items-center gap-3" style={{ opacity: 1 - index * 0.15 }}>
                <div className="h-4 w-4 shrink-0 rounded bg-surface-elevated" />
                <div className={`h-2 rounded-full bg-surface-elevated ${width}`} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Sidebar>
  );
  return opened.current ? <Suspense fallback={shell}><LoadedSidebar {...props} /></Suspense> : shell;
}
