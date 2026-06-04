/**
 * Agent / 会话状态相关的展示原语，统一收敛在这里。
 *
 * 设计约定：
 *   - "running"   → 绿色 + 动效（常见为 spinner/pulse）
 *   - "waiting"   → 黄色问号图标 + 跳动动效（indicator=question）
 *   - "review/copy-mode" → 黄色呼吸动效（needsReview/inCopyMode）
 */

import React from 'react';
import {
  Terminal as RiTerminalLine,
  LayoutGrid as RiLayoutGridLine,
  LoaderCircle as RiLoaderCircle,
  CircleHelp as RiCircleHelp,
} from 'lucide-react';
import type { AgentStatus, AgentIndicator } from '../terminal/types';

/** 黄色（待查看 / 等待用户 / copy mode） */
export const AGENT_COLOR_ATTENTION = '#facc15';
/** 绿色（running） */
export const AGENT_COLOR_RUNNING = '#4ade80';

/** 给 tab 图标 / dot 共享的轻量 session 状态 */
export interface AgentVisualState {
  inCopyMode?: boolean;
  agentStatus: AgentStatus | null;
  agentColor?: string | null;
  agentIndicator?: AgentIndicator | null;
  agentNeedsReview?: boolean;
}

/**
 * 顶部 tab 上的图标。会按 agent indicator 规则渲染对应的状态图标，
 * 都没有就回落到 shell/tmux 默认图标。
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
  const baseIcon = sessionMode === 'tmux'
    ? <RiLayoutGridLine size={size} className="shrink-0" />
    : <RiTerminalLine size={size} className="shrink-0" />;

  const isAttention = state?.agentStatus === 'waiting' || state?.agentNeedsReview || state?.inCopyMode;
  const color = state?.agentColor || (isAttention ? AGENT_COLOR_ATTENTION : undefined);

  if (state?.agentStatus) {
    const indicator = state.agentIndicator || (state.agentStatus === 'running' ? 'spinner' : 'pulse');
    const style = color ? { color } : undefined;
    if (indicator === 'spinner') {
      return <RiLoaderCircle size={size} className="shrink-0 animate-spin" style={style} />;
    }
    if (indicator === 'dot') {
      return <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color || AGENT_COLOR_RUNNING }} />;
    }
    if (indicator === 'ring') {
      return <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 animate-pulse" style={{ borderColor: color || AGENT_COLOR_ATTENTION }} />;
    }
    if (indicator === 'question') {
      return <RiCircleHelp size={size} className="shrink-0 animate-bounce-y" style={style} />;
    }
    if (indicator === 'badge') {
      return (
        <span
          className="shrink-0 rounded bg-surface px-1 text-[8px] font-semibold uppercase leading-3"
          style={style}
        >
          {state.agentStatus.slice(0, 2)}
        </span>
      );
    }
    if (indicator === 'terminal') {
      return sessionMode === 'tmux'
        ? <RiLayoutGridLine size={size} className="shrink-0" style={style} />
        : <RiTerminalLine size={size} className="shrink-0" style={style} />;
    }
    // 默认 / pulse：呼吸的小圆
    return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full" style={{ backgroundColor: color || AGENT_COLOR_RUNNING }} />;
  }

  // 没有 agentStatus（已停止），但仍是"未读"：黄色呼吸动效图标
  if (state?.agentNeedsReview || state?.inCopyMode) {
    return sessionMode === 'tmux'
      ? <RiLayoutGridLine size={size} className="shrink-0 text-yellow-400 animate-pulse" />
      : <RiTerminalLine size={size} className="shrink-0 text-yellow-400 animate-pulse" />;
  }

  return baseIcon;
}

/**
 * 左栏 session 项右上角的小圆点（绿色 = running，黄色 = review/waiting/copy）。
 * 不显示则返回 null。
 */
export function AgentSessionDot({
  status,
  needsReview,
  inCopyMode,
}: {
  status: AgentStatus | null;
  needsReview?: boolean;
  inCopyMode?: boolean;
}): React.ReactElement | null {
  if (status === 'running') {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-green-400 ring-2 ring-surface animate-pulse"
        title="AI running"
      />
    );
  }
  if (status === 'waiting' || needsReview) {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-yellow-400 ring-2 ring-surface animate-pulse"
        title={needsReview ? 'AI finished — needs review' : 'AI waiting'}
      />
    );
  }
  if (inCopyMode) {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-yellow-400/80 ring-2 ring-surface animate-pulse"
        title="Copy mode"
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
  if (count <= 0) return null;
  const className = tone === 'running'
    ? 'inline-flex items-center gap-1 rounded-full bg-green-400/10 px-1.5 py-0.5 text-[10px] font-medium text-green-400'
    : 'inline-flex items-center gap-1 rounded-full bg-yellow-400/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400';
  const dotClassName = tone === 'running'
    ? 'h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse'
    : 'h-1.5 w-1.5 rounded-full bg-yellow-400 animate-pulse';
  return (
    <span className={className} title={title}>
      <span className={dotClassName} />
      {count}
    </span>
  );
}
