import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../index.css';
import { AgentOperationsPanel } from '../components/sidebar/AgentOperationsPanel';
import { SplitPaneTitle } from '../components/SplitPaneTitle';
import { getSessionDirectorySnapshot, useSessionDirectoryStore } from '../stores/useSessionDirectory';

const fixture = vi.hoisted(() => ({ grouped: false }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(),
  getSettings: async () => ({}), updateSettings: async () => ({}), getAgentLaunchers: async () => [],
  listAgentAutomations: async () => ({ automations: [], runs: [] }),
  listCollaborationTasks: async () => ({ tasks: [] }), listCollaborationMessages: async () => ({ messages: [] }),
  subscribeCollaborationGroups: () => () => {},
  listCollaborationGroups: async () => ({
    groups: fixture.grouped ? [{ id: 'title-team', name: '标题检查', sessionIds: ['browser-title'], createdAt: 1, updatedAt: 1 }] : [],
    sessions: [{ sessionId: 'browser-title', name: 'web-terminal', displayName: '过期的快照标题', cwd: '/repo/web-terminal', status: 'ready', agent: null, backendSessionId: null, capability: '', currentTask: '', updatedAt: 1 }],
  }),
}));

let root: Root | undefined;
afterEach(() => { root?.unmount(); root = undefined; document.body.replaceChildren(); localStorage.clear(); useSessionDirectoryStore.getState().replace([]); fixture.grouped = false; });

it.each([{ width: 320, height: 720 }, { width: 1440, height: 960 }])('keeps picker, pane and recipient titles on the same live directory at $width px', async viewport => {
  await page.viewport(viewport.width, viewport.height);
  const record = { sessionId: 'browser-title', name: '改造 Android 应用并补齐标题', customName: true, lastActivity: 1, cwd: '/repo/web-terminal' };
  useSessionDirectoryStore.getState().replace([record]);
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const pane = createElement(SplitPaneTitle, { session: { id: record.sessionId, name: 'tmux:wt-private', customName: false, mode: 'tmux', tmuxSessionName: 'wt-private' }, active: true, onActivate() {} });
  root.render(createElement('div', null, pane, createElement(AgentOperationsPanel, { activeSessionId: record.sessionId, onClose() {}, onNewSession() {} })));
  await page.getByText(/复用已有会话（选填）/).click();
  const title = getSessionDirectorySnapshot()[0].displayName;
  await expect.element(page.getByRole('checkbox', { name: new RegExp(title) })).toBeVisible();
  await page.getByRole('checkbox', { name: new RegExp(title) }).click();
  await page.getByPlaceholder('例如：发布准备').fill('保留创建草稿');
  useSessionDirectoryStore.getState().replace([{ ...record, name: '更新后的完整会话标题' }]);
  await expect.element(page.getByRole('checkbox', { name: /更新后的完整会话标题/ })).toBeChecked();
  await expect.element(page.getByPlaceholder('例如：发布准备')).toHaveValue('保留创建草稿');
  expect(host.querySelector('[data-split-pane-title]')?.textContent).toContain(getSessionDirectorySnapshot()[0].displayName);

  root.unmount(); root = createRoot(host); fixture.grouped = true;
  root.render(createElement(AgentOperationsPanel, { initialCollaborationGroupId: 'title-team', activeSessionId: record.sessionId, onClose() {}, onNewSession() {} }));
  await page.getByRole('button', { name: '成员与消息' }).click();
  await expect.element(page.getByRole('group', { name: '接收人（可多选）' }).getByRole('button', { name: '更新后的完整会话标题', exact: true })).toBeVisible();
  await expect.element(page.getByText('过期的快照标题', { exact: true })).not.toBeInTheDocument();
});
