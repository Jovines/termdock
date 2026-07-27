/**
 * Agent hooks 安装管理：为每个支持的 agent 安装/卸载状态上报 hooks。
 * hooks 让 agent 主动上报回合状态（working / waiting / done），
 * 代替之前基于屏幕内容的 regex 猜测（误报/漏报多，已废弃）。
 */

import React from 'react';
import {
  LoaderCircle as RiLoaderCircle,
  CircleCheck as RiCircleCheck,
  TriangleAlert as RiAlertLine,
  Download as RiDownloadLine,
  Trash2 as RiDeleteBinLine,
  RefreshCw as RiRefreshLine,
} from 'lucide-react';
import {
  getAgentHooks,
  installAgentHooks,
  uninstallAgentHooks,
  type AgentHookInfo,
} from '../../terminal/api';
import { AgentBrandAvatar } from '../AgentIndicators';
import { useI18n } from '../../i18n';

const STATE_STYLE: Record<AgentHookInfo['state'], string> = {
  installed: 'text-[color:var(--success)]',
  outdated: 'text-[color:var(--warning)]',
  'not-installed': 'text-muted-foreground',
};

function AgentHooksSettings(): React.ReactElement {
  const { t } = useI18n();
  const [agents, setAgents] = React.useState<AgentHookInfo[] | null>(null);
  const [busySlug, setBusySlug] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [devModeSlug, setDevModeSlug] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setAgents(await getAgentHooks());
    } catch {
      setAgents([]);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (slug: string, action: 'install' | 'uninstall') => {
    setBusySlug(slug);
    setError(null);
    try {
      if (action === 'install') {
        const result = await installAgentHooks(slug);
        if (result.devMode) setDevModeSlug(slug);
      } else {
        await uninstallAgentHooks(slug);
        if (devModeSlug === slug) setDevModeSlug(null);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySlug(null);
    }
  };

  const stateLabel = (state: AgentHookInfo['state']): string => {
    if (state === 'installed') return t('settings.agentHooksInstalled');
    if (state === 'outdated') return t('settings.agentHooksOutdated');
    return t('settings.agentHooksNotInstalled');
  };

  return (
    <div className="space-y-2">
      {agents === null && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <RiLoaderCircle size={12} className="animate-spin" /> …
        </div>
      )}
      {agents?.map((agent) => {
        const busy = busySlug === agent.slug;
        const installed = agent.state !== 'not-installed';
        return (
          <div
            key={agent.slug}
            className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5"
          >
            <AgentBrandAvatar
              agent={{
                slug: agent.slug,
                displayName: agent.displayName,
                accentColor: agent.accentColor ?? '#878580',
                icon: agent.icon,
              }}
              size={18}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-foreground">{agent.displayName}</span>
                <span className={`text-[10px] ${STATE_STYLE[agent.state]}`}>
                  {agent.state === 'installed' && <RiCircleCheck size={10} className="mr-0.5 inline" />}
                  {agent.state === 'outdated' && <RiAlertLine size={10} className="mr-0.5 inline" />}
                  {stateLabel(agent.state)}
                </span>
              </div>
              <div className="truncate text-[10px] text-muted-foreground" title={agent.targetDisplay}>
                {t('settings.agentHooksTarget')} {agent.targetDisplay}
              </div>
              {devModeSlug === agent.slug && (
                <div className="mt-0.5 text-[10px] text-[color:var(--warning)]">
                  {t('settings.agentHooksDevMode')}
                </div>
              )}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(agent.slug, installed ? 'uninstall' : 'install')}
              className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                installed
                  ? 'bg-surface text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                  : 'bg-[rgb(var(--success-rgb)_/_0.14)] text-[color:var(--success)] hover:bg-[rgb(var(--success-rgb)_/_0.22)]'
              } disabled:opacity-50`}
            >
              {busy ? (
                <RiLoaderCircle size={11} className="animate-spin" />
              ) : installed ? (
                <RiDeleteBinLine size={11} />
              ) : agent.state === 'outdated' ? (
                <RiRefreshLine size={11} />
              ) : (
                <RiDownloadLine size={11} />
              )}
              {busy
                ? '…'
                : installed
                  ? t('settings.agentHooksUninstall')
                  : agent.state === 'outdated'
                    ? t('settings.agentHooksReinstall')
                    : t('settings.agentHooksInstall')}
            </button>
          </div>
        );
      })}
      {error && (
        <div className="rounded-xl bg-[rgb(var(--warning-rgb)_/_0.10)] px-3 py-2 text-[11px] text-[color:var(--warning)]">
          {error}
        </div>
      )}
    </div>
  );
}

export default AgentHooksSettings;
