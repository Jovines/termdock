/**
 * Agent hooks 安装管理：为每个支持的 agent 安装/卸载状态上报 hooks。
 * hooks 让 agent 主动上报回合状态（working / waiting / done），
 * 代替之前基于屏幕内容的 regex 猜测（误报/漏报多，已废弃）。
 *
 * 同时管理用户自定义插件（user-defined agent plugins）。
 */

import React from 'react';
import {
  LoaderCircle as RiLoaderCircle,
  CircleCheck as RiCircleCheck,
  TriangleAlert as RiAlertLine,
  Download as RiDownloadLine,
  Trash2 as RiDeleteBinLine,
  RefreshCw as RiRefreshLine,
  Plus as RiAddLine,
  Code as RiCodeLine,
} from 'lucide-react';
import {
  getAgentHooks,
  installAgentHooks,
  uninstallAgentHooks,
  getAgentPlugins,
  createAgentPlugin,
  deleteAgentPlugin,
  type AgentHookInfo,
  type AgentPluginInfo,
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
  const [showPluginEditor, setShowPluginEditor] = React.useState(false);
  const [pluginManifest, setPluginManifest] = React.useState('');
  const [pluginError, setPluginError] = React.useState<string | null>(null);
  const [plugins, setPlugins] = React.useState<AgentPluginInfo[]>([]);

  const refresh = React.useCallback(async () => {
    try {
      setAgents(await getAgentHooks());
    } catch {
      setAgents([]);
    }
    try {
      const data = await getAgentPlugins();
      setPlugins(data.plugins ?? []);
    } catch {
      setPlugins([]);
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

  const handleCreatePlugin = async () => {
    setPluginError(null);
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(pluginManifest);
    } catch {
      setPluginError('Invalid JSON');
      return;
    }
    try {
      await createAgentPlugin(manifest);
      setPluginManifest('');
      setShowPluginEditor(false);
      await refresh();
    } catch (err) {
      setPluginError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeletePlugin = async (slug: string) => {
    try {
      await deleteAgentPlugin(slug);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pluginSlugs = new Set(plugins.map((p) => p.slug));

  return (
    <div className="space-y-3">
      {agents === null && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <RiLoaderCircle size={12} className="animate-spin" /> …
        </div>
      )}
      {agents?.map((agent) => {
        const busy = busySlug === agent.slug;
        const installed = agent.state !== 'not-installed';
        const isPlugin = pluginSlugs.has(agent.slug);
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
                isPlugin,
              }}
              size={18}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-foreground">{agent.displayName}</span>
                {isPlugin && (
                  <span className="rounded bg-[rgb(var(--success-rgb)_/_0.12)] px-1 py-px text-[9px] font-medium text-[color:var(--success)]">
                    plugin
                  </span>
                )}
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
            <div className="flex items-center gap-1">
              {isPlugin && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleDeletePlugin(agent.slug)}
                  className="flex shrink-0 items-center rounded-full p-1 text-[11px] text-muted-foreground hover:bg-surface-elevated hover:text-[color:var(--warning)] transition disabled:opacity-50"
                  title={t('settings.agentPluginDelete')}
                >
                  <RiDeleteBinLine size={11} />
                </button>
              )}
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
          </div>
        );
      })}
      {error && (
        <div className="rounded-xl bg-[rgb(var(--warning-rgb)_/_0.10)] px-3 py-2 text-[11px] text-[color:var(--warning)]">
          {error}
        </div>
      )}

      {/* ── Plugin management ── */}
      <div className="rounded-xl bg-surface-2 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-foreground">{t('settings.agentPlugins')}</span>
          <button
            type="button"
            onClick={() => setShowPluginEditor(!showPluginEditor)}
            className="flex items-center gap-1 rounded-full bg-[rgb(var(--success-rgb)_/_0.14)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--success)] hover:bg-[rgb(var(--success-rgb)_/_0.22)] transition"
          >
            <RiAddLine size={11} />
            {t('settings.agentPluginAdd')}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">{t('settings.agentPluginHint')}</p>

        {showPluginEditor && (
          <div className="mt-2 space-y-2">
            <textarea
              value={pluginManifest}
              onChange={(e) => setPluginManifest(e.target.value)}
              rows={10}
              className="w-full rounded-lg bg-surface px-3 py-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground outline-none resize-y"
              placeholder={`{
  "version": 1,
  "slug": "my-agent",
  "displayName": "My Agent",
  "aliases": ["my-agent"],
  "accentColor": "#4385BE",
  "hooks": {
    "target": "~/.my-agent/settings.json",
    "events": [
      { "hook": "SessionStart", "event": "session-start" },
      { "hook": "UserPromptSubmit", "event": "prompt-submit" }
    ]
  }
}`}
            />
            {pluginError && (
              <div className="text-[10px] text-[color:var(--warning)]">{pluginError}</div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleCreatePlugin()}
                className="flex items-center gap-1 rounded-full bg-[rgb(var(--success-rgb)_/_0.14)] px-3 py-1 text-[11px] font-medium text-[color:var(--success)] hover:bg-[rgb(var(--success-rgb)_/_0.22)] transition"
              >
                <RiCodeLine size={11} />
                {t('settings.agentPluginCreate')}
              </button>
              <button
                type="button"
                onClick={() => { setShowPluginEditor(false); setPluginManifest(''); setPluginError(null); }}
                className="rounded-full px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground transition"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AgentHooksSettings;
