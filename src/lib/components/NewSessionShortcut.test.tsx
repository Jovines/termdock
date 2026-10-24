// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewSessionShortcut } from './NewSessionShortcut';
import { getSettings, getAgentLaunchers, updateSettings } from '../terminal/api';
vi.mock('../terminal/api', () => ({ getSettings: vi.fn(), getAgentLaunchers: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../i18n', () => ({ useI18n: () => ({ locale: 'zh', t: (key: string) => ({ 'common.cancel': '取消', 'common.save': '保存', 'common.loading': '加载中', 'common.retry': '重试' }[key] ?? key) }) }));
vi.mock('./ui/AppFeedback', () => ({ useAppFeedback: vi.fn() }));
const agent = { slug: 'codex', command: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null };
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  vi.mocked(getSettings).mockResolvedValue({ newSessionShortcutAction: null, newSessionAgentSlug: 'codex' } as Awaited<ReturnType<typeof getSettings>>);
  vi.mocked(getAgentLaunchers).mockResolvedValue([agent]);
  vi.mocked(updateSettings).mockResolvedValue({} as Awaited<ReturnType<typeof updateSettings>>);
});
afterEach(cleanup);
function mount(configureOpen = false) {
  const create = vi.fn(), close = vi.fn();
  render(<><div className="terminal-viewport-container"><textarea aria-label="终端" className="xterm-helper-textarea" /></div><section data-session-chat onKeyDown={e => e.stopPropagation()}><div className="session-chat-rich-editor" role="textbox" contentEditable suppressContentEditableWarning>保留草稿</div></section><input aria-label="其他输入" /><NewSessionShortcut onCreate={create} disabled={false} configureOpen={configureOpen} onConfigureClose={close} /></>);
  return { create, close };
}
function shortcut(target = screen.getByLabelText('终端'), options = {}) { fireEvent.keyDown(target, { key: 'd', metaKey: true, ...options }); }
it('asks on first use, cancels without saving or creating, then remembers empty terminal', async () => {
  const { create } = mount(); shortcut();
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByLabelText('空终端'));
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(create).not.toHaveBeenCalled(); expect(updateSettings).not.toHaveBeenCalled();
  shortcut(); await screen.findByRole('dialog');
  fireEvent.click(screen.getByLabelText('空终端')); fireEvent.click(screen.getByText('记住并新建'));
  await waitFor(() => expect(create).toHaveBeenCalledWith({}));
  expect(updateSettings).toHaveBeenCalledWith({ newSessionShortcutAction: 'terminal' });
});
it('claims Command+D from the chat editor before chat stops propagation, preserving its draft', async () => {
  const { create } = mount(); const editor = screen.getByRole('textbox', { name: '' });
  shortcut(editor); await screen.findByRole('dialog');
  fireEvent.click(screen.getByLabelText('默认 Agent', { selector: 'input' }));
  fireEvent.click(screen.getByText('记住并新建'));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ command: 'codex' }));
  expect(editor.textContent).toBe('保留草稿');
  expect(updateSettings).toHaveBeenCalledWith({ newSessionShortcutAction: 'agent', newSessionAgentSlug: 'codex' });
});
it.each(['terminal', 'agent'] as const)('uses the saved %s choice directly', async action => {
  vi.mocked(getSettings).mockResolvedValue({ newSessionShortcutAction: action, newSessionAgentSlug: 'codex' } as Awaited<ReturnType<typeof getSettings>>);
  const { create } = mount(); shortcut();
  await waitFor(() => expect(create).toHaveBeenCalledWith(action === 'agent' ? { command: 'codex' } : {}));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(updateSettings).not.toHaveBeenCalled();
});
it('keeps Ctrl+D, IME, repeat, modified keys and other form fields untouched', () => {
  mount(); shortcut(undefined, { metaKey: false, ctrlKey: true }); shortcut(undefined, { isComposing: true });
  shortcut(undefined, { repeat: true }); shortcut(undefined, { shiftKey: true }); shortcut(screen.getByLabelText('其他输入'));
  expect(getSettings).not.toHaveBeenCalled();
});
it('does not create when preference loading or saving fails; save can be retried', async () => {
  const { create } = mount(); shortcut(); await screen.findByRole('dialog');
  vi.mocked(updateSettings).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByLabelText('空终端')); fireEvent.click(screen.getByText('记住并新建'));
  await screen.findByRole('alert'); expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('记住并新建')); await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
});
it('offers configuration for a missing default Agent instead of silently creating a terminal', async () => {
  vi.mocked(getSettings).mockResolvedValue({ newSessionShortcutAction: 'agent', newSessionAgentSlug: 'missing' } as Awaited<ReturnType<typeof getSettings>>);
  const { create } = mount(); shortcut(); await screen.findByRole('dialog'); expect(create).not.toHaveBeenCalled();
});
it('saves settings without launching and can restore the first-use prompt', async () => {
  const { create, close } = mount(true); await screen.findByLabelText('首次使用时询问');
  fireEvent.click(screen.getByLabelText('首次使用时询问')); fireEvent.click(screen.getByText('保存'));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(updateSettings).toHaveBeenCalledWith({ newSessionShortcutAction: null }); expect(create).not.toHaveBeenCalled();
});

it('discards delayed loading after cancelling configuration', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof getSettings>>) => void;
  vi.mocked(getSettings).mockReturnValue(new Promise(done => { resolve = done; }));
  const { create, close } = mount(true);
  await screen.findByRole('dialog');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(close).toHaveBeenCalled();
  resolve({ newSessionShortcutAction: 'terminal' } as Awaited<ReturnType<typeof getSettings>>);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(create).not.toHaveBeenCalled(); expect(getAgentLaunchers).not.toHaveBeenCalled();
});
it('does not launch when settings cannot be loaded and permits a later shortcut retry', async () => {
  vi.mocked(getSettings).mockRejectedValueOnce(new Error('offline'));
  const { create } = mount(); shortcut();
  await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(create).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull();
  shortcut(); await screen.findByRole('dialog');
});
