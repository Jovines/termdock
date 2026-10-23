// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ChatMessageViewport } from './ChatMessageViewport';
let notify: (entries: { target: Element; isIntersecting: boolean }[]) => void;
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
function setup(preserve = false) {
  const container = document.createElement('div'); document.body.append(container);
  Object.defineProperty(container, 'clientHeight', { value: 600 });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof notify, options: IntersectionObserverInit) { notify = callback; expect(options.root).toBe(container); expect(options.rootMargin).toBe('600px 0px'); }
    observe() {} disconnect() {}
  });
  const nearby = new Set<string>();
  const view = render(<ChatMessageViewport id="one" root={{ current: container }} estimate={240} eager={false} preserve={preserve} nearby={nearby}><p>需要排版的正文</p><textarea aria-label="填写内容" /></ChatMessageViewport>, { container });
  const row = container.querySelector('[data-chat-viewport-row]')!;
  const intersect = (isIntersecting: boolean) => act(() => notify([{ target: row, isIntersecting }]));
  return { ...view, row, intersect, nearby };
}
it('renders prose only near the viewport and keeps a height placeholder when it leaves', () => {
  const { row, intersect, nearby } = setup();
  expect(screen.queryByText('需要排版的正文')).toBeNull(); expect((row as HTMLElement).style.height).toBe('240px');
  intersect(true); expect(screen.getByText('需要排版的正文')).toBeTruthy(); expect(nearby.has('one')).toBe(true);
  intersect(false); expect(screen.queryByText('需要排版的正文')).toBeNull(); expect(nearby.has('one')).toBe(false); expect((row as HTMLElement).style.height).toBe('240px');
});
it('keeps an interactive reply and its local input mounted outside the viewport', () => {
  const { intersect } = setup(true); intersect(true);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement; input.value = '尚未保存的填写';
  intersect(false); expect(screen.getByRole('textbox')).toBe(input); expect(input.value).toBe('尚未保存的填写');
});
it('does not unmount a focused editor while its row is outside overscan', () => {
  const { intersect } = setup(); intersect(true);
  const input = screen.getByRole('textbox'); input.focus(); intersect(false);
  expect(screen.getByRole('textbox')).toBe(input);
});
