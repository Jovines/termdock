import { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { CircleAlert, CircleCheck, LoaderCircle, X } from 'lucide-react';
import { useConnectionRecovery } from '../../federation/connectionRecovery';
import { useI18n } from '../../i18n';
import { useStartupVisible } from '../StartupScreen';

export interface Feedback {
  message: string;
  tone?: 'error' | 'success' | 'recovering';
  actionLabel?: string;
  onAction?: () => void;
  /** Milliseconds before dismissal; zero keeps a recovery visible until resolved. */
  duration?: number;
}
interface Item extends Feedback { id: string; dismissed?: boolean }
export const useFeedbackStore = create<{ items: Item[] }>(() => ({ items: [] }));

/** One owner per incident: repeats update in place; recovery/unmount removes it. */
export function useAppFeedback(feedback: Feedback | null): void {
  const id = useId();
  const message = feedback?.message, tone = feedback?.tone ?? 'error';
  const actionLabel = feedback?.actionLabel, onAction = feedback?.onAction;
  const duration = feedback?.duration ?? (tone === 'recovering' ? 0 : tone === 'success' ? 4000 : 8000);
  useEffect(() => {
    if (!message) return;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const remove = () => useFeedbackStore.setState(state => ({ items: state.items.filter(item => item.id !== id) }));
    const publish = () => {
      useFeedbackStore.setState(state => ({ items: [...state.items.filter(item => item.id !== id), { id, message, tone, actionLabel, onAction }] }));
      if (duration) expiry = setTimeout(remove, duration);
    };
    const show = tone === 'recovering' ? setTimeout(publish, 2500) : undefined;
    if (tone !== 'recovering') publish();
    return () => { clearTimeout(show); clearTimeout(expiry); remove(); };
  }, [id, message, tone, actionLabel, onAction, duration]);
}

/** A single, stable location outside pane stacking contexts and input toolbars. */
export function AppFeedbackHost() {
  const { locale, t } = useI18n();
  const connection = useConnectionRecovery();
  const startupVisible = useStartupVisible();
  const connectionMessage = locale === 'zh'
    ? connection === 'offline' ? '网络已断开，恢复后会自动连接' : '正在恢复连接…'
    : connection === 'offline' ? 'Offline. Reconnecting when the network returns.' : 'Reconnecting…';
  useAppFeedback(connection === 'ready' ? null : { tone: 'recovering', message: connectionMessage });
  const items = useFeedbackStore(state => state.items);
  const visible = items.filter(item => !item.dismissed);
  // Transport outages take precedence over their downstream read failures.
  const item = connection !== 'ready' ? visible.find(item => item.tone === 'recovering')
    : visible.find(item => item.tone === 'error') ?? visible.at(-1);
  if (!item) return null;
  const recovering = item.tone === 'recovering';
  // The full-screen restore surface owns recovery feedback until it releases.
  if (recovering && startupVisible) return null;
  const Icon = recovering ? LoaderCircle : item.tone === 'success' ? CircleCheck : CircleAlert;
  return createPortal(<div data-app-feedback className="pointer-events-none fixed inset-x-3 top-[calc(var(--safe-top-inset)+3rem)] z-toast mx-auto w-auto max-w-md">
    <div role={recovering || item.tone === 'success' ? 'status' : 'alert'} aria-live={recovering ? 'polite' : undefined} aria-atomic="true"
      className="pointer-events-auto flex items-center gap-2 rounded-xl border border-border bg-surface-elevated px-3 py-1.5 text-xs leading-5 text-foreground shadow-lg">
      <Icon size={15} aria-hidden="true" className={`shrink-0 ${recovering ? 'animate-spin text-muted-foreground motion-reduce:animate-none' : item.tone === 'success' ? 'text-primary' : 'text-[color:var(--warning)]'}`} />
      <span className="min-w-0 flex-1 break-words">{connection !== 'ready' ? connectionMessage : recovering && visible.filter(notice => notice.tone === 'recovering').length > 1
        ? locale === 'zh' ? '正在恢复服务同步…' : 'Restoring service updates…' : item.message}</span>
      {item.onAction && <button type="button" className="min-h-11 shrink-0 rounded-lg px-2 text-primary hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={item.onAction}>{item.actionLabel ?? t('common.retry')}</button>}
      <button type="button" aria-label={t('common.close')} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => useFeedbackStore.setState(state => ({ items: state.items.map(notice => notice.id === item.id || (recovering && notice.tone === 'recovering') || notice.message === item.message ? { ...notice, dismissed: true } : notice) }))}><X size={14} /></button>
    </div>
  </div>, document.body);
}
