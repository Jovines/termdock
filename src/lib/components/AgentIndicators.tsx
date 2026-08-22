/**
 * Agent / 会话状态相关的展示原语，统一收敛在这里。
 *
 * 设计约定（hook 驱动的四态状态机）：
 *   - working → 绿色 spinner（回合进行中）
 *   - waiting → 黄色问号跳动（等你授权/回答——最需要关注的时刻）
 *   - done    → 绿色对勾（回合完成，结果待读）
 *   - idle    → agent 品牌头像（无状态点），无身份时回落 shell/tmux 图标
 *   - review → 黄色呼吸动效（needsReview）
 *   - copy-mode → 紫色静态方点（与待查看的黄色圆点明确区分）
 */

import React from 'react';
import { createPortal } from 'react-dom';
import {
  Terminal as RiTerminalLine,
  LayoutGrid as RiLayoutGridLine,
  LoaderCircle as RiLoaderCircle,
  CircleHelp as RiCircleHelp,
  BellDot as RiBellDot,
  Bot as RiBot,
  CircleDot as RiCircleDot,
} from 'lucide-react';
import type { AgentStatus, AgentIdentity, AgentIndicator, AgentStatusDetail } from '../terminal/types';
import { useI18n } from '../i18n';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useSidebarStore } from '../stores/useSidebarStore';
import { useViewportKeyboardState } from '../hooks/useViewportKeyboardState';
import { getNextAttentionSessionId } from '../utils/agentAttention';
import {
  MOBILE_ATTENTION_SIZE_PX,
  clampMobileAttentionDrag,
  resolveMobileAttentionPosition,
  snapMobileAttentionPosition,
  type MobileAttentionPosition,
  type MobileAttentionPreference,
  type MobileAttentionViewport,
} from '../utils/mobileAttentionPosition';

/** 黄色（待查看 / 等待用户） */
export const AGENT_COLOR_ATTENTION = 'var(--warning)';
/** 绿色（working/done） */
export const AGENT_COLOR_RUNNING = 'var(--success)';
/** 紫色（tmux copy mode） */
export const AGENT_COLOR_COPY_MODE = 'var(--tmux)';
const MOBILE_ATTENTION_POSITION_KEY = 'termdock:mobile-attention-position:v1';
const MOBILE_ATTENTION_DEFAULT_PREFERENCE: MobileAttentionPreference = {
  side: 'right',
  yRatio: 0.68,
};

function readMobileAttentionPreference(): MobileAttentionPreference {
  if (typeof window === 'undefined') return MOBILE_ATTENTION_DEFAULT_PREFERENCE;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(MOBILE_ATTENTION_POSITION_KEY) ?? 'null',
    ) as Partial<MobileAttentionPreference> | null;
    if (
      parsed
      && (parsed.side === 'left' || parsed.side === 'right')
      && typeof parsed.yRatio === 'number'
      && Number.isFinite(parsed.yRatio)
    ) {
      return {
        side: parsed.side,
        yRatio: Math.min(1, Math.max(0, parsed.yRatio)),
      };
    }
  } catch {
    // A malformed or unavailable localStorage falls back to the ergonomic default.
  }
  return MOBILE_ATTENTION_DEFAULT_PREFERENCE;
}

function writeMobileAttentionPreference(preference: MobileAttentionPreference): void {
  try {
    window.localStorage.setItem(
      MOBILE_ATTENTION_POSITION_KEY,
      JSON.stringify(preference),
    );
  } catch {
    // Position persistence is best-effort; dragging still works for this page.
  }
}

function readSafeInset(name: string): number {
  if (typeof document === 'undefined') return 0;
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function getMobileAttentionViewport(): MobileAttentionViewport {
  if (typeof window === 'undefined') return { width: 390, height: 664 };
  const visualViewport = window.visualViewport;
  return {
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
    safeTop: readSafeInset('--safe-top-inset'),
    safeRight: readSafeInset('--safe-right-inset'),
    safeBottom: readSafeInset('--safe-bottom-inset'),
    safeLeft: readSafeInset('--safe-left-inset'),
  };
}

function jumpToNextAgentAttention(): void {
  const store = useTerminalStore.getState();
  const orderedSessions = Array.from(store.sessions.values());
  const nextId = getNextAttentionSessionId(orderedSessions, store.activeSessionId);
  if (!nextId) return;

  const active = store.activeSessionId
    ? store.sessions.get(store.activeSessionId)
    : undefined;
  if (active?.agentNeedsReview) {
    store.clearAgentNeedsReview(active.sessionId);
  }
  window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: nextId }));
}

/** 给 tab 图标 / dot 共享的轻量 session 状态 */
export interface AgentVisualState {
  inCopyMode?: boolean;
  agentStatus: AgentStatus | null;
  agent?: AgentIdentity | null;
  agentMessage?: string | null;
  agentIndicator?: AgentIndicator | null;
  agentStatusDetail?: AgentStatusDetail | null;
  agentNeedsReview?: boolean;
}

function statusToneColor(tone: AgentStatusDetail['tone']): string {
  switch (tone) {
    case 'success': return 'var(--success)';
    case 'warning': return 'var(--warning)';
    case 'danger': return 'var(--destructive)';
    case 'info':
    case 'accent': return 'var(--accent)';
    default: return 'var(--muted-foreground)';
  }
}

function DynamicStatusIcon({ indicator, tone, size }: {
  indicator: AgentIndicator;
  tone: AgentStatusDetail['tone'];
  size: number;
}): React.ReactElement {
  const color = statusToneColor(tone);
  switch (indicator) {
    case 'spinner': return <RiLoaderCircle size={size} className="shrink-0 animate-spin" style={{ color }} />;
    case 'question': return <RiCircleHelp size={size} className="shrink-0 animate-bounce-y" style={{ color }} />;
    case 'badge': return <RiBellDot size={size + 1} className="shrink-0 animate-pulse" style={{ color }} />;
    case 'terminal': return <RiTerminalLine size={size} className="shrink-0" style={{ color }} />;
    case 'pulse': return <RiCircleDot size={size} className="shrink-0 animate-pulse" style={{ color }} />;
    case 'ring': return <span className="block shrink-0 rounded-full border-2" style={{ width: size, height: size, borderColor: color }} />;
    case 'dot': return <span className="block shrink-0 rounded-full" style={{ width: Math.max(5, size - 4), height: Math.max(5, size - 4), backgroundColor: color }} />;
  }
}

/**
 * agent 品牌头像：品牌色圆角方块 + 白色剪影。
 * SVG 资产来自 tty7（Apache-2.0），用 CSS mask 着色，几何为准。
 *
 * 支持两种渲染模式：
 *   - mask（默认）：CSS mask + accentColor 背景，品牌色背景上白色剪影
 *   - native：直接渲染 SVG，保留其原始 fill 颜色（用于多色/渐变 logo）
 */
export function AgentBrandAvatar({
  agent,
  size = 12,
}: {
  agent: AgentIdentity;
  size?: number;
}): React.ReactElement {
  const inner = size - 4;
  if (!agent.icon) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-[3px]"
        style={{ width: size, height: size, backgroundColor: agent.accentColor }}
        title={agent.displayName}
      >
        <RiBot size={inner} className="text-white" />
      </span>
    );
  }
  let iconUrl: string;
  if (agent.isPlugin) {
    iconUrl = `/api/terminal/agent-plugin-icon/${agent.slug}`;
    if (agent.iconVersion) {
      iconUrl += `?v=${Math.floor(agent.iconVersion)}`;
    }
  } else {
    iconUrl = `/icons/agents/${agent.icon}.svg`;
  }
  if (agent.iconMode === 'native') {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-[3px]"
        style={{ width: size, height: size }}
        title={agent.displayName}
      >
        <img
          src={iconUrl}
          alt={agent.displayName}
          style={{ width: inner, height: inner }}
        />
      </span>
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[3px]"
      style={{ width: size, height: size, backgroundColor: agent.accentColor }}
      title={agent.displayName}
    >
      <span
        className="block bg-white"
        style={{
          width: inner,
          height: inner,
          WebkitMask: `url(${iconUrl}) center / contain no-repeat`,
          mask: `url(${iconUrl}) center / contain no-repeat`,
        }}
      />
    </span>
  );
}

/**
 * 顶部 tab 上的图标。working/waiting/done 渲染状态图标；
 * idle（或无状态但有身份）渲染品牌头像；都没有回落 shell/tmux 默认图标。
 */
export function AgentTabIcon({
  sessionMode,
  state,
  size = 11,
}: {
  sessionMode: 'shell' | 'tmux';
  state?: AgentVisualState;
  size?: number;
}): React.ReactElement {
  const baseIcon = state?.agent
    ? <AgentBrandAvatar agent={state.agent} size={size + 1} />
    : sessionMode === 'tmux'
      ? <RiLayoutGridLine size={size} className="shrink-0" />
      : <RiTerminalLine size={size} className="shrink-0" />;

  // A completed turn's unread bell is a product-level attention signal and
  // intentionally wins over plugin presentation. Other custom states render
  // entirely from the manifest-provided metadata.
  if (state?.agentStatusDetail && state.agentIndicator && !(state.agentStatus === 'done' && state.agentNeedsReview)) {
    return (
      <span title={state.agentMessage ?? state.agentStatusDetail.label} aria-label={state.agentStatusDetail.label}>
        <DynamicStatusIcon indicator={state.agentIndicator} tone={state.agentStatusDetail.tone} size={size} />
      </span>
    );
  }

  if (state?.agentStatus === 'working') {
    return (
      <span title={state.agentMessage ?? state.agent?.displayName}>
        <RiLoaderCircle size={size} className="shrink-0 animate-spin" style={{ color: AGENT_COLOR_RUNNING }} />
      </span>
    );
  }
  if (state?.agentStatus === 'waiting') {
    return (
      <span title={state.agentMessage ?? undefined}>
        <RiCircleHelp size={size} className="shrink-0 animate-bounce-y" style={{ color: AGENT_COLOR_ATTENTION }} />
      </span>
    );
  }
  // done + needsReview 与其他未读统一成黄色铃铛。完成态的绿色勾容易被
  // 理解成“已经处理”，而这里真正要表达的是“还有一条结果没看”。
  if (state?.agentStatus === 'done' && state.agentNeedsReview) {
    return (
      <span title={state.agentMessage ?? undefined}>
        <RiBellDot size={size + 1} className="shrink-0 animate-pulse" style={{ color: AGENT_COLOR_ATTENTION }} />
      </span>
    );
  }

  // 没有活跃状态但有未读，继续使用同一个铃铛语义，便于横扫多个 tab。
  if (state?.agentNeedsReview) {
    return (
      <span title={state.agentMessage ?? undefined}>
        <RiBellDot size={size + 1} className="shrink-0 animate-pulse" style={{ color: AGENT_COLOR_ATTENTION }} />
      </span>
    );
  }

  if (state?.inCopyMode) {
    return sessionMode === 'tmux'
      ? <RiLayoutGridLine size={size} className="shrink-0 animate-pulse" style={{ color: AGENT_COLOR_COPY_MODE }} />
      : <RiTerminalLine size={size} className="shrink-0 animate-pulse" style={{ color: AGENT_COLOR_COPY_MODE }} />;
  }

  return baseIcon;
}

/**
 * 左栏 session 项右上角的小圆点。
 * working=绿，waiting/review=黄色圆点，done=绿（静态），copy-mode=紫色方点。
 * 不显示则返回 null。
 */
export function AgentSessionDot({
  status,
  detail,
  needsReview,
  inCopyMode,
}: {
  status: AgentStatus | null;
  detail?: AgentStatusDetail | null;
  needsReview?: boolean;
  inCopyMode?: boolean;
}): React.ReactElement | null {
  const { t } = useI18n();
  if (detail && !needsReview) {
    return (
      <span
        className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface animate-pulse"
        style={{ backgroundColor: statusToneColor(detail.tone) }}
        title={detail.label}
      />
    );
  }
  if (status === 'working') {
    return (
      <span
        className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--success)] ring-2 ring-surface shadow-[0_0_6px_rgb(var(--success-rgb)_/_0.50)] animate-pulse"
        title={t('agent.aiRunning')}
      />
    );
  }
  if (status === 'waiting' || needsReview) {
    return (
      <span
        className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--warning)] ring-2 ring-surface shadow-[0_0_0_1px_rgb(var(--warning-rgb)_/_0.24)] animate-pulse"
        title={needsReview ? t('agent.finishedReview') : t('agent.aiWaiting')}
      />
    );
  }
  if (status === 'done' && needsReview) {
    return (
      <span
        className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--warning)] ring-2 ring-surface shadow-[0_0_0_1px_rgb(var(--warning-rgb)_/_0.24)] animate-pulse"
        title={t('agent.finishedReview')}
      />
    );
  }
  if (inCopyMode) {
    return (
      <span
        className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-[2px] bg-[var(--tmux)] ring-2 ring-surface"
        title={t('agent.copyMode')}
      />
    );
  }
  return null;
}

/**
 * 顶部 / 左栏的 "running N · review N" 计数胶囊。
 * 两种 tone 共用同一形状，仅颜色不同；review/waiting 默认呼吸动效。
 */
export function AgentCountBadge({
  count,
  tone,
  title,
}: {
  count: number;
  tone: 'running' | 'review';
  title?: string;
}): React.ReactElement | null {
  const { t } = useI18n();
  if (count <= 0) return null;
  const className = tone === 'running'
    ? 'inline-flex items-center gap-1 rounded-full bg-[rgb(var(--success-rgb)_/_0.12)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--success)]'
    : 'inline-flex min-h-6 items-center gap-1 rounded-full bg-[rgb(var(--warning-rgb)_/_0.14)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--warning)] ring-1 ring-[rgb(var(--warning-rgb)_/_0.24)] transition hover:bg-[rgb(var(--warning-rgb)_/_0.22)] active:scale-[0.97]';
  const dotClassName = tone === 'running'
    ? 'h-1.5 w-1.5 rounded-full bg-[var(--success)] animate-pulse'
    : 'h-1.5 w-1.5 rounded-full bg-[var(--warning)] animate-pulse';

  if (tone === 'review') {
    const accessibleTitle = title ?? t('agent.jumpToNext');
    return (
      <button
        type="button"
        className={className}
        title={`${accessibleTitle} · ${t('agent.jumpToNext')}`}
        aria-label={`${accessibleTitle}: ${count}. ${t('agent.jumpToNext')}`}
        onClick={jumpToNextAgentAttention}
      >
        <RiBellDot size={11} className="shrink-0" />
        <span>{t('agent.needsReview')}</span>
        <span className="tabular-nums">{count}</span>
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      <span className={dotClassName} />
      {count}
    </span>
  );
}

/**
 * 移动端顶部栏的零占位汇总：挂在左侧 sessions 按钮角上，避免挤占 tab 横向空间。
 * 绿色=运行中，黄色=等待/待查看；双状态时上下堆叠，单状态时只显示一个角标。
 */
export function AgentCompactStatusOverlay({
  runningCount,
  reviewCount,
  className = '',
}: {
  runningCount: number;
  reviewCount: number;
  className?: string;
}): React.ReactElement | null {
  const { t } = useI18n();
  const sidebarLeftOpen = useSidebarStore((state) => state.leftOpen);
  const sidebarRightOpen = useSidebarStore((state) => state.rightOpen);
  const { isOpen: keyboardOpen } = useViewportKeyboardState({ enabled: true });
  const preferenceRef = React.useRef<MobileAttentionPreference>(
    readMobileAttentionPreference(),
  );
  const [mobilePosition, setMobilePosition] = React.useState<MobileAttentionPosition>(
    () => resolveMobileAttentionPosition(
      getMobileAttentionViewport(),
      preferenceRef.current,
    ),
  );
  const [draggingMobileAttention, setDraggingMobileAttention] = React.useState(false);
  const dragRef = React.useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressAttentionClickRef = React.useRef(false);

  React.useEffect(() => {
    const syncPosition = () => {
      setMobilePosition(resolveMobileAttentionPosition(
        getMobileAttentionViewport(),
        preferenceRef.current,
      ));
    };
    window.addEventListener('resize', syncPosition);
    window.addEventListener('orientationchange', syncPosition);
    window.visualViewport?.addEventListener('resize', syncPosition);
    return () => {
      window.removeEventListener('resize', syncPosition);
      window.removeEventListener('orientationchange', syncPosition);
      window.visualViewport?.removeEventListener('resize', syncPosition);
    };
  }, []);

  const finishMobileAttentionDrag = React.useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraggingMobileAttention(false);
    const releasePosition = drag.moved
      ? clampMobileAttentionDrag(
          getMobileAttentionViewport(),
          {
            x: drag.startX + (event.clientX - drag.originX),
            y: drag.startY + (event.clientY - drag.originY),
          },
        )
      : mobilePosition;
    const snapped = snapMobileAttentionPosition(
      getMobileAttentionViewport(),
      releasePosition,
    );
    preferenceRef.current = snapped.preference;
    setMobilePosition(snapped.position);
    writeMobileAttentionPreference(snapped.preference);
    suppressAttentionClickRef.current = drag.moved;
    window.setTimeout(() => {
      suppressAttentionClickRef.current = false;
    }, 0);
  }, [mobilePosition]);
  const items: Array<{ key: 'running' | 'review'; count: number; className: string }> = [];
  if (runningCount > 0) {
    items.push({ key: 'running', count: runningCount, className: 'bg-[var(--success)] text-[color:var(--success-foreground)]' });
  }
  if (reviewCount > 0) {
    items.push({ key: 'review', count: reviewCount, className: 'bg-[var(--warning)] text-[color:var(--warning-foreground)]' });
  }
  if (items.length === 0) return null;

  const showMobileAttentionButton = reviewCount > 0
    && !sidebarLeftOpen
    && !sidebarRightOpen
    && !keyboardOpen
    && typeof document !== 'undefined';

  return (
    <>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute -right-1 ${items.length > 1 ? 'top-0.5 flex flex-col gap-0.5' : '-top-1'} ${className}`}
      >
        {items.map((item) => (
          <span
            key={item.key}
            className={`flex h-3 min-w-3 items-center justify-center rounded-full px-0.5 text-[7px] font-bold leading-3 shadow-sm ring-1 ring-background ${item.className}`}
          >
            {item.count > 9 ? '9+' : item.count}
          </span>
        ))}
      </span>
      {showMobileAttentionButton && createPortal(
        <button
          type="button"
          data-mobile-attention-button
          onPointerDown={(event) => {
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              pointerId: event.pointerId,
              originX: event.clientX,
              originY: event.clientY,
              startX: mobilePosition.x,
              startY: mobilePosition.y,
              moved: false,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const dx = event.clientX - drag.originX;
            const dy = event.clientY - drag.originY;
            if (!drag.moved && Math.hypot(dx, dy) < 5) return;
            drag.moved = true;
            setDraggingMobileAttention(true);
            setMobilePosition(clampMobileAttentionDrag(
              getMobileAttentionViewport(),
              { x: drag.startX + dx, y: drag.startY + dy },
            ));
          }}
          onPointerUp={finishMobileAttentionDrag}
          onPointerCancel={finishMobileAttentionDrag}
          onClick={(event) => {
            // This portal is rendered from inside the Sessions button. React
            // events still bubble through the component tree across portals,
            // so stop here to avoid opening the left sidebar as a side effect.
            event.stopPropagation();
            if (suppressAttentionClickRef.current) return;
            jumpToNextAgentAttention();
          }}
          className={`fixed z-chrome-hint hidden items-center justify-center rounded-full bg-[var(--warning)] text-[color:var(--warning-foreground)] shadow-[0_8px_24px_var(--app-shadow-strong)] ring-1 ring-[rgb(var(--warning-rgb)_/_0.35)] max-lg:inline-flex animate-fade-in ${
            draggingMobileAttention
              ? 'cursor-grabbing scale-[1.04] shadow-[0_12px_30px_var(--app-shadow-strong)]'
              : 'cursor-grab transition-[left,top,transform,box-shadow] duration-200 active:scale-95'
          }`}
          style={{
            left: mobilePosition.x,
            top: mobilePosition.y,
            width: MOBILE_ATTENTION_SIZE_PX,
            height: MOBILE_ATTENTION_SIZE_PX,
            touchAction: 'none',
          }}
          aria-label={`${t('agent.jumpToNext')}: ${reviewCount}`}
          title={t('agent.jumpToNext')}
        >
          <RiBellDot size={17} className="shrink-0" />
          <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-surface px-1 text-[9px] font-bold tabular-nums text-[color:var(--warning)] ring-2 ring-[var(--chrome-bg)]">
            {reviewCount > 9 ? '9+' : reviewCount}
          </span>
        </button>,
        document.body,
      )}
    </>
  );
}
