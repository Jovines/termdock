// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { attachComputerClipboard, COMPUTER_CLIPBOARD_LIMIT, COMPUTER_COPY_REQUEST_EVENT } from './clipboard';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function setup() {
  const viewport = document.createElement('div'); document.body.append(viewport);
  const session = new EventTarget(), paste = vi.fn(), receive = vi.fn(), failed = vi.fn();
  const stop = attachComputerClipboard(viewport, session, { paste, receive, failed });
  const input = (text: string, types = ['text/plain']) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: { types, getData: () => text } }); viewport.dispatchEvent(event); return event;
  };
  return { viewport, session, paste, receive, failed, stop, input };
}
it('lets the browser produce paste before the renderer consumes Ctrl/Cmd+V, then uploads the text once', () => {
  const s = setup(), renderer = vi.fn(); s.viewport.addEventListener('keydown', renderer);
  const key = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  s.viewport.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false); expect(renderer).not.toHaveBeenCalled();
  expect(s.input('你好🙂\nnext').defaultPrevented).toBe(true);
  expect(s.paste).toHaveBeenCalledExactlyOnceWith('你好🙂\nnext', true);
  expect(s.input('').defaultPrevented).toBe(true);
  expect(s.paste).toHaveBeenLastCalledWith('', false); s.stop();
});
it('preserves other remote shortcuts and supports context-menu paste without a keydown', () => {
  const s = setup(), renderer = vi.fn(); s.viewport.addEventListener('keydown', renderer);
  s.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, altKey: true }));
  expect(renderer).toHaveBeenCalledTimes(1); s.input('context menu');
  expect(s.paste).toHaveBeenCalledExactlyOnceWith('context menu', false); s.stop();
});
it('receives remote text without writing the device clipboard until the user asks to copy', async () => {
  const writeText = vi.fn(async () => {}); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const s = setup();
  s.session.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'background' } }));
  expect(s.receive).toHaveBeenCalledExactlyOnceWith('background'); expect(writeText).not.toHaveBeenCalled();
  s.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true }));
  s.session.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'selected 中文🙂' } }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith('selected 中文🙂'); s.stop();
});
it('retains remote text and exposes the manual panel if a requested system copy is denied', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw Error('denied'); }) } });
  const s = setup(); s.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
  s.session.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'retained' } }));
  await Promise.resolve(); expect(s.receive).toHaveBeenCalledWith('retained'); expect(s.failed).toHaveBeenCalledTimes(1); s.stop();
});
it('treats an explicit phone-toolbar copy as a user request without synthesizing keyboard input', () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const s = setup(), keyboard = vi.fn(); s.viewport.addEventListener('keydown', keyboard);
  s.viewport.dispatchEvent(new Event(COMPUTER_COPY_REQUEST_EVENT));
  s.session.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'phone copy🙂' } }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith('phone copy🙂');
  expect(keyboard).not.toHaveBeenCalled(); s.stop();
});
it('rejects images and oversize clipboard content without typing or logging it', () => {
  const s = setup(); s.input('image', ['Files']); s.input('a'.repeat(COMPUTER_CLIPBOARD_LIMIT + 1));
  expect(s.failed).toHaveBeenCalledTimes(2); expect(s.paste).not.toHaveBeenCalled(); s.stop();
});
it('detaches on disconnect and ignores a late clipboard-permission rejection', async () => {
  let reject!: (reason: Error) => void;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((_, no) => { reject = no; }) } });
  const s = setup(); s.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
  s.session.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'copied' } }));
  s.stop(); reject(Error('late')); await Promise.resolve();
  s.input('ignored'); s.session.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'old session' } }));
  expect(s.paste).not.toHaveBeenCalled(); expect(s.receive).toHaveBeenCalledTimes(1); expect(s.failed).not.toHaveBeenCalled();
});
