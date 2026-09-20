import { useId, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useI18n } from '../../i18n';

/** Keep secondary actions in a disclosure that stays inside the list scroller. */
export function ChangesToolbar({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="mt-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {children}
        <button
          ref={trigger}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className={`ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition active:scale-95 ${open ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
        >
          <MoreHorizontal size={14} />
          {t('sidebar.moreActions')}
        </button>
      </div>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={t('sidebar.moreActions')}
          className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border/15 bg-surface-2 p-2 [&_button]:min-h-9"
          onKeyDown={(event) => {
            // Portaled scope dialogs own their keyboard events.
            if (event.key !== 'Escape' || !event.currentTarget.contains(event.target as Node)) return;
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
