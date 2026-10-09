import { useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ArchitectureNode } from '../../architecture/model';
import { useI18n } from '../../i18n';

/** The first tap identifies a module without opening a long reading task. */
export function ArchitectureNodePreview({ node, onExpand, onClose }: {
  node: ArchitectureNode;
  onExpand: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (document.activeElement !== root.current) previous.current = document.activeElement as HTMLElement | null;
    root.current?.focus({ preventScroll: true });
  }, [node.id]);
  useLayoutEffect(() => () => { if (previous.current?.isConnected) previous.current.focus({ preventScroll: true }); }, []);
  const button = 'inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg px-2 text-xs hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring';
  return <section ref={root} tabIndex={-1} aria-label={node.title} data-architecture-inspector data-sidebar-gesture-ignore className="shrink-0 border-t border-border/30 bg-surface px-3 pb-2">
    <div className="flex items-center gap-2">
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={node.title}>{node.title}</h2>
      <button type="button" className={`${button} text-primary`} onClick={onExpand}>{t('architecture.expandDetail')}</button>
      <button type="button" className={button} aria-label={t('architecture.closeDetail')} onClick={onClose}><X size={17} /></button>
    </div>
    <p className="line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{node.summary}</p>
  </section>;
}
