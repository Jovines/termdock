// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TodoMoreMenu } from './TodoMoreMenu';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('keeps a bottom-row menu within the viewport and executes a portaled item once', () => {
  vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'menu' ? { width: 224, height: 120 } as DOMRect : { top: 776, bottom: 820, right: 380 } as DOMRect;
  });
  const action = vi.fn();
  const view = render(<div style={{ overflow: 'hidden' }}><TodoMoreMenu items={[{ label: '忽略此项', action }]} /></div>);
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  const menu = screen.getByRole('menu');
  expect(view.container.contains(menu)).toBe(false);
  expect(parseFloat(menu.style.top)).toBe(650); expect(parseFloat(menu.style.left)).toBe(150);
  const item = screen.getByRole('menuitem', { name: '忽略此项' });
  fireEvent.pointerDown(item); fireEvent.click(item);
  expect(action).toHaveBeenCalledOnce(); expect(screen.queryByRole('menu')).toBeNull();
});
it('closes a row menu when its containing list scrolls', () => {
  const view = render(<TodoMoreMenu items={[{ label: '忽略此项', action: vi.fn() }]} />);
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  fireEvent.scroll(view.container);
  expect(screen.queryByRole('menu')).toBeNull();
});
