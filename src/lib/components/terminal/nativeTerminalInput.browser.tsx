import { createRoot, type Root } from 'react-dom/client';
import { createRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { Swiper, SwiperSlide } from 'swiper/react';
import 'swiper/css';
import '@xterm/xterm/css/xterm.css';
import '../../../index.css';
import { I18nProvider } from '../../i18n';
import { syncInitialViewportCssVars, useViewportHeight } from '../../hooks/useViewportHeight';
import { getKeyboardPanelStyles } from '../layout/keyboardPanelLayout';
import { getDefaultTerminalSettings } from '../../terminal/settings';
import { FLEXOKI_DARK } from '../../terminal/theme';
import { TerminalViewport, type TerminalController } from './TerminalViewport';
import { SESSION_NO_SWIPE, SESSION_SWIPER_FOCUSABLE_ELEMENTS } from '../chat/sessionSwipe';

let root: Root | undefined;
afterEach(async () => {
  root?.unmount(); root = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
  document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset.termdockNativeKeyboard;
  delete document.documentElement.dataset.termdockNativePan;
  delete document.documentElement.dataset.termdockTouchViewport;
  await page.viewport(390, 844);
});

it.each([[0, true], [34, false]] as const)('lets the browser move the real terminal input without a viewport-height translation (safe bottom %i, pager enabled %s)', async (safeBottom, pagerEnabled) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  if (safeBottom) {
    vi.spyOn(screen, 'width', 'get').mockReturnValue(390);
    vi.spyOn(screen, 'height', 'get').mockReturnValue(844);
    const original = window.matchMedia.bind(window), standalone = original('(display-mode: standalone)');
    vi.spyOn(standalone, 'matches', 'get').mockReturnValue(true);
    vi.spyOn(window, 'matchMedia').mockImplementation(query => query === standalone.media ? standalone : original(query));
  }
  vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { height: 9999, width: 390, offsetTop: 88, scale: 1 }));
  syncInitialViewportCssVars();
  const host = document.createElement('div'); host.id = 'root'; host.style.height = '844px'; document.body.append(host);
  const controller = createRef<TerminalController>(), onInput = vi.fn(), onResize = vi.fn();
  const settings = { ...getDefaultTerminalSettings(), rendererMode: 'canvas' as const, enableImages: false, fontLigatures: false };
  let setTmuxMode: (enabled: boolean) => void;
  const onTmuxScroll = vi.fn();
  const chunks = [{ id: 1, data: Array.from({ length: 100 }, (_, i) => `history line ${i}\r\n`).join('') }];
  function App() {
    useViewportHeight();
    const [dock, setDock] = useState<HTMLDivElement | null>(null);
    const [tmuxMode, updateTmuxMode] = useState(false);
    setTmuxMode = updateTmuxMode;
    const layout = getKeyboardPanelStyles(true);
    return <I18nProvider><div className="flex h-full flex-col overflow-hidden">
      <header data-termdock-window-header="true" className="relative h-11 shrink-0">终端标题</header>
      <Swiper className="min-h-0 w-full flex-1" onSwiper={swiper => { swiper.allowTouchMove = pagerEnabled; }} touchStartPreventDefault={false} simulateTouch={false} noSwipingSelector={SESSION_NO_SWIPE} focusableElements={SESSION_SWIPER_FOCUSABLE_ELEMENTS}>
      <SwiperSlide><section className="flex h-full min-h-0 flex-col overflow-hidden" style={layout.rootStyle}>
        <main className="relative min-h-0 flex-1 overflow-hidden" style={layout.contentStyle}>
          <TerminalViewport ref={controller} sessionKey="native-browser" sessionId="native-browser" chunks={chunks} onInput={onInput} onResize={onResize}
            terminalSettings={settings} theme={FLEXOKI_DARK} autoFocus={false} enableTouchScroll nativeInputHost={dock} onTmuxScroll={tmuxMode ? onTmuxScroll : undefined} />
        </main>
        <div ref={setDock} data-native-terminal-input-host className="relative h-14 shrink-0">终端工具栏</div>
      </section></SwiperSlide><SwiperSlide>另一个会话</SwiperSlide></Swiper>
    </div></I18nProvider>;
  }
  root = createRoot(host); root.render(<App />);
  await expect.poll(() => document.querySelector('textarea[data-terminal-input-anchor]')).toBeTruthy();
  const input = document.querySelector<HTMLTextAreaElement>('textarea[data-terminal-input-anchor]')!;
  expect(input.closest('[data-native-terminal-input-host]')).not.toBeNull();
  expect(input.style.opacity).toBe('1');
  expect(input.readOnly).toBe(false);
  const header = document.querySelector('header')!, content = document.querySelector('main')!;
  const headerTop = header.getBoundingClientRect().top;
  const top = content.getBoundingClientRect().top, height = content.getBoundingClientRect().height;
  await page.viewport(390, 430);
  controller.current!.focus();
  await expect.poll(() => document.activeElement === input).toBe(true);
  await expect.poll(() => header.getBoundingClientRect().top).toBe(headerTop);
  await expect.poll(() => input.getBoundingClientRect().bottom).toBeLessThanOrEqual(430);
  expect(document.querySelector('[data-native-terminal-input-host]')!.getBoundingClientRect().bottom).toBeLessThanOrEqual(430);
  expect(getComputedStyle(host).paddingBottom).toBe('0px');
  expect(content.getBoundingClientRect().top).toBe(top);
  expect(content.getBoundingClientRect().height).toBeLessThan(height);
  expect(document.querySelector('[data-terminal-touch-surface]')).not.toBeNull();
  await page.elementLocator(input).fill('pwd');
  await expect.poll(() => onInput.mock.calls.map(call => call[0]).join('')).toContain('pwd');
  await expect.poll(() => document.querySelector('.xterm-rows')?.textContent).toContain('history line 99');
  const before = document.querySelector('.xterm-rows')!.textContent;
  const blur = vi.fn(); input.addEventListener('blur', blur);
  const focusEvent = vi.fn(); input.addEventListener('focus', focusEvent);
  const focus = vi.spyOn(input, 'focus');
  const starts: boolean[] = [];
  const observeStart = (event: Event) => starts.push(event.defaultPrevented);
  const surface = document.querySelector('[data-terminal-touch-surface]')!;
  expect(surface).toBeInstanceOf(HTMLButtonElement);
  // Observe after the terminal's capture handlers. A WebKit focus transfer
  // must be stopped at touch start, before compatibility mouse events exist.
  surface.addEventListener('pointerdown', observeStart);
  surface.addEventListener('touchstart', observeStart);
  await commands.inputPanelDrag('[data-terminal-touch-surface]', 100);
  expect(blur).not.toHaveBeenCalled();
  await expect.poll(() => document.querySelector('.xterm-rows')!.textContent).not.toBe(before);
  expect(starts).toEqual([true, false]);
  expect(focus).not.toHaveBeenCalled();
  // A stale "keyboard closed" report at tap release must not cause a
  // blur/focus retry in either terminal tap handler.
  const staleViewport = () => {
    document.documentElement.style.setProperty('--kb-height', '0px');
    document.documentElement.style.setProperty('--app-base-vh', '844px');
    Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 });
  };
  window.addEventListener('pointerup', staleViewport, { capture: true, once: true });
  await commands.inputPanelDrag('[data-terminal-touch-surface]', 0);
  // Explicit taps/caller requests must reach WebKit even if DOM focus survived
  // a dismissed input view. Same-element focus must not blur or reset selection.
  staleViewport();
  controller.current!.focus();
  expect(document.activeElement).toBe(input);
  expect(blur).not.toHaveBeenCalled(); expect(focusEvent).not.toHaveBeenCalled();
  expect(focus).toHaveBeenCalledTimes(2);
  expect(input.readOnly).toBe(false);
  input.removeEventListener('blur', blur);
  focus.mockClear();
  controller.current!.blur();
  expect(document.activeElement).not.toBe(input);
  expect(focus).not.toHaveBeenCalled();
  await commands.inputPanelDrag('[data-terminal-touch-surface]', 0);
  expect(document.activeElement).toBe(input);
  expect(focus).toHaveBeenCalledTimes(1);
  await expect.poll(() => document.querySelector('.xterm-screen')!.getBoundingClientRect().height)
    .toBeLessThanOrEqual(content.getBoundingClientRect().height + 1);
  // Model native keyboard dismissal WITHOUT a DOM blur, in normal and tmux
  // modes. The old activeElement early return made every later tap a no-op.
  for (const tmuxMode of [false, false, true]) {
    setTmuxMode!(tmuxMode);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(input);
    input.setSelectionRange(1, 2);
    expect(input.readOnly).toBe(false);
    await page.viewport(390, 844);
    await expect.poll(() => document.documentElement.style.getPropertyValue('--app-native-pan')).toBe('0px');
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    focus.mockClear(); focusEvent.mockClear();
    await commands.inputPanelDrag('[data-terminal-touch-surface]', 0);
    expect(document.activeElement).toBe(input);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focusEvent).not.toHaveBeenCalled();
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 2]);
    expect(input.value).toBe('pwd');
    await page.viewport(390, 430);
  }
  blur.mockClear(); focus.mockClear(); focusEvent.mockClear(); input.addEventListener('blur', blur);
  await commands.inputPanelDrag('[data-terminal-touch-surface]', 100);
  expect(document.activeElement).toBe(input);
  expect(blur).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
  expect(focusEvent).not.toHaveBeenCalled();
});
