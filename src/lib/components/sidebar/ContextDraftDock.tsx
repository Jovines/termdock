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
import { getSettings, updateSettings } from '../../terminal/api';

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
  autoCollapseAfterSend: string;
  characterCount: (count: number) => string;
}

interface ContextDraftDockProps {
  value: string;
  collapsed: boolean;
  labels: ContextDraftDockLabels;
  focusRequest?: number;
  autoCollapseAfterSend: boolean;
  /** 插入/发送失败提示（如终端断联），非空时展示并保持编辑态 */
  insertError?: string | null;
  onChange: (value: string) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onAutoCollapseAfterSendChange: (enabled: boolean) => void;
  onDisable: () => void;
  onClear: () => void;
  onInsert: () => void;
  onInsertAndSend: () => void;
}

const SEND_FEEDBACK_MS = 1400;
const APPEND_FLASH_MS = 1200;
const MIN_TEXTAREA_HEIGHT = 44;
// 手动拖动的高度上限
const DRAG_MAX_HEIGHT_RATIO = 0.7;

type DraftDevice = 'mobile' | 'desktop';

function draftDevice(): DraftDevice {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    ? 'mobile'
    : 'desktop';
}

function heightStorageKey(device: DraftDevice): string {
  return `termdock:right-sidebar:context-draft-height:${device}:v1`;
}

// localStorage 作为即时缓存（首帧不闪），服务端 settings 才是同步真源
function readStoredHeight(device: DraftDevice): number | null {
  try {
    const raw = window.localStorage.getItem(heightStorageKey(device));
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= MIN_TEXTAREA_HEIGHT ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredHeight(device: DraftDevice, height: number | null): void {
  try {
    if (height === null) window.localStorage.removeItem(heightStorageKey(device));
    else window.localStorage.setItem(heightStorageKey(device), String(height));
  } catch { /* 忽略持久化失败 */ }
}

function isCoarsePointer() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

export function ContextDraftDock({
  value,
  collapsed,
  labels,
  focusRequest,
  insertError,
  autoCollapseAfterSend,
  onChange,
  onCollapsedChange,
  onAutoCollapseAfterSendChange,
  onDisable,
  onClear,
  onInsert,
  onInsertAndSend,
}: ContextDraftDockProps) {
  const [lastAction, setLastAction] = useState<'inserted' | 'sent' | null>(null);
  const [appendFlash, setAppendFlash] = useState(false);
  const [manualHeight, setManualHeight] = useState<number | null>(() => readStoredHeight(draftDevice()));
  const manualHeightRef = useRef<number | null>(manualHeight);
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

  // 服务端存有手机/桌面各自的拖动手动高度：挂载后拉一次覆盖本地缓存
  useEffect(() => {
    let cancelled = false;
    const device = draftDevice();
    getSettings()
      .then((settings) => {
        if (cancelled) return;
        const serverHeight = settings.contextDraftHeight?.[device] ?? null;
        writeStoredHeight(device, serverHeight);
        manualHeightRef.current = serverHeight;
        setManualHeight(serverHeight);
      })
      .catch(() => { /* 拉取失败沿用本地缓存 */ });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (focusRequest !== undefined && focusRequest > 0) {
      const el = textareaRef.current;
      if (!el) return;
      // 外部引用总是追加到草稿末尾，caret 也必须跟到新末尾。触屏设备
      // 只更新 selection，不主动 focus，避免软键盘弹起遮挡。
      if (!isCoarsePointer()) el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = el.scrollHeight;
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

  // 插入/发送不再立即收起：父组件等终端 ack，成功才清空收起，
  // 失败（断联）保持编辑态并通过 insertError 提示
  const handleInsert = () => {
    onInsert();
    markAction('inserted');
  };

  const handleSend = () => {
    if (!hasDraft) return;
    onInsertAndSend();
    markAction('sent');
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
    manualHeightRef.current = next;
    setManualHeight(next);
  };

  const persistHeight = (height: number | null) => {
    const device = draftDevice();
    writeStoredHeight(device, height);
    updateSettings({ contextDraftHeight: { [device]: height } })
      .catch(() => { /* 同步失败下次启动再对齐 */ });
  };

  const endResize = () => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    if (manualHeightRef.current !== null) persistHeight(manualHeightRef.current);
  };

  const resetResize = () => {
    manualHeightRef.current = null;
    setManualHeight(null);
    persistHeight(null);
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
        <div className="flex h-8 items-center gap-1 px-2">
          <button
            type="button"
            onClick={() => expand(true)}
            className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-surface/70"
            aria-expanded={false}
            aria-label={labels.expand}
            title={labels.expand}
          >
            <PenLine size={11} className="shrink-0 text-muted-foreground/55 transition-colors group-hover:text-muted-foreground" aria-hidden="true" />
            <span
              className={`truncate text-[11px] ${
                insertError
                  ? 'text-destructive'
                  : appendFlash
                    ? 'text-primary'
                    : hasDraft
                      ? 'text-foreground/80'
                      : 'text-muted-foreground/50'
              }`}
            >
              {insertError ?? (appendFlash ? labels.appended : hasDraft ? firstLine : labels.title)}
            </span>
          </button>
          {charCount}
          <button
            type="button"
            onClick={handleSend}
            disabled={!hasDraft}
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition active:scale-95 disabled:opacity-30 ${
              hasDraft
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'text-muted-foreground'
            }`}
            aria-label={labels.send}
            title={labels.send}
          >
            {lastAction === 'sent' ? <Check size={12} /> : <Send size={12} />}
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

      {/* Header：只保留定位与轻量设置，避免在窄侧栏里形成一排标签。 */}
      <div className="flex h-7 items-center gap-0.5 px-2">
        <button
          type="button"
          onPointerDown={keepFocus}
          onClick={() => onCollapsedChange(true)}
          className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-surface/70"
          aria-expanded={true}
          aria-label={labels.collapse}
          title={labels.collapse}
        >
          <ChevronDown size={11} className="shrink-0 text-muted-foreground/55 transition-colors group-hover:text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-[10px] font-medium text-foreground/75">{labels.title}</span>
          {charCount}
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={autoCollapseAfterSend}
          onPointerDown={keepFocus}
          onClick={() => onAutoCollapseAfterSendChange(!autoCollapseAfterSend)}
          className="inline-flex h-6 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-surface/70 hover:text-foreground"
          aria-label={labels.autoCollapseAfterSend}
          title={labels.autoCollapseAfterSend}
        >
          <span
            aria-hidden="true"
            className={`relative h-3 w-5 rounded-full transition-colors ${autoCollapseAfterSend ? 'bg-primary' : 'bg-surface-elevated'}`}
          >
            <span
              className={`absolute top-0.5 h-2 w-2 rounded-full bg-primary-foreground transition-transform ${autoCollapseAfterSend ? 'translate-x-2.5' : 'translate-x-0.5'}`}
            />
          </span>
        </button>
        <button
          type="button"
          onPointerDown={keepFocus}
          onClick={onDisable}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition hover:bg-surface/70 hover:text-foreground active:scale-95"
          aria-label={labels.disable}
          title={labels.disable}
        >
          <X size={11} />
        </button>
      </div>

      <div className="px-2 pb-2">
        {/* 输入与操作共用一个 composer surface，减少卡片和工具条的拼接感。 */}
        <div className="overflow-hidden rounded-lg bg-surface/80 ring-1 ring-border/10 transition focus-within:ring-primary/35">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={labels.title}
            rows={1}
            className="block min-h-11 w-full resize-none bg-transparent px-2.5 py-2 font-mono text-[12px] leading-relaxed text-foreground placeholder:text-muted-foreground/30 focus:outline-none"
            autoCapitalize="sentences"
            spellCheck
            data-context-draft-input
          />
          {/* Action row：内嵌在输入面内，只让最终发送成为强操作。 */}
          <div className="flex items-center gap-0.5 border-t border-border/10 px-1 py-1">
            <button
              type="button"
              onPointerDown={keepFocus}
              onClick={onClear}
              disabled={!hasDraft}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 transition hover:bg-surface-2 hover:text-foreground active:scale-95 disabled:opacity-30"
              aria-label={labels.clear}
              title={labels.clear}
            >
              <Trash2 size={11} />
            </button>
            {insertError ? (
              <span className="min-w-0 flex-1 truncate px-1 text-[10px] text-destructive" role="alert">
                {insertError}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            <button
              type="button"
              onPointerDown={keepFocus}
              onClick={handleInsert}
              disabled={!hasDraft}
              className="inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-[10px] font-medium text-foreground/75 transition hover:bg-surface-2 hover:text-foreground active:scale-[0.98] disabled:opacity-30"
            >
              <CornerDownLeft size={11} />
              <span>{lastAction === 'inserted' ? labels.inserted : labels.insert}</span>
            </button>
            <button
              type="button"
              onPointerDown={keepFocus}
              onClick={handleSend}
              disabled={!hasDraft}
              className="inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md bg-primary px-2 text-[10px] font-semibold text-primary-foreground transition hover:bg-primary/90 active:scale-[0.98] disabled:opacity-30"
              title={`${labels.insertAndSend} · ${sendShortcut}`}
            >
              {lastAction === 'sent' ? <Check size={11} /> : <Send size={11} />}
              <span>{lastAction === 'sent' ? labels.sent : labels.send}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
