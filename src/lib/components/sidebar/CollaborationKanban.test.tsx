// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollaborationKanban } from './CollaborationKanban';
import type { CollaborationTaskView } from '../../terminal/api';
const base: CollaborationTaskView = { id: 'goal', ownerServiceId: 'local', groupId: 'team', title: '当前任务', spec: '说明', constraints: '', acceptance: '', createdAt: 1, updatedAt: 2, revision: 1, coordinator: null, parentTaskId: null, dependsOn: [], status: 'open', activeAttemptId: 'attempt', attempts: [{ id: 'attempt', assignee: { serviceId: 'local', sessionId: 'worker' }, createdAt: 1, threadId: 'thread' }], events: [], decisions: [], artifacts: [], deliveries: [], outbox: [], memberSessions: {} };
const tasks = [base, { ...base, id: 'queued', title: '待分派任务', activeAttemptId: null, attempts: [] }, { ...base, id: 'done', title: '已验收任务', status: 'accepted' as const }];
beforeEach(() => {
 localStorage.clear();
 vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe() { this.callback([{ contentRect: { width: 360 } }] as ResizeObserverEntry[], this as unknown as ResizeObserver); } disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(records = tasks) { const settings = vi.fn(), select = vi.fn(); const view = render(<CollaborationKanban tasks={records} selectedId={null} onSelect={select} name={() => '成员'} storage="test-mobile" action={<button>新目标</button>} navigation={<nav aria-label="协作工作区"><button>看板</button><button>成员</button></nav>} settings={<button onClick={settings}>组设置</button>} />); return { ...view, settings, select }; }
describe('mobile kanban navigation', () => {
 it('returns from a hidden completed execution to its active goal’s lane', () => {
  const child = { ...base, id: 'child', parentTaskId: base.id, title: '已完成执行', status: 'accepted' as const };
  render(<CollaborationKanban tasks={[base, child]} selectedId="child" onSelect={vi.fn()} name={() => '成员'} storage="return-goal" />);
  expect(screen.getByRole('button', { name: /执行中\s*1/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: /当前任务/ })).toBeTruthy();
 });
 it('shows one user goal, with execution details available through an explicit filter', () => {
  const root = { ...base, status: 'accepted' as const };
  const child = { ...base, id: 'child', parentTaskId: root.id, title: '内部执行步骤', status: 'accepted' as const, completionMode: 'reviewed' as const };
  const { container, select } = setup([root, child]);
  expect(container.querySelectorAll('[data-task-id]')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /当前任务/ }).textContent).toContain('已完成 · 你已验收');
  fireEvent.click(screen.getByRole('button', { name: /当前任务/ })); expect(select).toHaveBeenCalledWith(root.id);
  fireEvent.click(screen.getByRole('button', { name: '更多看板操作' }));
  fireEvent.click(screen.getByRole('button', { name: '筛选任务' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '显示执行子任务' }));
  expect(container.querySelectorAll('[data-task-id]')).toHaveLength(2);
  expect(container.querySelector('[data-task-id="child"]')?.textContent).toContain('执行交付已评审');
 });
 it('routes a hidden execution exception through its goal card into the task that needs attention', () => {
  const child = { ...base, id: 'child', parentTaskId: base.id, title: '检查访问条件', automationIssue: '测试错误：执行目录不可用' };
  const { container, select } = setup([base, child]);
  expect(container.querySelectorAll('[data-task-id]')).toHaveLength(1);
  const card = screen.getByRole('button', { name: /当前任务.*来自执行任务：检查访问条件/ });
  expect(within(screen.getByRole('region', { name: '需要你任务' })).getByRole('button', { name: /当前任务/ })).toBe(card);
  expect(card.textContent).toContain('测试错误：执行目录不可用');
  fireEvent.click(card); expect(select).toHaveBeenCalledWith('child');
 });
 it('synchronizes a swipe with stage buttons and keeps inactive cards out of keyboard navigation', () => {
  const { container, select } = setup(); const rail = container.querySelector<HTMLElement>('[data-kanban-scroll]')!;
  Object.defineProperty(rail, 'clientWidth', { value: 360 });
  expect(screen.getByRole('region', { name: '执行中任务' })).toBeTruthy();
  rail.scrollLeft = 1080; fireEvent.scroll(rail);
  expect(screen.getByRole('button', { name: /已完成\s*1/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('region', { name: '已完成任务' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /当前任务/ })).toBeNull();
  expect(container.querySelector<HTMLElement>('[aria-label="执行中任务"]')?.inert).toBe(true);
  expect(select).not.toHaveBeenCalled();
  const scroll = vi.fn(); rail.scrollTo = scroll;
  fireEvent.click(screen.getByRole('button', { name: /待开始\s*1/ }));
  expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ left: 0 }));
  expect(JSON.parse(localStorage.getItem('test-mobile:board')!).lane).toBe('backlog');
 });
 it('keeps secondary controls in an explicit menu, restores focus and preserves applied filters', () => {
  setup(); expect(screen.queryByRole('button', { name: '搜索任务' })).toBeNull();
  const more = screen.getByRole('button', { name: '更多看板操作' }); fireEvent.click(more);
  fireEvent.click(screen.getByRole('button', { name: '搜索任务' }));
  const field = screen.getByRole('searchbox', { name: '搜索任务' });
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: '任务' } });
  fireEvent.keyDown(field, { key: 'Escape' }); expect((field as HTMLInputElement).value).toBe('');
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(screen.queryByRole('searchbox')).toBeNull();
  fireEvent.click(more); fireEvent.click(screen.getByRole('button', { name: '筛选任务' }));
  const checkbox = screen.getByRole('checkbox', { name: '含已关闭' }); fireEvent.click(checkbox);
  fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('combobox')).toBeNull();
  expect(document.activeElement).toBe(more);
  fireEvent.click(more); expect(screen.getByRole('button', { name: '筛选任务，1 项已启用' })).toBeTruthy();
 });
 it('keeps group settings reachable without invoking task selection', () => {
  const { settings, select } = setup(); fireEvent.click(screen.getByRole('button', { name: '更多看板操作' }));
  fireEvent.click(within(screen.getByLabelText('看板更多操作')).getByRole('button', { name: '组设置' }));
  expect(settings).toHaveBeenCalledOnce(); expect(select).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('看板更多操作')).toBeNull();
 });
});

it('surfaces unfinished execution first and opens a step directly without opening the goal', () => {
  const children = Array.from({ length: 5 }, (_, i) => ({ ...base, id: `step-${i}`, parentTaskId: base.id, title: i === 4 ? '统一集成并验证部署' : `已交付事项 ${i}`, status: i === 4 ? 'open' as const : 'accepted' as const, updatedAt: i + 10, completionMode: i === 4 ? undefined : 'reviewed' as const }));
  const { container, select } = setup([base, ...children]);
  expect(container.querySelectorAll('[data-task-id]')).toHaveLength(1);
  const preview = screen.getByRole('region', { name: '执行事项' });
  expect(within(preview).getByText('4/5 项已完成')).toBeTruthy();
  const rows = within(preview).getAllByRole('button').filter(row => !row.closest('details'));
  expect(rows[0].textContent).toContain('统一集成并验证部署');
  expect(rows[0].textContent).toContain('等待投递');
  expect(rows).toHaveLength(3);
  fireEvent.click(rows[0]);
  expect(select).toHaveBeenCalledExactlyOnceWith('step-4');
  expect(within(preview).getByText('展开其余 2 项')).toBeTruthy();
  expect(container.querySelector('button button')).toBeNull();
});
it('keeps available execution summaries visible when full child records are absent', () => {
  const root = { ...base, children: [{ id: 'missing', title: '等待完整执行报告', revision: 1, status: 'open' as const }, { id: 'closed', title: '已关闭步骤', revision: 1, status: 'closed' as const }] };
  const { select } = setup([root]);
  const preview = screen.getByRole('region', { name: '执行事项' });
  expect(within(preview).getByText('0/1 项已完成')).toBeTruthy();
  const row = within(preview).getByRole('button', { name: /等待完整执行报告/ });
  expect(row.textContent).toContain('等待报告');
  expect(screen.queryByText('已关闭步骤')).toBeNull();
  fireEvent.click(row); expect(select).toHaveBeenCalledExactlyOnceWith('missing');
});
