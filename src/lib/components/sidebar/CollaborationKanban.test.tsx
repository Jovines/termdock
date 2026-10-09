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
function setup() { const settings = vi.fn(), select = vi.fn(); const view = render(<CollaborationKanban tasks={tasks} selectedId={null} onSelect={select} name={() => '成员'} storage="test-mobile" action={<button>新目标</button>} navigation={<nav aria-label="协作工作区"><button>看板</button><button>成员</button></nav>} settings={<button onClick={settings}>组设置</button>} />); return { ...view, settings, select }; }
describe('mobile kanban navigation', () => {
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
