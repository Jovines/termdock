import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../index.css';
import { NewSessionShortcut } from './NewSessionShortcut';
import { getSettings, getAgentLaunchers, updateSettings } from '../terminal/api';

vi.mock('../terminal/api', () => ({ getSettings: vi.fn(), getAgentLaunchers: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../i18n', () => ({ useI18n: () => ({ locale: 'zh', t: (key: string) => ({ 'common.cancel': '取消', 'common.save': '保存', 'common.loading': '加载中', 'common.retry': '重试' }[key] ?? key) }) }));
vi.mock('./ui/AppFeedback', () => ({ useAppFeedback: vi.fn() }));
let root: Root | undefined;
afterEach(() => { root?.unmount(); root = undefined; document.body.replaceChildren(); vi.resetAllMocks(); });

it.each([390, 1280])('keeps first-use and settings actions visible and keyboard accessible at width %i', async width => {
  await page.viewport(width, 844);
  let choice: 'terminal' | 'agent' | null = null;
  vi.mocked(getSettings).mockImplementation(async () => ({ newSessionShortcutAction: choice, newSessionAgentSlug: 'codex' }) as Awaited<ReturnType<typeof getSettings>>);
  vi.mocked(getAgentLaunchers).mockResolvedValue([{ slug: 'codex', displayName: 'Codex', command: 'codex', accentColor: 'var(--primary)', icon: null }]);
  vi.mocked(updateSettings).mockImplementation(async settings => { choice = settings.newSessionShortcutAction ?? null; return {} as Awaited<ReturnType<typeof updateSettings>>; });
  const create = vi.fn();
  function Harness() {
    const [configure, setConfigure] = useState(false);
    return <><div className="terminal-viewport-container"><textarea aria-label="终端输入" className="xterm-helper-textarea" /></div><section data-session-chat onKeyDown={event => event.stopPropagation()}><div role="textbox" aria-label="对话输入" className="session-chat-rich-editor" contentEditable suppressContentEditableWarning>草稿</div></section><button onClick={() => setConfigure(true)}>配置快捷键</button><NewSessionShortcut onCreate={create} disabled={false} configureOpen={configure} onConfigureClose={() => setConfigure(false)} /></>;
  }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host); root.render(<Harness />);
  await page.getByRole('textbox', { name: '对话输入' }).click();
  await userEvent.keyboard('{Meta>}d{/Meta}');
  await expect.element(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('radio', { name: '默认 Agent', exact: true }).click();
  const bounds = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
  const primary = page.getByRole('button', { name: '记住并新建' });
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width);
  expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(844);
  await expect.element(primary).toBeVisible();
  await userEvent.keyboard('{Escape}');
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument(); expect(create).not.toHaveBeenCalled();
  await page.getByRole('textbox', { name: '终端输入' }).click(); await userEvent.keyboard('{Meta>}d{/Meta}');
  await page.getByRole('radio', { name: '空终端' }).click(); await primary.click();
  await expect.poll(() => create.mock.calls.length).toBe(1);
  await page.getByRole('textbox', { name: '对话输入' }).click(); await userEvent.keyboard('{Meta>}d{/Meta}');
  await expect.poll(() => create.mock.calls.length).toBe(2);
  await expect.element(page.getByRole('textbox', { name: '对话输入' })).toHaveTextContent('草稿');
  await page.getByRole('button', { name: '配置快捷键' }).click();
  await page.getByRole('radio', { name: '首次使用时询问' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => choice).toBeNull(); expect(create).toHaveBeenCalledTimes(2);
});
