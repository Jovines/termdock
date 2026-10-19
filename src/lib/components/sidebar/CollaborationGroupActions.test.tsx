// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationGroupActions } from './CollaborationGroupActions';

const api = vi.hoisted(() => ({ remove: vi.fn(), save: vi.fn(), archive: vi.fn() }));
vi.mock('../../terminal/api', () => ({ removeCollaborationGroup: api.remove, saveCollaborationGroup: api.save, setCollaborationGroupArchived: api.archive }));
const group = { id: 'team', name: '出卡策略检验', sessionIds: ['visible', 'remote-unavailable'], createdAt: 1, updatedAt: 7 };
function setup(options: Partial<React.ComponentProps<typeof CollaborationGroupActions>> = {}) {
  const callbacks = { onOpen: vi.fn(), onMessages: vi.fn(), onToggleCollapsed: vi.fn(), onChanged: vi.fn() };
  const result = render(<CollaborationGroupActions group={group} collapsed={false} {...callbacks} {...options}><button>组标题</button></CollaborationGroupActions>);
  return { ...result, ...callbacks };
}
function open() { fireEvent.contextMenu(screen.getByRole('button', { name: '组标题' }), { clientX: 900, clientY: 600 }); }
beforeEach(() => { vi.clearAllMocks(); api.remove.mockResolvedValue(undefined); api.save.mockResolvedValue({ group: { ...group, name: '新名称', updatedAt: 8 } }); api.archive.mockResolvedValue({ ...group, archivedAt: 8, updatedAt: 8 }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('opens from right-click without opening the board and supports keyboard navigation and Escape', async () => {
  const callbacks = setup(); open();
  expect(callbacks.onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole('menu', { name: `协作组操作：${group.name}` })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '打开看板' }));
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '删除协作组' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: `协作组操作：${group.name}` })));
  fireEvent.keyDown(screen.getByRole('button', { name: '组标题' }), { key: 'F10', shiftKey: true });
  expect(screen.getByRole('menu')).toBeTruthy();
});
it('opens by the touch button, routes common actions and dismisses outside clicks', () => {
  const callbacks = setup({ collapsed: true });
  fireEvent.click(screen.getByRole('button', { name: `协作组操作：${group.name}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: '展开成员会话' }));
  expect(callbacks.onToggleCollapsed).toHaveBeenCalledOnce();
  open(); fireEvent.click(screen.getByRole('menuitem', { name: '成员与消息' }));
  expect(callbacks.onMessages).toHaveBeenCalledOnce();
  open(); fireEvent.pointerDown(document.body); expect(screen.queryByRole('menu')).toBeNull();
  open(); fireEvent.click(screen.getByRole('menuitem', { name: '打开看板' }));
  expect(callbacks.onOpen).toHaveBeenCalledOnce();
});
it('supports touch long-press without triggering the header click and cancels on movement', () => {
  vi.useFakeTimers();
  class TouchPointer extends MouseEvent { pointerType = 'touch'; pointerId = 1; }
  vi.stubGlobal('PointerEvent', TouchPointer);
  const { container } = setup();
  const root = container.firstElementChild!;
  fireEvent.pointerDown(root, { clientX: 20, clientY: 20 });
  fireEvent.pointerMove(root, { clientX: 50, clientY: 20 });
  act(() => vi.advanceTimersByTime(600)); expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.pointerDown(root, { clientX: 20, clientY: 20 });
  act(() => vi.advanceTimersByTime(600)); expect(screen.getByRole('menu')).toBeTruthy();
  fireEvent.pointerUp(root); fireEvent.click(screen.getByRole('button', { name: '组标题' }));
  expect(screen.getByRole('menu')).toBeTruthy();
});
it('requires confirmation, describes terminal retention and treats Escape and backdrop as cancellation', () => {
  setup({ group: { ...group, sessionIds: [], federated: true } });
  open(); fireEvent.click(screen.getByRole('menuitem', { name: '删除协作组' }));
  expect(screen.getByRole('dialog').textContent).toContain('成员终端会保留');
  expect(screen.getByRole('dialog').textContent).toContain('删除会同步到其他服务');
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
  open(); fireEvent.click(screen.getByRole('menuitem', { name: '删除协作组' }));
  fireEvent.click(document.querySelector('.z-modal-backdrop')!); expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.remove).not.toHaveBeenCalled();
});
it('blocks duplicate deletion, retains the original revision after refresh and calls back only on success', async () => {
  let resolve!: () => void; api.remove.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  const { rerender, onChanged, onOpen, onMessages, onToggleCollapsed } = setup();
  open(); fireEvent.click(screen.getByRole('menuitem', { name: '删除协作组' }));
  rerender(<CollaborationGroupActions group={{ ...group, updatedAt: 9 }} collapsed={false} onChanged={onChanged} onOpen={onOpen} onMessages={onMessages} onToggleCollapsed={onToggleCollapsed}><button>组标题</button></CollaborationGroupActions>);
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  expect(api.remove).toHaveBeenCalledOnce(); expect(api.remove).toHaveBeenCalledWith('team', 7);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); expect(screen.getByRole('dialog')).toBeTruthy();
  expect(onChanged).not.toHaveBeenCalled();
  await act(async () => resolve());
  expect(onChanged).toHaveBeenCalledWith(null); expect(screen.queryByRole('dialog')).toBeNull();
});
it('keeps a failed deletion visible and allows cancellation or retry without silently accepting a new revision', async () => {
  api.remove.mockRejectedValueOnce(Error('协作组已变化，请刷新后重新操作')).mockResolvedValueOnce(undefined);
  const { onChanged } = setup(); open(); fireEvent.click(screen.getByRole('menuitem', { name: '删除协作组' }));
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '协作组刚刚发生变化，请取消后重新打开操作。');
  expect(onChanged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(null));
  expect(api.remove.mock.calls).toEqual([['team', 7], ['team', 7]]);
});
it('renames with all original member IDs, rejects blank input and retains the draft on failure', async () => {
  api.save.mockRejectedValueOnce(Error('网络断开')).mockResolvedValueOnce({ group: { ...group, name: '新名称', updatedAt: 8 } });
  const { onChanged } = setup(); open(); fireEvent.click(screen.getByRole('menuitem', { name: '重命名协作组' }));
  const input = screen.getByRole('textbox', { name: '协作组名称' });
  fireEvent.change(input, { target: { value: ' ' } }); expect(screen.getByRole('button', { name: '保存名称' })).toHaveProperty('disabled', true);
  fireEvent.change(input, { target: { value: '新名称' } }); fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  await screen.findByRole('alert'); expect(input).toHaveProperty('value', '新名称'); expect(onChanged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ name: '新名称' })));
  expect(api.save.mock.calls[0][0]).toEqual({ id: 'team', name: '新名称', sessionIds: group.sessionIds, expectedUpdatedAt: 7 });
});
it('confirms reversible archive and restore operations and updates the group without deleting it', async () => {
  const { onChanged } = setup();
  open(); fireEvent.click(screen.getByRole('menuitem', { name: '归档协作组' }));
  expect(screen.getByRole('dialog').textContent).toContain('消息和历史都会保留');
  expect(api.archive).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '归档并隐藏' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ archivedAt: 8 })));
  expect(api.archive).toHaveBeenCalledWith(group, true);

  cleanup(); setup({ group: { ...group, archivedAt: 8 } }); open(); fireEvent.click(screen.getByRole('menuitem', { name: '恢复显示' }));
  fireEvent.click(screen.getByRole('button', { name: '恢复显示' }));
  await waitFor(() => expect(api.archive).toHaveBeenLastCalledWith(expect.objectContaining({ archivedAt: 8 }), false));
});
