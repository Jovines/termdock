// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FreeSplitLayout } from './FreeSplitLayout';

vi.mock('../terminal/api', () => ({ getSettings: vi.fn().mockResolvedValue({}), updateSettings: vi.fn().mockResolvedValue({}) }));
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'mouse';
  }
}
beforeEach(() => { vi.stubGlobal('PointerEvent', TestPointerEvent); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function setup() {
  const view = render(<FreeSplitLayout layoutId="lifecycle" panes={['a', 'b', 'c', 'd'].map(id => ({ id, content: <button data-split-pane-title>{id}</button> }))} />);
  await waitFor(() => expect((screen.getAllByRole('separator')[0] as HTMLButtonElement).disabled).toBe(false));
  const host = view.container.querySelector<HTMLElement>('[data-split-container]')!;
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 800 } as DOMRect);
  return { host, view };
}

it('cancels a pane preview on a missing release and permits the next deliberate drag', async () => {
  const { host } = await setup();
  const start = () => fireEvent.pointerDown(screen.getByRole('button', { name: 'c' }), { buttons: 1, clientX: 100, clientY: 420 });
  start();
  fireEvent.pointerMove(host, { buttons: 1, clientX: 20, clientY: 180 });
  expect(host.querySelector('[data-drag-placeholder]')).not.toBeNull();
  fireEvent.pointerMove(host, { buttons: 0, clientX: 500, clientY: 100 });
  expect(host.querySelector('[data-drag-placeholder]')).toBeNull();
  expect(host.querySelector<HTMLElement>('[data-layout-pane="c"]')!.style.top).toBe('50%');
  start();
  fireEvent.pointerMove(host, { buttons: 1, clientX: 20, clientY: 180 });
  expect(host.querySelector('[data-drag-placeholder]')).not.toBeNull();
  fireEvent.pointerUp(host, { buttons: 0, clientX: 20, clientY: 180 });
  expect(host.querySelector('[data-drag-placeholder]')).toBeNull();
  expect(host.querySelector<HTMLElement>('[data-layout-pane="c"]')!.style.top).toBe('0%');
});

it('stops a split resize and unlocks gestures on blur', async () => {
  const { host } = await setup();
  const lock = vi.fn();
  document.addEventListener('termdock:gesture-lock', lock);
  fireEvent.pointerDown(screen.getAllByRole('separator')[0], { buttons: 1 });
  fireEvent.pointerMove(host, { buttons: 1, clientX: 300 });
  const pane = host.querySelector<HTMLElement>('[data-layout-pane="a"]')!;
  const heldWidth = pane.style.width;
  fireEvent.blur(window);
  fireEvent.pointerMove(host, { buttons: 1, clientX: 700 });
  expect(pane.style.width).toBe(heldWidth);
  expect(lock.mock.calls.at(-1)?.[0].detail).toEqual({ locked: false });
  document.removeEventListener('termdock:gesture-lock', lock);
});
