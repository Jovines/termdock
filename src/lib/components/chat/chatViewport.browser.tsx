import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../../index.css';
import { syncInitialViewportCssVars, useViewportHeight } from '../../hooks/useViewportHeight';
import { SessionChatView } from './SessionChatView';
import { clearChatSnapshots } from './chatSnapshot';

let reactRoot: Root | undefined;
afterEach(() => {
  reactRoot?.unmount(); reactRoot = undefined;
  clearChatSnapshots(); sessionStorage.clear(); vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren(); document.documentElement.removeAttribute('style');
});
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function mountChat(messages: Array<{ id: string; role: string; content: string; createdAt: number; status: string }> = []) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages })));
  syncInitialViewportCssVars();
  const host = document.createElement('div'); host.id = 'root'; document.body.append(host);
  function App() {
    useViewportHeight();
    return <div className="flex h-full flex-col"><header className="h-11 shrink-0">会话标题</header><main className="min-h-0 flex-1"><SessionChatView sessionId="keyboard-layout" onTerminal={() => {}} /></main></div>;
  }
  reactRoot = createRoot(host); reactRoot.render(<App />);
  await expect.element(page.getByRole('textbox')).toBeVisible();
  await frame();
  return host;
}

it.each([false, true])('keeps the header and empty chat stationary through keyboard pans and reversals (standalone: %s)', async standalone => {
  if (standalone) {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
    vi.spyOn(screen, 'width', 'get').mockReturnValue(390);
    vi.spyOn(screen, 'height', 'get').mockReturnValue(844);
    const matchMedia = window.matchMedia.bind(window);
    const query = matchMedia('(display-mode: standalone)');
    vi.spyOn(query, 'matches', 'get').mockReturnValue(true);
    vi.spyOn(window, 'matchMedia').mockImplementation(value => value === query.media ? query : matchMedia(value));
  }
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  await mountChat();
  await expect.element(page.getByRole('heading', { name: '想一起完成什么？' })).toBeVisible();
  await frame();
  const header = document.querySelector('header')!, greeting = document.querySelector('h2')!;
  const composer = document.querySelector('.session-chat-composer')!;
  const before = { header: header.getBoundingClientRect().top, greeting: greeting.getBoundingClientRect().top, bottom: composer.getBoundingClientRect().bottom };
  await page.getByRole('textbox').click();
  for (const [height, offsetTop] of [[820, 0], [680, 120], [470, 250], [470, 0], [844, 0], [460, 220], [460, 0], [844, 0]]) {
    Object.assign(viewport, { height, offsetTop }); viewport.dispatchEvent(new Event('resize')); await frame();
    expect(header.getBoundingClientRect().top, `header at ${height}/${offsetTop}`).toBe(before.header);
    expect(greeting.getBoundingClientRect().top, `greeting at ${height}/${offsetTop}`).toBe(before.greeting);
    // Match TerminalView's fixed-root coordinate system, including a transient
    // Safari pan. Adding offsetTop here hid the partially covered editor.
    expect(composer.getBoundingClientRect().bottom, `composer at ${height}/${offsetTop}`).toBeLessThanOrEqual(height);
    if (height === 844) expect(composer.getBoundingClientRect().bottom).toBe(before.bottom);
  }
});

it('preserves a conversation reading position and lets its last message scroll above the raised composer', async () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  await mountChat(Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: 'user', content: `第 ${i + 1} 条消息，保持阅读位置。`, createdAt: i + 1, status: 'stored' })));
  await expect.element(page.getByText('第 12 条消息，保持阅读位置。')).toBeVisible(); await frame();
  const scroll = document.querySelector<HTMLElement>('.session-chat > div')!;
  const composer = document.querySelector('.session-chat-composer')!;
  scroll.scrollTop = 200; scroll.dispatchEvent(new Event('scroll')); await frame();
  const before = scroll.scrollTop;
  await page.getByRole('textbox').click();
  viewport.height = 470; viewport.dispatchEvent(new Event('resize')); await frame();
  expect(scroll.scrollTop).toBe(before);
  scroll.scrollTop = scroll.scrollHeight; await frame();
  const last = document.querySelector('[data-chat-message="m11"]')!;
  expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(composer.getBoundingClientRect().top);
});

it('keeps the desktop composer in normal flow', async () => {
  await page.viewport(1280, 900);
  const viewport = Object.assign(new EventTarget(), { height: 900, width: 1280, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  await mountChat();
  const composer = document.querySelector('.session-chat-composer')!;
  expect(getComputedStyle(composer).transform).toBe('none');
  await page.getByRole('textbox').fill('桌面草稿'); await frame();
  expect(composer.getBoundingClientRect().bottom).toBe(900);
  expect(document.documentElement.dataset.termdockTouchViewport).toBe('false');
  await page.viewport(390, 844);
});

it('protects iOS native focus reveal without cancelling taps, changing the selection, or scrolling layout ancestors', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  const host = await mountChat();
  const input = document.querySelector('textarea')!;
  const shell = host.firstElementChild as HTMLElement;
  shell.style.overflow = 'hidden';
  // Model WebKit's reveal decision at focus dispatch. The normal browser tests
  // only changed viewport dimensions, so they never exercised this decision.
  const reveal = vi.fn(() => { if (getComputedStyle(input).opacity !== '0') shell.scrollTop = 200; });
  input.addEventListener('focus', reveal);
  for (let i = 0; i < 3; i++) {
    input.blur(); input.value = '保留草稿和选区'; input.setSelectionRange(2, 5);
    const tap = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' });
    expect(input.dispatchEvent(tap)).toBe(true);
    input.focus();
    expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(5);
    expect(shell.scrollTop).toBe(0);
    await frame();
    expect(getComputedStyle(input).opacity).toBe('1');
    expect(input.value).toBe('保留草稿和选区');
  }
  expect(reveal).toHaveBeenCalledTimes(3);
  await page.getByRole('textbox').fill('第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行');
  viewport.height = 470; viewport.dispatchEvent(new Event('resize')); await frame();
  expect(input.getBoundingClientRect().bottom).toBeLessThanOrEqual(470);
  expect(input.getBoundingClientRect().top).toBeGreaterThanOrEqual(document.querySelector('header')!.getBoundingClientRect().bottom);
  expect(getComputedStyle(input).opacity).toBe('1');
  // Cleanup also restores a still-masked input and its original focus method.
  input.blur(); input.focus(); reactRoot?.unmount(); reactRoot = undefined;
  expect(input.style.opacity).toBe('');
  expect(Object.hasOwn(input, 'focus')).toBe(false);
});
