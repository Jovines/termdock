import { ChangesLoadingSkeleton } from './ChangesLoadingSkeleton';
import { lazy, Suspense, useEffect, useRef, type ComponentProps } from 'react';
import { X, Search, PencilLine, MoreHorizontal, GitBranch, GitCompare, Folder } from 'lucide-react';
import { useSidebarStore } from '../../stores/useSidebarStore';
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
  const rootPath = useSidebarStore((s) => s.rootPath);
  const rightTab = useSidebarStore((s) => s.rightTab);
  const setRightTab = useSidebarStore((s) => s.setRightTab);
  const rootName = rootPath?.replace(/\/+$/, '').split('/').pop() || t('rightSidebar.workspace');
  if (props.isOpen || props.pinned) opened.current = true;
  const shell = (
    <Sidebar side="right" isOpen={props.isOpen} drawerWidthPx={props.drawerWidthPx}
      onClose={props.onClose} onOpen={props.onOpen} pinned={props.pinned}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 border-b border-border/15 bg-surface px-2 pt-2">
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1 px-1">
              <div className="flex min-h-[1.25rem] items-baseline gap-1.5">
                <span className="truncate text-[13px] font-semibold text-foreground">{rootName}</span>
              </div>
            </div>
            <div aria-hidden="true" className="flex items-center gap-1.5">
              {[Search, PencilLine, MoreHorizontal].map((Icon, index) => (
                <span key={index} className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
                  <Icon size={14} />
                </span>
              ))}
            </div>
            <button type="button" onClick={props.onClose} aria-label={t('common.close')}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95">
              <X size={14} />
            </button>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-0.5 rounded-md bg-surface-2 p-0.5">
            {([
              ['git', GitBranch, 'rightSidebar.tabGit'],
              ['diff', GitCompare, 'rightSidebar.tabChanges'],
              ['files', Folder, 'rightSidebar.tabFiles'],
            ] as const).map(([tab, Icon, label]) => (
              <button key={tab} type="button" onClick={() => setRightTab(tab)}
                className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium ${rightTab === tab ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground'}`}>
                <Icon size={12} />{t(label)}
              </button>
            ))}
          </div>
          <div className="h-2" />
        </div>
        <div className="min-h-0 flex-1 bg-surface">
          <ChangesLoadingSkeleton />
        </div>
      </div>
    </Sidebar>
  );
  return opened.current ? <Suspense fallback={shell}><LoadedSidebar {...props} /></Suspense> : shell;
}
