import { createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import { Swiper, SwiperSlide } from 'swiper/react';
import 'swiper/css';
import '../../../index.css';
import { I18nProvider } from '../../i18n';
import { getDefaultTerminalSettings } from '../../terminal/settings';
import { FLEXOKI_DARK } from '../../terminal/theme';
import { SESSION_NO_SWIPE, SESSION_SWIPER_FOCUSABLE_ELEMENTS } from '../chat/sessionSwipe';
import { TerminalViewport, type TerminalController } from './TerminalViewport';

declare module 'vitest/browser' {
  interface BrowserCommands {
    desktopTerminalPointer(action: 'click' | 'right-click' | 'drag' | 'wheel'): Promise<void>;
    desktopTerminalComposition(text: string, commit?: boolean): Promise<void>;
  }
}

let root: Root | undefined;
afterEach(async () => {
  root?.unmount(); root = undefined;
  document.body.replaceChildren(); vi.restoreAllMocks();
  await page.viewport(390, 844);
});
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

it('keeps one editable focus target through desktop clicks, composition, selection and refocus', async () => {
  await page.viewport(1280, 900);
  const host = document.createElement('div'); host.style.height = '700px'; document.body.append(host);
  const controller = createRef<TerminalController>(), onInput = vi.fn(), onTmuxScroll = vi.fn();
  const settings = { ...getDefaultTerminalSettings(), rendererMode: 'canvas' as const, enableImages: false, fontLigatures: false };
  root = createRoot(host);
  root.render(<I18nProvider><input aria-label="搜索" /><Swiper style={{ height: 650 }} simulateTouch={false}
    touchStartPreventDefault={false} noSwipingSelector={SESSION_NO_SWIPE} focusableElements={SESSION_SWIPER_FOCUSABLE_ELEMENTS}>
    <SwiperSlide><TerminalViewport ref={controller} sessionKey="desktop-ime" sessionId="desktop-ime"
      chunks={[{ id: 1, data: 'select this terminal text\r\n$ ' }]} onInput={onInput} onResize={vi.fn()}
      onTmuxScroll={onTmuxScroll} terminalSettings={settings} theme={FLEXOKI_DARK} autoFocus={false} /></SwiperSlide>
    <SwiperSlide>另一个会话</SwiperSlide>
  </Swiper></I18nProvider>);
  await expect.poll(() => document.querySelector('.xterm-rows')?.textContent).toContain('select this terminal text');
  const input = document.querySelector<HTMLTextAreaElement>('textarea[data-terminal-input-anchor]')!;
  const helper = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
  const writeClipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const helperFocus = vi.fn(), blur = vi.fn();
  helper.addEventListener('focus', helperFocus); input.addEventListener('blur', blur);
  controller.current!.focus();
  await userEvent.keyboard('abc');
  expect(onInput.mock.calls.map(call => call[0]).join('')).toBe('abc');
  onInput.mockClear();
  await commands.desktopTerminalComposition('ni');
  await expect.poll(() => document.querySelector('[data-terminal-ime-composition]')?.textContent).toBe('ni');
  for (let i = 0; i < 5; i++) {
    await commands.desktopTerminalPointer('click'); await frame();
    expect(document.activeElement).toBe(input);
  }
  expect(helperFocus).not.toHaveBeenCalled();
  expect(blur).not.toHaveBeenCalled();
  expect(document.querySelector('[data-terminal-ime-composition]')?.textContent).toBe('ni');
  expect(onInput).not.toHaveBeenCalled();
  await commands.desktopTerminalComposition('你', true);
  await expect.poll(() => onInput.mock.calls.map(call => call[0]).join('')).toBe('你');
  // Native/programmatic attempts to focus the unused helper must be harmless.
  helper.focus();
  await commands.desktopTerminalPointer('right-click');
  expect(document.activeElement).toBe(input);
  expect(helperFocus).not.toHaveBeenCalled();
  await commands.desktopTerminalPointer('drag');
  const selection = await controller.current!.copySelectionOrViewport();
  expect(selection).toBe(true);
  expect(writeClipboard).toHaveBeenCalledWith(expect.stringMatching(/^[^\r\n]*this term[^\r\n]*$/));
  expect(blur).not.toHaveBeenCalled();
  onInput.mockClear();
  await commands.desktopTerminalPointer('wheel');
  await expect.poll(() => onInput.mock.calls.map(call => call[0]).join('')).toMatch(/\x1b\[<64;\d+;\d+M/);
  expect(document.activeElement).toBe(input);
  await page.getByRole('textbox', { name: '搜索' }).click();
  expect(document.activeElement).not.toBe(input);
  blur.mockClear(); helperFocus.mockClear(); onInput.mockClear();
  await commands.desktopTerminalPointer('click');
  await commands.desktopTerminalComposition('zhong');
  await commands.desktopTerminalComposition('中', true);
  await expect.poll(() => onInput.mock.calls.map(call => call[0]).join('')).toBe('中');
  expect(helperFocus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled();
});
