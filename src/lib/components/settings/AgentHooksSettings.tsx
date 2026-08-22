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
  Clipboard as RiClipboardLine,
} from 'lucide-react';
import {
  getAgentHooks,
  installAgentHooks,
  uninstallAgentHooks,
  getAgentPlugins,
  createAgentPlugin,
  deleteAgentPlugin,
  getSettings,
  updateSettings,
  getTitleNamerCatalog,
  type AgentHookInfo,
  type AgentPluginInfo,
  type AgentPluginErrors,
  AgentPluginManifestError,
  type TitleNamerInfo,
} from '../../terminal/api';
import { AgentBrandAvatar } from '../AgentIndicators';
import { useI18n } from '../../i18n';
import { Switch } from '../ui/Switch';

const STATE_STYLE: Record<AgentHookInfo['state'], string> = {
  installed: 'text-[color:var(--success)]',
  outdated: 'text-[color:var(--warning)]',
  'needs-approval': 'text-[color:var(--warning)]',
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
  const [pluginLoadErrors, setPluginLoadErrors] = React.useState<AgentPluginErrors[]>([]);
  const [copiedMigrationSlug, setCopiedMigrationSlug] = React.useState<string | null>(null);
  const [autoRenameAgents, setAutoRenameAgents] = React.useState<Set<string>>(new Set());
  const [busyAutoRenameSlug, setBusyAutoRenameSlug] = React.useState<string | null>(null);
  const [autoRenameNamer, setAutoRenameNamer] = React.useState<string>('auto');
  const [autoRenameModels, setAutoRenameModels] = React.useState<Record<string, string>>({});
  const [titleNamers, setTitleNamers] = React.useState<TitleNamerInfo[] | null>(null);
  const [savingTitleChoice, setSavingTitleChoice] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setAgents(await getAgentHooks());
    } catch {
      setAgents([]);
    }
    try {
      const data = await getAgentPlugins();
      setPlugins(data.plugins ?? []);
      setPluginLoadErrors(data.errors ?? []);
    } catch {
      setPlugins([]);
      setPluginLoadErrors([]);
    }
    try {
      const settings = await getSettings();
      setAutoRenameAgents(new Set(settings.autoRenameAgents ?? []));
      setAutoRenameNamer(settings.autoRenameNamer ?? 'auto');
      setAutoRenameModels(settings.autoRenameModels ?? {});
    } catch {
      setAutoRenameAgents(new Set());
    }
    try {
      setTitleNamers(await getTitleNamerCatalog());
    } catch {
      setTitleNamers([]);
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
    if (state === 'needs-approval') return t('settings.agentHooksNeedsApproval');
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
      if (err instanceof AgentPluginManifestError && err.migration) {
        setPluginLoadErrors((current) => [
          {
            slug: typeof manifest.slug === 'string' ? manifest.slug : 'manifest.json',
            errors: err.message.split('\n'),
            code: err.code,
            migration: err.migration,
          },
          ...current.filter((item) => item.slug !== manifest.slug),
        ]);
        return;
      }
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

  const copyMigrationPrompt = async (migrationError: AgentPluginErrors) => {
    const text = migrationError.migration?.aiPrompt ?? migrationError.errors.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMigrationSlug(migrationError.slug);
      window.setTimeout(() => setCopiedMigrationSlug((slug) => slug === migrationError.slug ? null : slug), 1800);
    } catch {
      setPluginError(text);
    }
  };

  const toggleAutoRename = async (slug: string) => {
    if (busyAutoRenameSlug) return;
    const previous = autoRenameAgents;
    const next = new Set(previous);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    setAutoRenameAgents(next);
    setBusyAutoRenameSlug(slug);
    setError(null);
    try {
      const settings = await updateSettings({ autoRenameAgents: [...next] });
      setAutoRenameAgents(new Set(settings.autoRenameAgents ?? []));
    } catch (err) {
      setAutoRenameAgents(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAutoRenameSlug(null);
    }
  };

  const changeAutoRenameNamer = async (namer: string) => {
    const previous = autoRenameNamer;
    setAutoRenameNamer(namer);
    setSavingTitleChoice('namer');
    setError(null);
    try {
      const settings = await updateSettings({ autoRenameNamer: namer });
      setAutoRenameNamer(settings.autoRenameNamer ?? 'auto');
    } catch (err) {
      setAutoRenameNamer(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTitleChoice(null);
    }
  };

  const changeAutoRenameModel = async (slug: 'codex' | 'claude', model: string) => {
    const previous = autoRenameModels;
    const next = { ...previous };
    if (model) next[slug] = model;
    else delete next[slug];
    setAutoRenameModels(next);
    setSavingTitleChoice(slug);
    setError(null);
    try {
      const settings = await updateSettings({ autoRenameModels: next });
      setAutoRenameModels(settings.autoRenameModels ?? {});
    } catch (err) {
      setAutoRenameModels(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTitleChoice(null);
    }
  };

  const pluginSlugs = new Set(plugins.map((p) => p.slug));

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-surface-2 px-3 py-2.5">
        <div className="text-[12px] font-medium text-foreground">{t('settings.agentAutoRename')}</div>
        <p className="mt-1 text-[10px] text-muted-foreground">{t('settings.agentAutoRenameHint')}</p>
        <label className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground">{t('settings.agentAutoRenameNamer')}</span>
          <select
            value={autoRenameNamer}
            disabled={savingTitleChoice !== null}
            onChange={(event) => void changeAutoRenameNamer(event.target.value)}
            className="min-w-0 rounded-lg bg-surface px-2.5 py-1.5 text-[11px] text-foreground outline-none disabled:opacity-50"
          >
            <option value="auto">{t('settings.agentAutoRenameFollow')}</option>
            {titleNamers?.filter((namer) => namer.available).map((namer) => (
              <option key={namer.slug} value={namer.slug}>{namer.displayName}</option>
            ))}
          </select>
        </label>
        <div className="mt-2 space-y-1.5 border-t border-border/40 pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">{t('settings.agentAutoRenameModelsFromCli')}</span>
            <button
              type="button"
              onClick={async () => {
                setTitleNamers(null);
                try { setTitleNamers(await getTitleNamerCatalog(true)); }
                catch { setTitleNamers([]); }
              }}
              className="rounded p-1 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
              title={t('settings.agentAutoRenameRefreshModels')}
            >
              <RiRefreshLine size={11} className={titleNamers === null ? 'animate-spin' : ''} />
            </button>
          </div>
          {titleNamers?.filter((namer) => namer.available).map((namer) => {
            const recommendedModel = namer.models.find((model) => model.id === namer.recommendedModel);
            return (
              <label key={namer.slug} className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-muted-foreground">{namer.displayName}</span>
                <select
                  value={autoRenameModels[namer.slug] ?? ''}
                  disabled={savingTitleChoice !== null}
                  onChange={(event) => void changeAutoRenameModel(namer.slug, event.target.value)}
                  className="min-w-0 max-w-[68%] rounded-lg bg-surface px-2.5 py-1.5 text-[11px] text-foreground outline-none disabled:opacity-50"
                >
                  <option value="">{t('settings.agentAutoRenameAutomatic')}{recommendedModel ? ` · ${recommendedModel.displayName}` : ''}</option>
                  {namer.models.map((model) => (
                    <option key={model.id} value={model.id}>{model.displayName}</option>
                  ))}
                </select>
              </label>
            );
          })}
          {titleNamers?.length === 0 && (
            <div className="text-[10px] text-[color:var(--warning)]">{t('settings.agentAutoRenameNoCli')}</div>
          )}
        </div>
      </div>
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
                iconMode: agent.iconMode as 'mask' | 'native' | undefined,
                iconVersion: agent.iconVersion ?? undefined,
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
                  {(agent.state === 'outdated' || agent.state === 'needs-approval') && <RiAlertLine size={10} className="mr-0.5 inline" />}
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
              {agent.state === 'needs-approval' && (
                <div className="mt-0.5 text-[10px] text-[color:var(--warning)]">
                  {t('settings.agentHooksApprovalHint')}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={busyAutoRenameSlug !== null}
                onClick={() => void toggleAutoRename(agent.slug)}
                className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[10px] text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:opacity-50"
                aria-pressed={autoRenameAgents.has(agent.slug)}
                title={t('settings.agentAutoRenameToggle')}
              >
                <span>{t('settings.agentAutoRenameShort')}</span>
                <Switch checked={autoRenameAgents.has(agent.slug)} disabled={busyAutoRenameSlug !== null} size="sm" />
              </button>
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

        {pluginLoadErrors.map((pluginLoadError) => (
          <div
            key={pluginLoadError.slug}
            className="mt-2 rounded-lg bg-[rgb(var(--warning-rgb)_/_0.10)] px-3 py-2 text-[10px] text-[color:var(--warning)]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {pluginLoadError.slug}: {pluginLoadError.code ?? t('settings.agentPluginInvalid')}
              </span>
              <button
                type="button"
                onClick={() => void copyMigrationPrompt(pluginLoadError)}
                className="flex shrink-0 items-center gap-1 rounded-full bg-[rgb(var(--warning-rgb)_/_0.14)] px-2 py-1 font-medium transition hover:bg-[rgb(var(--warning-rgb)_/_0.22)]"
              >
                {copiedMigrationSlug === pluginLoadError.slug ? <RiCircleCheck size={10} /> : <RiClipboardLine size={10} />}
                {copiedMigrationSlug === pluginLoadError.slug
                  ? t('settings.agentPluginCopied')
                  : t('settings.agentPluginCopyAiPrompt')}
              </button>
            </div>
            <div className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
              {pluginLoadError.errors.join('\n')}
            </div>
            {pluginLoadError.migration?.guideCommand && (
              <code className="mt-1 block select-all text-foreground">{pluginLoadError.migration.guideCommand}</code>
            )}
          </div>
        ))}

        {showPluginEditor && (
          <div className="mt-2 space-y-2">
            <textarea
              value={pluginManifest}
              onChange={(e) => setPluginManifest(e.target.value)}
              rows={10}
              className="w-full rounded-lg bg-surface px-3 py-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground outline-none resize-y"
              placeholder={`{
  "version": 2,
  "slug": "my-agent",
  "displayName": "My Agent",
  "aliases": ["my-agent"],
  "accentColor": "#4385BE",
  "statuses": [
    { "id": "thinking", "phase": "working", "label": "Thinking", "indicator": "spinner", "tone": "info" },
    { "id": "approval", "phase": "waiting", "label": "Needs approval", "indicator": "question", "tone": "warning" },
    { "id": "complete", "phase": "done", "label": "Complete", "indicator": "badge", "tone": "success" }
  ],
  "hooks": {
    "target": "~/.my-agent/settings.json",
    "events": [
      { "hook": "UserPromptSubmit", "event": "prompt-submit", "status": "thinking" },
      { "hook": "PermissionRequest", "event": "permission-request", "status": "approval" },
      { "hook": "Stop", "event": "stop", "status": "complete" }
    ]
  }
}`}
            />
            {pluginError && (
              <div className="whitespace-pre-wrap break-words text-[10px] text-[color:var(--warning)]">{pluginError}</div>
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
