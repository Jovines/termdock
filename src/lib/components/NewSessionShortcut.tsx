import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { isKeyboardLayerOpen, useKeyboardLayer } from '../hooks/useKeyboardLayer';
import { getAgentLaunchers, getSettings, updateSettings, type AgentLauncherInfo } from '../terminal/api';
import { getAgentLaunchCommand } from '../terminal/launchCommands';
import { useAppFeedback } from './ui/AppFeedback';

type Action = 'agent' | 'terminal' | null;

export function isNewSessionShortcut(event: KeyboardEvent): boolean {
  // Ctrl+D is shell EOF. Claim only the macOS workspace shortcut.
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'd'
    || event.repeat || event.defaultPrevented || event.isComposing || event.keyCode === 229 || isKeyboardLayerOpen()) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('[data-session-chat] .session-chat-rich-editor')) return true;
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) {
    return !!target.matches('textarea[data-terminal-input-anchor], textarea.xterm-helper-textarea')
      && !!target.closest('.terminal-viewport-container');
  }
  return target === document.body || !!target?.closest('.terminal-viewport-container, [data-session-chat]');
}

export function NewSessionShortcut({ onCreate, disabled, configureOpen, onConfigureClose }: {
  onCreate: (options: { command?: string }) => void;
  disabled: boolean;
  configureOpen: boolean;
  onConfigureClose: () => void;
}) {
  const { locale, t } = useI18n();
  const zh = locale === 'zh';
  const [dialog, setDialog] = useState<'launch' | 'settings' | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [agents, setAgents] = useState<AgentLauncherInfo[]>([]);
  const [agentSlug, setAgentSlug] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const close = () => { if (saving) return; generation.current++; busy.current = false; setLoading(false); setDialog(null); setError(null); onConfigureClose(); };
  useKeyboardLayer(panel, !!dialog, close);
  useAppFeedback(!dialog && error ? { message: error } : loading && !dialog ? { tone: 'recovering', message: zh ? '正在读取新建会话设置…' : 'Loading new session preferences…' } : null);

  const open = async (configure: boolean) => {
    if (busy.current || (!configure && disabled)) return;
    busy.current = true;
    const epoch = ++generation.current;
    setError(null); setLoading(true);
    if (configure) setDialog('settings');
    try {
      const settings = await getSettings();
      if (generation.current !== epoch) return;
      if (!configure && settings.newSessionShortcutAction === 'terminal') { onCreate({}); return; }
      const detected = await getAgentLaunchers();
      if (generation.current !== epoch) return;
      const agent = detected.find(item => item.slug === settings.newSessionAgentSlug);
      if (!configure && settings.newSessionShortcutAction === 'agent' && agent) {
        onCreate({ command: getAgentLaunchCommand(agent.slug, agent.command) }); return;
      }
      setAgents(detected);
      setAgentSlug(agent?.slug ?? detected[0]?.slug ?? '');
      setAction(settings.newSessionShortcutAction ?? null);
      setDialog(configure ? 'settings' : 'launch');
    } catch {
      if (generation.current !== epoch) return;
      setError(zh ? '无法读取新建会话设置，请重试' : 'Could not load new session preferences. Please retry.');
    } finally { if (generation.current === epoch) { busy.current = false; setLoading(false); } }
  };
  const openRef = useRef(open); openRef.current = open;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (disabled || !isNewSessionShortcut(event)) return;
      event.preventDefault(); event.stopPropagation();
      void openRef.current(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [disabled]);
  useEffect(() => { if (configureOpen) void openRef.current(true); }, [configureOpen]);
  useEffect(() => () => { generation.current++; }, []);

  const save = async () => {
    if (busy.current || (dialog === 'launch' && !action)) return;
    const agent = agents.find(item => item.slug === agentSlug);
    if (action === 'agent' && !agent) return;
    busy.current = true; setSaving(true); setError(null);
    try {
      await updateSettings({ newSessionShortcutAction: action, ...(action === 'agent' ? { newSessionAgentSlug: agent!.slug } : {}) });
      window.dispatchEvent(new Event('termdock:new-session-preference-changed'));
      if (dialog === 'launch') onCreate(action === 'agent' ? { command: getAgentLaunchCommand(agent!.slug, agent!.command) } : {});
      setDialog(null); onConfigureClose();
    } catch { setError(zh ? '设置未保存，请检查连接后重试' : 'Preferences were not saved. Check your connection and retry.'); }
    finally { busy.current = false; setSaving(false); }
  };
  if (!dialog) return null;
  const unavailable = loading || saving;
  return createPortal(<div className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-[var(--app-backdrop)] p-4" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="new-session-shortcut-title" aria-busy={unavailable} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-5 text-foreground shadow-xl">
      <h2 id="new-session-shortcut-title" className="text-base font-semibold">{zh ? 'Command+D 新建会话' : 'Command+D new session'}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{zh ? '在终端或对话模式中，按 Command+D 新建会话。选择后会记住，下次直接创建。' : 'Press Command+D in terminal or chat mode to create a session. Your choice is remembered for next time.'}</p>
      {loading ? <p role="status" className="py-5 text-sm">{t('common.loading')}</p> : <fieldset disabled={unavailable} className="my-4 space-y-2">
        <legend className="sr-only">{zh ? '新建会话类型' : 'New session type'}</legend>
        {(['agent', 'terminal', ...(dialog === 'settings' ? [null] : [])] as Action[]).map(choice => <label key={choice ?? 'ask'} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
          <input type="radio" name="new-session-shortcut-action" checked={action === choice} onChange={() => setAction(choice)} />
          {choice === 'agent' ? (zh ? '默认 Agent' : 'Default Agent') : choice === 'terminal' ? (zh ? '空终端' : 'Empty terminal') : (zh ? '首次使用时询问' : 'Ask on next use')}
        </label>)}
        {action === 'agent' && <label className="block pt-2 text-xs text-muted-foreground">{zh ? '默认 Agent（与侧栏新建共用）' : 'Default Agent (shared with the sidebar)'}
          <select aria-label={zh ? '默认 Agent' : 'Default Agent'} value={agentSlug} onChange={event => setAgentSlug(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-foreground">
            {!agents.length && <option value="">{zh ? '未检测到可用 Agent' : 'No available Agent detected'}</option>}
            {agents.map(agent => <option key={agent.slug} value={agent.slug}>{agent.displayName}</option>)}
          </select>
        </label>}
      </fieldset>}
      <p className="text-xs leading-5 text-muted-foreground">{zh ? '可在「设置 → Command+D 新建会话」修改。沿用当前目录及默认 Shell/tmux 模式。' : 'Change this in Settings → Command+D new session. Uses the current directory and default Shell/tmux mode.'}</p>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" disabled={saving} onClick={close} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-2 disabled:opacity-50">{t('common.cancel')}</button>
        {error && !agents.length && <button type="button" disabled={unavailable} onClick={() => void open(dialog === 'settings')} className="min-h-11 rounded-lg px-3 text-sm text-primary">{t('common.retry')}</button>}
        <button type="button" disabled={unavailable || (dialog === 'launch' && !action) || (action === 'agent' && !agents.some(agent => agent.slug === agentSlug))} onClick={() => void save()} className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{saving ? t('common.loading') : dialog === 'launch' ? (zh ? '记住并新建' : 'Remember and create') : t('common.save')}</button>
      </div>
    </div>
  </div>, document.body);
}
