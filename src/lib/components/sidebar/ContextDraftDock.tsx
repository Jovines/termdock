import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  Send,
  Trash2,
  X,
} from 'lucide-react';

interface ContextDraftDockLabels {
  title: string;
  hint: string;
  placeholder: string;
  collapse: string;
  expand: string;
  disable: string;
  clear: string;
  insert: string;
  insertAndSend: string;
  inserted: string;
  sent: string;
  characterCount: (count: number) => string;
}

interface ContextDraftDockProps {
  value: string;
  collapsed: boolean;
  labels: ContextDraftDockLabels;
  focusRequest?: number;
  onChange: (value: string) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onDisable: () => void;
  onClear: () => void;
  onInsert: () => void;
  onInsertAndSend: () => void;
}

export function ContextDraftDock({
  value,
  collapsed,
  labels,
  focusRequest,
  onChange,
  onCollapsedChange,
  onDisable,
  onClear,
  onInsert,
  onInsertAndSend,
}: ContextDraftDockProps) {
  const [lastAction, setLastAction] = useState<'inserted' | 'sent' | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasDraft = Boolean(value.trim());

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  useEffect(() => {
    if (focusRequest !== undefined && focusRequest > 0) {
      // 触屏设备（手机/平板）不自动聚焦，避免软键盘弹起遮挡
      if (window.matchMedia('(pointer: coarse)').matches) return;
      textareaRef.current?.focus();
    }
  }, [focusRequest]);

  const markAction = (action: 'inserted' | 'sent') => {
    setLastAction(action);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setLastAction(null);
    }, 1400);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    if (!hasDraft) return;
    onInsertAndSend();
    markAction('sent');
  };

  return (
    <section
      className="shrink-0 border-t border-border/15 bg-surface/60 text-foreground"
      data-context-draft-dock
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => onCollapsedChange(!collapsed)}
        className="flex h-9 w-full items-center gap-2 px-3 text-left text-[11px] font-semibold text-muted-foreground transition hover:bg-surface-2 hover:text-foreground active:scale-[0.995]"
        aria-expanded={!collapsed}
        title={collapsed ? labels.expand : labels.collapse}
      >
        {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        <span className="min-w-0 flex-1 truncate">{labels.title}</span>
        {hasDraft && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
        <span className="shrink-0 font-mono text-[9px] font-normal tabular-nums text-muted-foreground/60">
          {labels.characterCount(value.length)}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDisable(); }}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition hover:bg-surface-elevated hover:text-foreground"
          aria-label={labels.disable}
          title={labels.disable}
        >
          <X size={11} />
        </button>
      </button>

      {!collapsed && (
        <div className="animate-fade-in px-3 pb-[calc(0.75rem+var(--safe-bottom-inset,0px))]">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={labels.placeholder}
            className="block h-28 max-h-[38vh] min-h-20 w-full resize-y rounded-xl border border-border/15 bg-surface px-3 py-2.5 font-mono text-[16px] leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
            autoCapitalize="sentences"
            spellCheck
            data-context-draft-input
          />
          <div className="mt-2.5 flex items-center gap-1.5">
            <span className="mr-1 hidden text-[10px] leading-4 text-muted-foreground/60 sm:inline">{labels.hint}</span>
            <button
              type="button"
              onClick={onClear}
              disabled={!hasDraft}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95 disabled:opacity-35"
              aria-label={labels.clear}
              title={labels.clear}
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              onClick={() => {
                onInsert();
                markAction('inserted');
              }}
              disabled={!hasDraft}
              className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-surface-2 px-3 text-[11px] font-semibold text-foreground transition hover:bg-surface-elevated active:scale-[0.98] disabled:opacity-35"
            >
              <CornerDownLeft size={13} />
              <span className="truncate">{lastAction === 'inserted' ? labels.inserted : labels.insert}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                onInsertAndSend();
                markAction('sent');
              }}
              disabled={!hasDraft}
              className="inline-flex h-8 min-w-0 flex-[1.15] items-center justify-center gap-1.5 rounded-full bg-primary px-3 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90 active:scale-[0.98] disabled:opacity-35"
            >
              <Send size={13} />
              <span className="truncate">{lastAction === 'sent' ? labels.sent : labels.insertAndSend}</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
