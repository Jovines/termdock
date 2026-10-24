import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { Swiper, SwiperSlide } from 'swiper/react';
import 'swiper/css';
import '../../../index.css';
import { syncInitialViewportCssVars, useViewportHeight } from '../../hooks/useViewportHeight';
import { SessionChatView } from './SessionChatView';
import { clearChatSnapshots } from './chatSnapshot';
import { SESSION_NO_SWIPE, SESSION_SWIPER_FOCUSABLE_ELEMENTS } from './sessionSwipe';
import { readChatEditor } from './ChatRichEditor';

let root: Root | undefined;
afterEach(async () => {
  root?.unmount(); root = undefined;
  clearChatSnapshots(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset.termdockNativeKeyboard;
  delete document.documentElement.dataset.termdockNativePan;
  delete document.documentElement.dataset.termdockTouchViewport;
  await page.viewport(390, 844);
});
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function mount(mode: 'resize' | 'pan', safeBottom = 0, messages: object[] = []) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  if (safeBottom) {
    vi.spyOn(screen, 'width', 'get').mockReturnValue(390);
    vi.spyOn(screen, 'height', 'get').mockReturnValue(844);
    const original = window.matchMedia.bind(window), standalone = original('(display-mode: standalone)');
    vi.spyOn(standalone, 'matches', 'get').mockReturnValue(true);
    vi.spyOn(window, 'matchMedia').mockImplementation(query => query === standalone.media ? standalone : original(query));
  }
  // Wrong, and deliberately unchanged while the real browser resizes/pans.
  // Input placement must not follow this value or derive a toolbar offset.
  vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { height: 9999, width: 390, offsetTop: 88, scale: 1 }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages })));
  syncInitialViewportCssVars();
  const host = document.createElement('div'); host.id = 'root';
  if (mode === 'pan') host.style.height = '844px'; // Model an unchanged iOS layout viewport.
  document.body.append(host);
  function App() {
    useViewportHeight();
    return <div className="flex h-full flex-col overflow-hidden">
      <header data-termdock-window-header="true" className="relative h-11 shrink-0">会话标题</header>
      <main className="min-h-0 flex-1 overflow-hidden" style={{ position: 'relative', zIndex: 1, background: 'var(--chrome-bg)' }}>
        <Swiper className="h-full" touchStartPreventDefault={false} simulateTouch={false} noSwipingSelector={SESSION_NO_SWIPE} focusableElements={SESSION_SWIPER_FOCUSABLE_ELEMENTS}>
          <SwiperSlide><SessionChatView sessionId="native-focus-production" onTerminal={() => {}} /></SwiperSlide>
          <SwiperSlide>另一个会话</SwiperSlide>
        </Swiper>
      </main>
    </div>;
  }
  root = createRoot(host); root.render(<App />);
  await expect.element(page.getByRole('textbox')).toBeVisible(); await frame();
  return document.querySelector('[role="textbox"]') as HTMLElement;
}

it.each(['resize', 'pan'] as const)('lets native focus place the real chat input with incorrect viewport data (%s)', async mode => {
  const input = await mount(mode);
  const header = document.querySelector('header')!, content = document.querySelector('.session-chat-scroll')!;
  const top = content.getBoundingClientRect().top;
  const originalHeight = content.getBoundingClientRect().height;
  for (const visible of [430, 844, 470, 844, 400, 516]) {
    input.blur();
    await page.viewport(390, visible);
    input.focus(); // Real browser focus scrolling, no scrollTo or authored input translation.
    await expect.poll(() => header.getBoundingClientRect().top).toBe(0);
    await frame();
    expect(content.getBoundingClientRect().top).toBe(top);
    expect(input.getBoundingClientRect().bottom).toBeLessThanOrEqual(visible);
    expect(document.querySelector('.session-chat-composer')!.getBoundingClientRect().bottom).toBeLessThanOrEqual(visible);
    expect(input.style.opacity).toBe('');
    expect(getComputedStyle(document.querySelector('[data-session-chat]')!).transform).toBe('none');
    if (visible < 600) expect(content.getBoundingClientRect().height).toBeLessThan(originalHeight);
  }
  await page.getByRole('textbox').fill('第一行\n第二行\n第三行'); await frame();
  // Contenteditable growth can trigger another native scroll after input;
  // wait for the shared viewport controller just as after focus above.
  await expect.poll(() => header.getBoundingClientRect().top).toBe(0);
  expect(content.getBoundingClientRect().top).toBe(top);
  expect(input.getBoundingClientRect().bottom).toBeLessThanOrEqual(516);
  expect(document.querySelector('.session-chat-composer')!.getBoundingClientRect().bottom).toBeLessThanOrEqual(516);
});

it('keeps the translated header above the session canvas stacking context', async () => {
  const input = await mount('pan');
  await page.viewport(390, 430); input.focus();
  const header = document.querySelector('header')!;
  await expect.poll(() => header.getBoundingClientRect().top).toBe(0);
  expect(document.elementFromPoint(20, 20)?.closest('header')).toBe(header);
});

it('releases the home-indicator padding only during actual native pan and restores it on dismissal', async () => {
  const input = await mount('pan', 34), host = document.getElementById('root')!;
  expect(getComputedStyle(host).paddingBottom).toBe('34px');
  await page.viewport(390, 430); input.focus();
  await expect.poll(() => Number.parseFloat(document.documentElement.style.getPropertyValue('--app-native-pan'))).toBeGreaterThan(0);
  await expect.poll(() => getComputedStyle(host).paddingBottom).toBe('0px');
  expect(document.querySelector('.session-chat-composer')!.getBoundingClientRect().bottom).toBe(host.getBoundingClientRect().bottom);
  input.blur(); await page.viewport(390, 844);
  await expect.poll(() => getComputedStyle(host).paddingBottom).toBe('34px');
});

it('does not let a touch drag on an empty conversation move the page', async () => {
  await mount('pan');
  const before = window.scrollY;
  let prevented = false;
  const observe = (event: TouchEvent) => { prevented ||= event.defaultPrevented; };
  document.addEventListener('touchmove', observe);
  try {
    await commands.inputPanelDrag('.session-chat-welcome', -80);
    expect(prevented).toBe(true);
    expect(window.scrollY).toBe(before);
  } finally { document.removeEventListener('touchmove', observe); }
});

it('scrolls and touches the conversation without blurring or refocusing the editor', async () => {
  const input = await mount('pan', 0, Array.from({ length: 32 }, (_, i) => ({ id: `keep-${i}`, role: 'user', content: `历史消息 ${i}`, createdAt: i + 1, status: 'stored' })));
  await page.getByRole('textbox').fill('保留这份中文草稿');
  await page.viewport(390, 430); input.focus();
  await expect.poll(() => document.querySelector('header')!.getBoundingClientRect().top).toBe(0);
  const list = document.querySelector<HTMLElement>('.session-chat-scroll')!;
  list.scrollTop = 500; list.dispatchEvent(new Event('scroll')); await frame();
  const textNode = input.firstChild!; const range = document.createRange(); range.setStart(textNode, 2); range.setEnd(textNode, 5); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  const blur = vi.fn(); input.addEventListener('blur', blur);
  const focus = vi.spyOn(input, 'focus');
  const before = list.scrollTop;
  await commands.inputPanelDrag('.session-chat-scroll', -80);
  await expect.poll(() => list.scrollTop).toBeGreaterThan(before);
  await commands.inputPanelDrag('.session-chat-scroll', 60);
  await commands.inputPanelDrag('.session-chat-scroll', 0);
  expect(document.activeElement).toBe(input);
  expect(blur).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
  expect(readChatEditor(input).text).toBe('保留这份中文草稿');
  expect([readChatEditor(input).start, readChatEditor(input).end]).toEqual([2, 5]);
  input.removeEventListener('blur', blur);
  input.blur(); await frame();
  expect(document.activeElement).not.toBe(input);
  expect(focus).not.toHaveBeenCalled();
});
