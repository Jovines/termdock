/**
 * Agent / 会话状态相关的展示原语，统一收敛在这里。
 *
 * 设计约定（hook 驱动的四态状态机）：
 *   - working → 绿色 spinner（回合进行中）
 *   - waiting → 黄色问号跳动（等你授权/回答——最需要关注的时刻）
 *   - done    → 绿色对勾（回合完成，结果待读）
 *   - idle    → agent 品牌头像（无状态点），无身份时回落 shell/tmux 图标
 *   - review/copy-mode → 黄色呼吸动效（needsReview/inCopyMode）
 */

import React from 'react';
import {
  Terminal as RiTerminalLine,
  LayoutGrid as RiLayoutGridLine,
  LoaderCircle as RiLoaderCircle,
  CircleHelp as RiCircleHelp,
  Check as RiCheck,
  Bot as RiBot,
} from 'lucide-react';
import type { AgentStatus, AgentIdentity } from '../terminal/types';
import { useI18n } from '../i18n';

/** 黄色（待查看 / 等待用户 / copy mode） */
export const AGENT_COLOR_ATTENTION = 'var(--warning)';
/** 绿色（working/done） */
export const AGENT_COLOR_RUNNING = 'var(--success)';

/** 给 tab 图标 / dot 共享的轻量 session 状态 */
export interface AgentVisualState {
  inCopyMode?: boolean;
  agentStatus: AgentStatus | null;
  agent?: AgentIdentity | null;
  agentMessage?: string | null;
  agentNeedsReview?: boolean;
}

/**
 * agent 品牌头像：品牌色圆角方块 + 白色剪影。
 * SVG 资产来自 tty7（Apache-2.0），用 CSS mask 着色，几何为准。
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
  const iconUrl = agent.isPlugin
    ? `/api/terminal/agent-plugin-icon/${agent.slug}`
    : `/icons/agents/${agent.icon}.svg`;
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
  // done 即「未读完成」标记：离开时完成 → 绿勾（带呼吸提醒）；
  // 查看之后（needsReview 已清）→ 回落到品牌头像。
  if (state?.agentStatus === 'done' && state.agentNeedsReview) {
    return (
      <span title={state.agentMessage ?? undefined}>
        <RiCheck size={size} className="shrink-0 animate-pulse" style={{ color: AGENT_COLOR_RUNNING }} />
      </span>
    );
  }

  // 没有活跃状态，但"未读"：黄色呼吸动效图标
  if (state?.agentNeedsReview || state?.inCopyMode) {
    return sessionMode === 'tmux'
      ? <RiLayoutGridLine size={size} className="shrink-0 text-[color:var(--warning)] animate-pulse" />
      : <RiTerminalLine size={size} className="shrink-0 text-[color:var(--warning)] animate-pulse" />;
  }

  return baseIcon;
}

/**
 * 左栏 session 项右上角的小圆点。
 * working=绿，waiting/review=黄，done=绿（静态），copy-mode=黄。
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
  const { t } = useI18n();
  if (status === 'working') {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--success)] ring-2 ring-surface animate-pulse"
        title={t('agent.aiRunning')}
      />
    );
  }
  if (status === 'waiting' || needsReview) {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--warning)] ring-2 ring-surface animate-pulse"
        title={needsReview ? t('agent.finishedReview') : t('agent.aiWaiting')}
      />
    );
  }
  if (status === 'done' && needsReview) {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--success)] ring-2 ring-surface animate-pulse"
        title={t('agent.finishedReview')}
      />
    );
  }
  if (inCopyMode) {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[rgb(var(--warning-rgb)_/_0.80)] ring-2 ring-surface animate-pulse"
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
  if (count <= 0) return null;
  const className = tone === 'running'
    ? 'inline-flex items-center gap-1 rounded-full bg-[rgb(var(--success-rgb)_/_0.12)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--success)]'
    : 'inline-flex items-center gap-1 rounded-full bg-[rgb(var(--warning-rgb)_/_0.12)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--warning)]';
  const dotClassName = tone === 'running'
    ? 'h-1.5 w-1.5 rounded-full bg-[var(--success)] animate-pulse'
    : 'h-1.5 w-1.5 rounded-full bg-[var(--warning)] animate-pulse';
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
