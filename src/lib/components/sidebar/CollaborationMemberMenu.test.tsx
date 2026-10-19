// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationMemberMenu } from './CollaborationMemberMenu';
afterEach(cleanup);
it('opens on right click and removes only when the menu action is selected', () => {
 const remove=vi.fn(),select=vi.fn();
 render(<CollaborationMemberMenu label="离线成员" disabled={false} onRemove={remove}><button onClick={select}>离线成员</button></CollaborationMemberMenu>);
 fireEvent.contextMenu(screen.getByText('离线成员'),{clientX:100,clientY:100});
 expect(screen.getByRole('menu')).toBeTruthy(); expect(remove).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('menuitem',{name:'从协作组移除'})); expect(remove).toHaveBeenCalledOnce(); expect(screen.queryByRole('menu')).toBeNull();
});
it('does not offer a menu for the all-members button or while busy', () => {
 const remove=vi.fn(); render(<CollaborationMemberMenu label="全组成员" disabled onRemove={remove}><button>全组成员</button></CollaborationMemberMenu>);
 fireEvent.contextMenu(screen.getByText('全组成员')); expect(screen.queryByRole('menu')).toBeNull(); expect(remove).not.toHaveBeenCalled();
});
it('supports keyboard context menu and Escape without removing the member', () => {
 const remove=vi.fn();render(<CollaborationMemberMenu label="成员" disabled={false} onRemove={remove}><button>成员</button></CollaborationMemberMenu>);
 fireEvent.keyDown(screen.getByText('成员'),{key:'F10',shiftKey:true}); expect(screen.getByRole('menu')).toBeTruthy();
 fireEvent.keyDown(window,{key:'Escape'}); expect(screen.queryByRole('menu')).toBeNull(); expect(remove).not.toHaveBeenCalled(); expect(document.activeElement).toBe(screen.getByText('成员'));
});
