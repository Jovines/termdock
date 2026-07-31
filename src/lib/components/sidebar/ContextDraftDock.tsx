import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  Check,
  ChevronDown,
  CornerDownLeft,
  PenLine,
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
  send: string;
  appended: string;
  resize: string;
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

const SEND_FEEDBACK_MS = 1400;
const APPEND_FLASH_MS = 1200;
const HEIGHT_STORAGE_KEY = 'termdock:right-sidebar:context-draft-height:v1';
const MIN_TEXTAREA_HEIGHT = 56;
// 手动拖动的高度上限
const DRAG_MAX_HEIGHT_RATIO = 0.7;

function readStoredHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= MIN_TEXTAREA_HEIGHT ? parsed : null;
  } catch {
    return null;
  }
}

function isCoarsePointer() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
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
  const [appendFlash, setAppendFlash] = useState(false);
  const [manualHeight, setManualHeight] = useState<number | null>(readStoredHeight);
  const resetTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const prevValueRef = useRef(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const hasDraft = Boolean(value.trim());
  const firstLine = value.trim().split('\n')[0] ?? '';
  const sendShortcut = /Mac|iPhone|iPad/.test(window.navigator?.platform ?? '') ? '⌘↵' : 'Ctrl+↵';

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
  }, []);

  useEffect(() => {
    if (focusRequest !== undefined && focusRequest > 0) {
      // 触屏设备（手机/平板）不自动聚焦，避免软键盘弹起遮挡
      if (isCoarsePointer()) return;
      textareaRef.current?.focus();
    }
  }, [focusRequest]);

  // 静息行状态下引用被追加：行内短暂闪烁「已追加」，不展开编辑器
  useEffect(() => {
    const prev = prevValueRef.current;
    prevValueRef.current = value;
    if (!collapsed || value.length <= prev.length) return;
    setAppendFlash(true);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setAppendFlash(false);
    }, APPEND_FLASH_MS);
  }, [value, collapsed]);

  // 编辑态：默认固定两行高（内容超出内部滚动）；用户拖过手柄后用手动高度
  useEffect(() => {
    if (collapsed) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = manualHeight !== null ? `${manualHeight}px` : '';
  }, [value, collapsed, manualHeight]);

  // 追加引用（未聚焦）时把 textarea 滚到底部，露出新内容；
  // 聚焦时不干预，光标可见性由浏览器负责
  useEffect(() => {
    if (collapsed) return;
    const el = textareaRef.current;
    if (!el || document.activeElement === el) return;
    el.scrollTop = el.scrollHeight;
  }, [value, collapsed]);

  // 桌面端展开时聚焦并把光标放到末尾；触屏只在用户主动点击时聚焦（见 expand）
  useEffect(() => {
    if (collapsed || isCoarsePointer()) return;
    const el = textareaRef.current;
    if (!el || document.activeElement === el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [collapsed]);

  // 触屏：软键盘弹起后，fixed 侧栏相对布局视口定位，与可视视口错位，
  // 导致草稿坞被键盘盖住或与键盘之间留缝。这里监听可视视口，把草稿坞平移到
  // 「底边 = 可视视口底」，自校正贴齐键盘上沿。键盘未弹起（高度差 < 25%）
  // 时不动，避免把坞推进底部安全区。两种状态（静息/编辑）都同步，且用
  // useLayoutEffect 在绘制前校正——否则收起瞬间会先按自然位置画一帧，
  // 表现为文本弹出再收回。
  const dockRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!isCoarsePointer()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const dock = dockRef.current;
      if (!dock) return;
      if (vv.height >= window.innerHeight * 0.75) {
        dock.style.transform = '';
        return;
      }
      const rect = dock.getBoundingClientRect();
      const delta = Math.round(vv.height - rect.bottom);
      dock.style.transform = delta !== 0 ? `translateY(${delta}px)` : '';
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      if (dockRef.current) dockRef.current.style.transform = '';
    };
  }, [collapsed]);

  const markAction = (action: 'inserted' | 'sent') => {
    setLastAction(action);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setLastAction(null);
    }, SEND_FEEDBACK_MS);
  };

  const expand = (focus: boolean) => {
    onCollapsedChange(false);
    // 触屏点击静息行属于明确手势，此时聚焦弹键盘是用户预期
    if (focus && isCoarsePointer()) {
      window.requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
        // iOS 会在布局未稳定时绘制光标（表现为光标在输入框外闪），
        // 下一帧重设选区强制光标重定位
        window.requestAnimationFrame(() => {
          el.setSelectionRange(end, end);
        });
      });
    }
  };

  const handleInsert = () => {
    onInsert();
    markAction('inserted');
    onCollapsedChange(true);
  };

  const handleSend = () => {
    if (!hasDraft) return;
    onInsertAndSend();
    markAction('sent');
    onCollapsedChange(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCollapsedChange(true);
      return;
    }
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    handleSend();
  };

  // 不做失焦自动收起：草稿坞主打持续编辑（攒引用 + 补写），收起只靠
  // 显式操作——收起箭头 / Esc / 插入发送后。
  const keepFocus = (event: PointerEvent) => {
    event.preventDefault();
  };

  // 顶部手柄拖动调高：向上拖增大。双击恢复默认高度。
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = textareaRef.current;
    if (!el) return;
    dragStateRef.current = { startY: event.clientY, startHeight: el.getBoundingClientRect().height };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const next = Math.round(Math.min(
      Math.max(drag.startHeight + (drag.startY - event.clientY), MIN_TEXTAREA_HEIGHT),
      viewportHeight * DRAG_MAX_HEIGHT_RATIO,
    ));
    setManualHeight(next);
  };

  const endResize = () => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    setManualHeight((current) => {
      try {
        if (current !== null) window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(current));
      } catch { /* 忽略持久化失败 */ }
      return current;
    });
  };

  const resetResize = () => {
    setManualHeight(null);
    try {
      window.localStorage.removeItem(HEIGHT_STORAGE_KEY);
    } catch { /* 忽略持久化失败 */ }
  };

  const charCount = value.length > 0 && (
    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/50">
      {labels.characterCount(value.length)}
    </span>
  );

  if (collapsed) {
    return (
      <section
        ref={dockRef}
        className="shrink-0 border-t border-border/15 text-foreground"
        data-context-draft-dock
      >
        <div className="flex h-9 items-center gap-1.5 px-2.5">
          <button
            type="button"
            onClick={() => expand(true)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left transition hover:bg-surface-2"
            aria-expanded={false}
            aria-label={labels.expand}
            title={labels.expand}
          >
            <PenLine size={11} className="shrink-0 text-muted-foreground/60" aria-hidden="true" />
            <span
              className={`truncate text-[11px] ${
                appendFlash
                  ? 'text-primary'
                  : hasDraft
                    ? 'text-foreground/80'
                    : 'text-muted-foreground/50'
              }`}
            >
              {appendFlash ? labels.appended : hasDraft ? firstLine : labels.title}
            </span>
          </button>
          {charCount}
          <button
            type="button"
            onClick={handleSend}
            disabled={!hasDraft}
            className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition active:scale-95 disabled:opacity-35 ${
              hasDraft
                ? 'bg-primary/15 text-primary hover:bg-primary/25'
                : 'bg-surface-2 text-muted-foreground'
            }`}
            aria-label={labels.send}
            title={labels.send}
          >
            {lastAction === 'sent' ? <Check size={13} /> : <Send size={13} />}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={dockRef}
      className="relative shrink-0 border-t border-border/15 text-foreground"
      data-context-draft-dock
    >
      {/* 拖动手柄：骑在顶部分割线上不占布局，拖动调整输入框高度，双击恢复默认 */}
      <div
        className="group absolute left-1/2 top-0 z-10 flex h-3 w-16 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize touch-none items-center justify-center"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={resetResize}
        title={labels.resize}
        aria-hidden="true"
      >
        <span className="h-1 w-8 rounded-full bg-border/50 transition group-hover:bg-border" />
      </div>

      {/* Header */}
      <div className="flex h-8 items-center gap-1.5 px-2.5">
        <button
          type="button"
          onPointerDown={keepFocus}
          onClick={() => onCollapsedChange(true)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left transition hover:bg-surface-2"
          aria-expanded={true}
          aria-label={labels.collapse}
          title={labels.collapse}
        >
          <ChevronDown size={11} className="shrink-0 text-muted-foreground/60" aria-hidden="true" />
          <span className="truncate text-[11px] font-semibold text-muted-foreground">{labels.title}</span>
          {charCount}
        </button>
        <button
          type="button"
          onPointerDown={keepFocus}
          onClick={onDisable}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-surface-2 hover:text-foreground active:scale-95"
          aria-label={labels.disable}
          title={labels.disable}
        >
          <X size={12} />
        </button>
      </div>

      <div className="px-2.5 pb-2.5">
        {/* 输入井：比面板略深的同族色，聚焦时描边点亮 */}
        <div className="rounded-lg border border-border/15 bg-surface-2 transition focus-within:border-primary/45">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={labels.placeholder}
            rows={2}
            className="block min-h-14 w-full resize-none bg-transparent px-2.5 py-2 font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/35 focus:outline-none"
            autoCapitalize="sentences"
            spellCheck
            data-context-draft-input
          />
        </div>

        {/* Action row */}
        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            onPointerDown={keepFocus}
            onClick={onClear}
            disabled={!hasDraft}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-2 hover:text-foreground active:scale-95 disabled:opacity-35"
            aria-label={labels.clear}
            title={labels.clear}
          >
            <Trash2 size={13} />
          </button>
          <span className="flex-1" />
          <kbd className="hidden shrink-0 select-none rounded border border-border/20 px-1 py-0.5 font-mono text-[9px] text-muted-foreground/40 sm:inline">
            {sendShortcut}
          </kbd>
          <button
            type="button"
            onPointerDown={keepFocus}
            onClick={handleInsert}
            disabled={!hasDraft}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-surface-2 px-3 text-[12px] font-semibold text-foreground transition hover:bg-surface-elevated active:scale-[0.98] disabled:opacity-35"
          >
            <CornerDownLeft size={13} />
            <span>{lastAction === 'inserted' ? labels.inserted : labels.insert}</span>
          </button>
          <button
            type="button"
            onPointerDown={keepFocus}
            onClick={handleSend}
            disabled={!hasDraft}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition hover:bg-primary/90 active:scale-[0.98] disabled:opacity-35"
          >
            {lastAction === 'sent' ? <Check size={13} /> : <Send size={13} />}
            <span>{lastAction === 'sent' ? labels.sent : labels.insertAndSend}</span>
          </button>
        </div>
      </div>
    </section>
  );
}
