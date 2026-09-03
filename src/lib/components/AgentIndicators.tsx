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
  MOBILE_ATTENTION_EDGE_GAP_PX,
  MOBILE_ATTENTION_SIZE_PX,
  avoidMobileAttentionOverlap,
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
const RUNNING_SESSION_POSITION_KEY = 'termdock:running-session-position:v1';
const MOBILE_ATTENTION_DEFAULT_PREFERENCE: MobileAttentionPreference = {
  side: 'right',
  yRatio: 0.68,
};
const RUNNING_SESSION_DEFAULT_PREFERENCE: MobileAttentionPreference = {
  side: 'right',
  yRatio: 0.54,
};

function readFloatingButtonPreference(
  storageKey: string,
  fallback: MobileAttentionPreference,
): MobileAttentionPreference {
  if (typeof window === 'undefined') return fallback;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(storageKey) ?? 'null',
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
  return fallback;
}

function writeFloatingButtonPreference(
  storageKey: string,
  preference: MobileAttentionPreference,
): void {
  try {
    window.localStorage.setItem(
      storageKey,
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

export interface FloatingSessionOcclusionInsets {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

function getMobileAttentionViewport(
  isDesktopLayout: boolean,
  containerElement: HTMLElement | null,
  occlusionInsets: FloatingSessionOcclusionInsets = {},
): MobileAttentionViewport {
  if (typeof window === 'undefined') return { width: 390, height: 664 };
  const visualViewport = window.visualViewport;
  const width = visualViewport?.width ?? window.innerWidth;
  const height = visualViewport?.height ?? window.innerHeight;
  const bounds = containerElement?.getBoundingClientRect();
  const hasContainerBounds = Boolean(bounds && bounds.width > 0 && bounds.height > 0);
  return {
    width,
    height,
    safeTop: Math.max(
      readSafeInset('--safe-top-inset'),
      (hasContainerBounds ? Math.max(0, bounds!.top) : 0) + Math.max(0, occlusionInsets.top ?? 0),
    ),
    safeRight: Math.max(
      readSafeInset('--safe-right-inset'),
      (hasContainerBounds ? Math.max(0, width - bounds!.right) : 0) + Math.max(0, occlusionInsets.right ?? 0),
    ),
    safeBottom: Math.max(
      readSafeInset('--safe-bottom-inset'),
      (hasContainerBounds ? Math.max(0, height - bounds!.bottom) : 0) + Math.max(0, occlusionInsets.bottom ?? 0),
    ),
    safeLeft: Math.max(
      readSafeInset('--safe-left-inset'),
      (hasContainerBounds ? Math.max(0, bounds!.left) : 0) + Math.max(0, occlusionInsets.left ?? 0),
    ),
    bottomClearance: isDesktopLayout ? MOBILE_ATTENTION_EDGE_GAP_PX : 72,
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

function jumpToSession(sessionId: string): void {
  window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: sessionId }));
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
  const items: Array<{ key: 'running' | 'review'; count: number; className: string }> = [];
  if (runningCount > 0) {
    items.push({ key: 'running', count: runningCount, className: 'bg-[var(--success)] text-[color:var(--success-foreground)]' });
  }
  if (reviewCount > 0) {
    items.push({ key: 'review', count: reviewCount, className: 'bg-[var(--warning)] text-[color:var(--warning-foreground)]' });
  }
  if (items.length === 0) return null;

  return (
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
  );
}

type FloatingSessionButtonKind = 'attention' | 'running';
type FloatingSessionButtonPositions = Record<FloatingSessionButtonKind, MobileAttentionPosition>;
type RunningGestureMode = 'idle' | 'pressing' | 'selecting' | 'dragging';
const RUNNING_LONG_PRESS_MS = 380;
const RUNNING_SWIPE_THRESHOLD_PX = 10;
const RUNNING_RAIL_GAP_PX = 10;
const RUNNING_RAIL_HEIGHT_PX = 52;
const RUNNING_RAIL_ITEM_WIDTH_PX = 104;

export interface RunningSessionShortcut {
  id: string;
  label: string;
  detail?: string | null;
}

interface RunningSessionRailLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  itemWidth: number;
  side: 'left' | 'right';
}

function getRunningSessionRailLayout(
  position: MobileAttentionPosition,
  viewport: MobileAttentionViewport,
  count: number,
): RunningSessionRailLayout {
  const terminalLeft = Math.max(0, viewport.safeLeft ?? 0);
  const terminalRight = viewport.width - Math.max(0, viewport.safeRight ?? 0);
  const terminalTop = Math.max(0, viewport.safeTop ?? 0);
  const terminalBottom = viewport.height - Math.max(0, viewport.safeBottom ?? 0);
  const edgeGap = MOBILE_ATTENTION_EDGE_GAP_PX;
  const opensLeft = position.x + (MOBILE_ATTENTION_SIZE_PX / 2)
    >= terminalLeft + ((terminalRight - terminalLeft) / 2);
  const availableWidth = opensLeft
    ? position.x - RUNNING_RAIL_GAP_PX - terminalLeft - edgeGap
    : terminalRight - edgeGap - position.x - MOBILE_ATTENTION_SIZE_PX - RUNNING_RAIL_GAP_PX;
  const width = Math.max(1, Math.min(
    Math.max(0, availableWidth),
    Math.max(168, count * RUNNING_RAIL_ITEM_WIDTH_PX),
  ));
  const desiredLeft = opensLeft
    ? position.x - RUNNING_RAIL_GAP_PX - width
    : position.x + MOBILE_ATTENTION_SIZE_PX + RUNNING_RAIL_GAP_PX;
  const left = Math.min(
    Math.max(desiredLeft, terminalLeft + edgeGap),
    Math.max(terminalLeft + edgeGap, terminalRight - edgeGap - width),
  );
  const desiredTop = position.y + (MOBILE_ATTENTION_SIZE_PX / 2) - (RUNNING_RAIL_HEIGHT_PX / 2);
  const top = Math.min(
    Math.max(desiredTop, terminalTop + edgeGap),
    Math.max(terminalTop + edgeGap, terminalBottom - edgeGap - RUNNING_RAIL_HEIGHT_PX),
  );
  return {
    left,
    top,
    width,
    height: RUNNING_RAIL_HEIGHT_PX,
    itemWidth: width / Math.max(1, count),
    side: opensLeft ? 'left' : 'right',
  };
}

function getRunningRailSelectionIndex(
  layout: RunningSessionRailLayout,
  clientX: number,
  clientY: number,
  count: number,
): number | null {
  const verticalTolerance = 14;
  if (
    clientX < layout.left
    || clientX > layout.left + layout.width
    || clientY < layout.top - verticalTolerance
    || clientY > layout.top + layout.height + verticalTolerance
  ) {
    return null;
  }
  return Math.min(count - 1, Math.max(0, Math.floor((clientX - layout.left) / layout.itemWidth)));
}

function getNextRunningShortcutId(
  sessions: readonly RunningSessionShortcut[],
  activeSessionId: string | null,
): string | null {
  if (sessions.length === 0) return null;
  const activeIndex = activeSessionId
    ? sessions.findIndex((session) => session.id === activeSessionId)
    : -1;
  return sessions[(activeIndex + 1) % sessions.length]?.id ?? null;
}

/** Terminal 内的会话快捷入口：共用边界，运行中按钮额外支持轻点、横滑选择和长按拖动。 */
export function AgentFloatingSessionButtons({
  reviewCount,
  runningSessions,
  activeSessionId,
  runningButtonEnabled,
  isDesktopLayout,
  containerElement,
  occlusionInsets,
}: {
  reviewCount: number;
  runningSessions: readonly RunningSessionShortcut[];
  activeSessionId: string | null;
  runningButtonEnabled: boolean;
  isDesktopLayout: boolean;
  containerElement: HTMLElement | null;
  /** Persistent UI occupying an edge of the terminal's otherwise full-size container. */
  occlusionInsets?: FloatingSessionOcclusionInsets;
}): React.ReactElement | null {
  const { t } = useI18n();
  const sidebarLeftOpen = useSidebarStore((state) => state.leftOpen);
  const sidebarRightOpen = useSidebarStore((state) => state.rightOpen);
  const { isOpen: keyboardOpen } = useViewportKeyboardState({ enabled: !isDesktopLayout });
  const floatingChromeVisible = isDesktopLayout
    || (!sidebarLeftOpen && !sidebarRightOpen && !keyboardOpen);
  const attentionVisible = reviewCount > 0 && floatingChromeVisible;
  const canJumpToRunningSession = runningSessions.length > 1
    || (runningSessions.length === 1 && runningSessions[0]?.id !== activeSessionId);
  const runningVisible = runningButtonEnabled
    && runningSessions.length > 0
    && canJumpToRunningSession
    && floatingChromeVisible;
  const occlusionTop = Math.max(0, occlusionInsets?.top ?? 0);
  const occlusionRight = Math.max(0, occlusionInsets?.right ?? 0);
  const occlusionBottom = Math.max(0, occlusionInsets?.bottom ?? 0);
  const occlusionLeft = Math.max(0, occlusionInsets?.left ?? 0);
  const getFloatingViewport = React.useCallback(() => getMobileAttentionViewport(
    isDesktopLayout,
    containerElement,
    {
      top: occlusionTop,
      right: occlusionRight,
      bottom: occlusionBottom,
      left: occlusionLeft,
    },
  ), [containerElement, isDesktopLayout, occlusionBottom, occlusionLeft, occlusionRight, occlusionTop]);
  const preferencesRef = React.useRef<Record<FloatingSessionButtonKind, MobileAttentionPreference>>({
    attention: readFloatingButtonPreference(
      MOBILE_ATTENTION_POSITION_KEY,
      MOBILE_ATTENTION_DEFAULT_PREFERENCE,
    ),
    running: readFloatingButtonPreference(
      RUNNING_SESSION_POSITION_KEY,
      RUNNING_SESSION_DEFAULT_PREFERENCE,
    ),
  });

  const resolvePositions = React.useCallback((): FloatingSessionButtonPositions => {
    const viewport = getFloatingViewport();
    const attention = resolveMobileAttentionPosition(viewport, preferencesRef.current.attention);
    const rawRunning = resolveMobileAttentionPosition(viewport, preferencesRef.current.running);
    return {
      attention,
      running: attentionVisible && runningVisible
        ? avoidMobileAttentionOverlap(viewport, rawRunning, attention)
        : rawRunning,
    };
  }, [attentionVisible, getFloatingViewport, runningVisible]);
  const [positions, setPositions] = React.useState<FloatingSessionButtonPositions>(
    () => resolvePositions(),
  );
  const positionsRef = React.useRef(positions);
  positionsRef.current = positions;
  const [draggingKind, setDraggingKind] = React.useState<FloatingSessionButtonKind | null>(null);
  const dragRef = React.useRef<{
    kind: FloatingSessionButtonKind;
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [runningGestureMode, setRunningGestureMode] = React.useState<RunningGestureMode>('idle');
  const [selectedRunningIndex, setSelectedRunningIndex] = React.useState<number | null>(null);
  const runningGestureRef = React.useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
    mode: Exclude<RunningGestureMode, 'idle'> | 'cancelled';
    moved: boolean;
    selectedIndex: number | null;
    longPressTimer: number | null;
  } | null>(null);
  const suppressClickRef = React.useRef<Record<FloatingSessionButtonKind, boolean>>({
    attention: false,
    running: false,
  });

  React.useEffect(() => () => {
    const timer = runningGestureRef.current?.longPressTimer;
    if (timer !== null && timer !== undefined) window.clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    if (runningVisible) return;
    const timer = runningGestureRef.current?.longPressTimer;
    if (timer !== null && timer !== undefined) window.clearTimeout(timer);
    runningGestureRef.current = null;
    setRunningGestureMode('idle');
    setSelectedRunningIndex(null);
  }, [runningVisible]);

  React.useLayoutEffect(() => {
    const syncPositions = () => {
      const next = resolvePositions();
      positionsRef.current = next;
      setPositions(next);
    };
    syncPositions();
    window.addEventListener('resize', syncPositions);
    window.addEventListener('orientationchange', syncPositions);
    window.visualViewport?.addEventListener('resize', syncPositions);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(syncPositions);
    if (containerElement) resizeObserver?.observe(containerElement);
    return () => {
      window.removeEventListener('resize', syncPositions);
      window.removeEventListener('orientationchange', syncPositions);
      window.visualViewport?.removeEventListener('resize', syncPositions);
      resizeObserver?.disconnect();
    };
  }, [containerElement, resolvePositions]);

  const isOtherButtonVisible = React.useCallback((kind: FloatingSessionButtonKind): boolean => (
    kind === 'attention' ? runningVisible : attentionVisible
  ), [attentionVisible, runningVisible]);

  const avoidOtherButton = React.useCallback((
    kind: FloatingSessionButtonKind,
    position: MobileAttentionPosition,
  ): MobileAttentionPosition => {
    if (!isOtherButtonVisible(kind)) return position;
    const otherKind = kind === 'attention' ? 'running' : 'attention';
    return avoidMobileAttentionOverlap(
      getFloatingViewport(),
      position,
      positionsRef.current[otherKind],
    );
  }, [getFloatingViewport, isOtherButtonVisible]);

  const persistReleasedPosition = React.useCallback((
    kind: FloatingSessionButtonKind,
    drag: {
      originX: number;
      originY: number;
      startX: number;
      startY: number;
      moved: boolean;
    },
    clientX: number,
    clientY: number,
  ) => {
    const viewport = getFloatingViewport();
    const released = drag.moved
      ? clampMobileAttentionDrag(viewport, {
          x: drag.startX + (clientX - drag.originX),
          y: drag.startY + (clientY - drag.originY),
        })
      : positionsRef.current[kind];
    const snapped = snapMobileAttentionPosition(viewport, released);
    const separated = avoidOtherButton(kind, snapped.position);
    const finalPosition = snapMobileAttentionPosition(viewport, separated);
    preferencesRef.current[kind] = finalPosition.preference;
    writeFloatingButtonPreference(
      kind === 'attention' ? MOBILE_ATTENTION_POSITION_KEY : RUNNING_SESSION_POSITION_KEY,
      finalPosition.preference,
    );
    const next = { ...positionsRef.current, [kind]: finalPosition.position };
    positionsRef.current = next;
    setPositions(next);
  }, [avoidOtherButton, getFloatingViewport]);

  const suppressSyntheticClick = React.useCallback((kind: FloatingSessionButtonKind) => {
    suppressClickRef.current[kind] = true;
    window.setTimeout(() => {
      suppressClickRef.current[kind] = false;
    }, 0);
  }, []);

  const finishAttentionDrag = React.useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.kind !== 'attention' || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraggingKind(null);
    persistReleasedPosition('attention', drag, event.clientX, event.clientY);
    if (drag.moved) suppressSyntheticClick('attention');
  }, [persistReleasedPosition, suppressSyntheticClick]);

  const attentionDragHandlers: Pick<React.ButtonHTMLAttributes<HTMLButtonElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'> = {
    onPointerDown: (event) => {
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        kind: 'attention',
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        startX: positions.attention.x,
        startY: positions.attention.y,
        moved: false,
      };
    },
    onPointerMove: (event) => {
      const drag = dragRef.current;
      if (!drag || drag.kind !== 'attention' || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.originX;
      const dy = event.clientY - drag.originY;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      setDraggingKind('attention');
      const viewport = getFloatingViewport();
      const moved = avoidOtherButton('attention', clampMobileAttentionDrag(viewport, {
        x: drag.startX + dx,
        y: drag.startY + dy,
      }));
      const next = { ...positionsRef.current, attention: moved };
      positionsRef.current = next;
      setPositions(next);
    },
    onPointerUp: finishAttentionDrag,
    onPointerCancel: finishAttentionDrag,
  };

  const runningRailLayout = containerElement
    ? getRunningSessionRailLayout(positions.running, getFloatingViewport(), runningSessions.length)
    : null;

  const clearRunningLongPress = (gesture: NonNullable<typeof runningGestureRef.current>) => {
    if (gesture.longPressTimer !== null) {
      window.clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = null;
    }
  };

  const runningPointerHandlers: Pick<React.ButtonHTMLAttributes<HTMLButtonElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'> = {
    onPointerDown: (event) => {
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const pointerId = event.pointerId;
      const gesture: NonNullable<typeof runningGestureRef.current> = {
        pointerId,
        originX: event.clientX,
        originY: event.clientY,
        startX: positions.running.x,
        startY: positions.running.y,
        mode: 'pressing',
        moved: false,
        selectedIndex: null,
        longPressTimer: null,
      };
      gesture.longPressTimer = window.setTimeout(() => {
        const current = runningGestureRef.current;
        if (!current || current.pointerId !== pointerId || current.mode !== 'pressing') return;
        current.longPressTimer = null;
        current.mode = 'dragging';
        suppressClickRef.current.running = true;
        setRunningGestureMode('dragging');
      }, RUNNING_LONG_PRESS_MS);
      runningGestureRef.current = gesture;
      setRunningGestureMode('pressing');
      setSelectedRunningIndex(null);
    },
    onPointerMove: (event) => {
      const gesture = runningGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const dx = event.clientX - gesture.originX;
      const dy = event.clientY - gesture.originY;

      if (gesture.mode === 'pressing') {
        if (Math.abs(dx) >= RUNNING_SWIPE_THRESHOLD_PX && Math.abs(dx) >= Math.abs(dy)) {
          clearRunningLongPress(gesture);
          gesture.mode = 'selecting';
          suppressClickRef.current.running = true;
          setRunningGestureMode('selecting');
        } else if (Math.hypot(dx, dy) >= RUNNING_SWIPE_THRESHOLD_PX) {
          clearRunningLongPress(gesture);
          gesture.mode = 'cancelled';
          suppressClickRef.current.running = true;
          setRunningGestureMode('idle');
          return;
        } else {
          return;
        }
      }

      if (gesture.mode === 'selecting') {
        const index = runningRailLayout
          ? getRunningRailSelectionIndex(
              runningRailLayout,
              event.clientX,
              event.clientY,
              runningSessions.length,
            )
          : null;
        gesture.selectedIndex = index;
        setSelectedRunningIndex(index);
        return;
      }

      if (gesture.mode !== 'dragging') return;
      if (!gesture.moved && Math.hypot(dx, dy) < 5) return;
      gesture.moved = true;
      const viewport = getFloatingViewport();
      const moved = avoidOtherButton('running', clampMobileAttentionDrag(viewport, {
        x: gesture.startX + dx,
        y: gesture.startY + dy,
      }));
      const next = { ...positionsRef.current, running: moved };
      positionsRef.current = next;
      setPositions(next);
    },
    onPointerUp: (event) => {
      const gesture = runningGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      clearRunningLongPress(gesture);
      const mode = gesture.mode;
      if (mode === 'selecting') {
        const index = runningRailLayout
          ? getRunningRailSelectionIndex(
              runningRailLayout,
              event.clientX,
              event.clientY,
              runningSessions.length,
            )
          : gesture.selectedIndex;
        const sessionId = index === null ? null : runningSessions[index]?.id;
        if (sessionId) jumpToSession(sessionId);
      } else if (mode === 'dragging') {
        persistReleasedPosition('running', gesture, event.clientX, event.clientY);
      }
      runningGestureRef.current = null;
      setRunningGestureMode('idle');
      setSelectedRunningIndex(null);
      if (mode !== 'pressing') suppressSyntheticClick('running');
    },
    onPointerCancel: (event) => {
      const gesture = runningGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      clearRunningLongPress(gesture);
      runningGestureRef.current = null;
      setRunningGestureMode('idle');
      setSelectedRunningIndex(null);
      suppressSyntheticClick('running');
    },
  };

  const renderCountBadge = (
    count: number,
    tone: 'attention' | 'running',
  ): React.ReactElement => (
    <span className={`pointer-events-none absolute -right-1 -top-1 z-10 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-surface px-1 text-[9px] font-bold tabular-nums ring-2 ring-[var(--chrome-bg)] ${
      tone === 'attention' ? 'text-[color:var(--warning)]' : 'text-[color:var(--success)]'
    }`}>
      {count > 9 ? '9+' : count}
    </span>
  );

  const renderAttentionButton = (): React.ReactElement => {
    const label = t('agent.jumpToNext');
    const position = positions.attention;
    const dragging = draggingKind === 'attention';
    return (
      <button
        key="attention"
        type="button"
        data-attention-button
        data-mobile-attention-button
        {...attentionDragHandlers}
        onClick={(event) => {
          event.stopPropagation();
          if (suppressClickRef.current.attention) return;
          jumpToNextAgentAttention();
        }}
        className={`fixed z-chrome-hint inline-flex items-center justify-center rounded-full bg-[var(--warning)] text-[color:var(--warning-foreground)] shadow-[0_8px_24px_var(--app-shadow-strong)] ring-1 ring-[rgb(var(--warning-rgb)_/_0.35)] animate-fade-in ${
          dragging
            ? 'cursor-grabbing scale-[1.04] shadow-[0_12px_30px_var(--app-shadow-strong)]'
            : 'cursor-grab transition-[left,top,transform,box-shadow] duration-200 active:scale-95'
        }`}
        style={{
          left: position.x,
          top: position.y,
          width: MOBILE_ATTENTION_SIZE_PX,
          height: MOBILE_ATTENTION_SIZE_PX,
          touchAction: 'none',
        }}
        aria-label={`${label}: ${reviewCount}`}
        title={label}
      >
        <RiBellDot size={17} className="shrink-0" />
        {renderCountBadge(reviewCount, 'attention')}
      </button>
    );
  };

  const renderRunningButton = (): React.ReactElement => {
    const count = runningSessions.length;
    const position = positions.running;
    const selecting = runningGestureMode === 'selecting';
    const dragging = runningGestureMode === 'dragging';
    return (
      <React.Fragment key="running">
        <button
          type="button"
          data-running-session-button
          data-running-session-gesture={runningGestureMode}
          {...runningPointerHandlers}
          onClick={(event) => {
            event.stopPropagation();
            if (suppressClickRef.current.running) return;
            const sessionId = getNextRunningShortcutId(runningSessions, activeSessionId);
            if (sessionId) jumpToSession(sessionId);
          }}
          className={`fixed z-chrome-hint inline-flex select-none items-center justify-center rounded-full bg-[var(--success)] text-[color:var(--success-foreground)] shadow-[0_8px_24px_var(--app-shadow-strong)] ring-1 ring-[rgb(var(--success-rgb)_/_0.35)] animate-fade-in ${
            dragging
              ? 'cursor-grabbing scale-[1.04] shadow-[0_12px_30px_var(--app-shadow-strong)]'
              : selecting
                ? 'cursor-ew-resize scale-[1.04] ring-2 ring-[rgb(var(--success-rgb)_/_0.55)]'
                : 'cursor-grab transition-[left,top,transform,box-shadow] duration-200 active:scale-95'
          }`}
          style={{
            left: position.x,
            top: position.y,
            width: MOBILE_ATTENTION_SIZE_PX,
            height: MOBILE_ATTENTION_SIZE_PX,
            touchAction: 'none',
          }}
          aria-label={`${t('agent.jumpToNextRunning')}: ${count}`}
          title={t('agent.runningSessionGestureHint')}
        >
          <RiLoaderCircle size={18} className="shrink-0 animate-spin" />
          {renderCountBadge(count, 'running')}
        </button>
        {selecting && runningRailLayout && (
          <div
            role="listbox"
            data-running-session-rail
            data-side={runningRailLayout.side}
            aria-label={t('agent.selectRunningSession')}
            className="pointer-events-none fixed z-popover flex overflow-hidden rounded-full border border-border/15 bg-surface/95 p-1 shadow-[0_18px_48px_var(--app-shadow-soft)] backdrop-blur animate-fade-in"
            style={{
              left: runningRailLayout.left,
              top: runningRailLayout.top,
              width: runningRailLayout.width,
              height: runningRailLayout.height,
            }}
          >
            {runningSessions.map((session, index) => {
              const isSelected = index === selectedRunningIndex;
              const isActive = session.id === activeSessionId;
              const title = `${session.label}${session.detail ? ` · ${session.detail}` : ''}${
                isActive ? ` · ${t('agent.currentSession')}` : ''
              }`;
              return (
                <div
                  key={session.id}
                  role="option"
                  aria-selected={isSelected}
                  data-running-session-option={session.id}
                  data-selected={isSelected ? 'true' : 'false'}
                  title={title}
                  className={`relative flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 transition-[background-color,color,transform] duration-100 ${
                    isSelected
                      ? 'scale-[1.02] bg-[var(--success)] text-[color:var(--success-foreground)]'
                      : isActive
                        ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                        : 'text-foreground'
                  }`}
                >
                  <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold tabular-nums ${
                    isSelected ? 'bg-surface/25' : 'bg-surface-2 text-muted-foreground'
                  }`}>
                    {index + 1}
                  </span>
                  <span className="truncate text-[10px] font-medium">{session.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </React.Fragment>
    );
  };

  if ((!attentionVisible && !runningVisible) || containerElement === null || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <>
      {attentionVisible && renderAttentionButton()}
      {runningVisible && renderRunningButton()}
    </>,
    document.body,
  );
}
