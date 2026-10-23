// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { NewSessionComposer } from './sidebar/NewSessionComposer';
import { CollectorEditor, resolveTodoConfig } from './todos/TodoForms';
import { getAgentLaunchCommand, readAgentCommandPresets, saveAgentCommand } from '../terminal/launchCommands';
import { useTodoWorkspace } from '../todos/workspace';

const codex = { slug: 'codex', displayName: 'Codex', command: 'codex', accentColor: 'var(--primary)', icon: null };
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('termdock:locale', 'en');
  useTodoWorkspace.setState({ views: {}, snapshots: {}, options: {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en' }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function session(onLaunchAgent = vi.fn()) {
  return render(<I18nProvider><NewSessionComposer directories={[]} tmuxAvailable options={{ mode: 'tmux', cwd: '/workspace' }} agents={[codex]} selectedAgent={codex} detecting={false}
    resumeHistory={[]} resumeHistoryLoading={false} resumeHistoryPendingId={null} resumeHistoryError={null} onRefreshAgents={vi.fn()} onSelectAgent={vi.fn()} onLaunchAgent={onLaunchAgent}
    onResumeHistory={vi.fn()} onRemoveResumeHistory={vi.fn()} onClose={vi.fn()} onOptionsChange={vi.fn()} /></I18nProvider>);
}
function add(name: string, command: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Command preset' }), { target: { value: '__new__' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Preset name' }), { target: { value: name } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Startup command' }), { target: { value: command } });
  fireEvent.click(screen.getByRole('button', { name: 'Save command' }));
}
it('shares multiple named Agent commands between new sessions and Todo configuration, including after remount', () => {
  const launcher = session();
  add('Daily', 'codex --model daily'); add('Deep', 'codex --model deep');
  const presets = readAgentCommandPresets('codex', 'codex').presets;
  expect(presets.map(p => p.name)).toEqual(['Daily', 'Deep']);
  launcher.unmount();
  const config = resolveTodoConfig({ agentSlug: 'codex', command: '', cwd: '/workspace', prompt: '' }, [codex]);
  expect(config.command).toBe('codex --model deep');
  const collector = render(<I18nProvider><CollectorEditor workspace="sharing" config={config} agents={[codex]} loading={false} service="local" directories={[]} currentCwd="/workspace" busy={false} onSave={vi.fn()} onCancel={vi.fn()} /></I18nProvider>);
  fireEvent.change(screen.getByRole('combobox', { name: 'Command preset' }), { target: { value: presets[0].id } });
  expect(getAgentLaunchCommand('codex', 'codex')).toBe('codex --model daily');
  collector.unmount();
  const launch = vi.fn(); session(launch);
  fireEvent.click(screen.getByRole('button', { name: 'Start Codex' }));
  expect(launch).toHaveBeenCalledWith(codex, 'codex --model daily');
  expect(readAgentCommandPresets('codex', 'codex').presets).toHaveLength(2);
});
it('keeps an existing Todo command and unsaved command drafts separate from the shared selection', () => {
  saveAgentCommand('codex', 'codex', { name: 'Shared', command: 'codex --model shared' });
  expect(resolveTodoConfig({ agentSlug: 'codex', command: 'codex --model scheduled', cwd: '/workspace', prompt: '' }, [codex]).command).toBe('codex --model scheduled');
  const view = session();
  fireEvent.change(screen.getByRole('combobox', { name: 'Command preset' }), { target: { value: '__new__' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Startup command' }), { target: { value: 'codex --draft' } });
  view.unmount();
  expect(getAgentLaunchCommand('codex', 'codex')).toBe('codex --model shared');
  session();
  const preset = screen.getByRole('combobox', { name: 'Command preset' }) as HTMLSelectElement;
  expect(preset.selectedOptions[0].textContent).toBe('Shared');
});
it('cancels only the command editor with Escape and restores the unchanged parent selection', () => {
  const shared = saveAgentCommand('codex', 'codex', { name: 'Shared', command: 'codex --model shared' });
  session();
  fireEvent.change(screen.getByRole('combobox', { name: 'Command preset' }), { target: { value: '__new__' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Startup command' }), { target: { value: 'codex --discard' } });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('region', { name: 'Start a session' })).toBeTruthy();
  expect((screen.getByRole('combobox', { name: 'Command preset' }) as HTMLSelectElement).value).toBe(shared.id);
  expect(getAgentLaunchCommand('codex', 'codex')).toBe(shared.command);
});
