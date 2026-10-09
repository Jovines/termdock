// @vitest-environment jsdom
import { useEffect } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationWorkspaceFrame } from './CollaborationWorkspaceFrame';
afterEach(cleanup);
it('keeps the same terminal mounted and prevents hidden input while the workspace is active', () => {
  const mount = vi.fn(), unmount = vi.fn();
  function Terminal() { useEffect(() => { mount(); return unmount; }, []); return <input aria-label="终端输入" defaultValue="未发送的命令" />; }
  const view = render(<CollaborationWorkspaceFrame workspace={null}><Terminal /></CollaborationWorkspaceFrame>);
  const terminal = screen.getByRole('textbox');
  view.rerender(<CollaborationWorkspaceFrame workspace={<section>任务看板</section>}><Terminal /></CollaborationWorkspaceFrame>);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(terminal.parentElement!.inert).toBe(true);
  expect(terminal.parentElement!.style.visibility).toBe('hidden');
  expect(mount).toHaveBeenCalledOnce(); expect(unmount).not.toHaveBeenCalled();
  view.rerender(<CollaborationWorkspaceFrame workspace={null}><Terminal /></CollaborationWorkspaceFrame>);
  expect(screen.getByRole('textbox')).toBe(terminal);
  expect(terminal.parentElement!.inert).toBe(false);
  expect((terminal as HTMLInputElement).value).toBe('未发送的命令');
  expect(mount).toHaveBeenCalledOnce(); expect(unmount).not.toHaveBeenCalled();
});

it('reserves the pinned file sidebar width without unmounting the workspace or its draft', () => {
  const workspace = <textarea aria-label="协作草稿" defaultValue="保留补充说明" />;
  const view = render(<CollaborationWorkspaceFrame workspace={workspace}><span>终端</span></CollaborationWorkspaceFrame>);
  const draft = screen.getByRole('textbox');
  view.rerender(<CollaborationWorkspaceFrame rightInset={325} workspace={workspace}><span>终端</span></CollaborationWorkspaceFrame>);
  expect(screen.getByRole('textbox')).toBe(draft);
  expect(document.querySelector<HTMLElement>('[data-collaboration-workspace-frame]')!.style.right).toBe('325px');
  view.rerender(<CollaborationWorkspaceFrame rightInset={0} workspace={workspace}><span>终端</span></CollaborationWorkspaceFrame>);
  expect(screen.getByRole('textbox')).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe('保留补充说明');
});
