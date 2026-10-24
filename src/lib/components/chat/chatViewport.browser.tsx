import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import '../../../index.css';
import { syncInitialViewportCssVars, useViewportHeight } from '../../hooks/useViewportHeight';
import { SessionChatView } from './SessionChatView';
import { readChatEditor } from './ChatRichEditor';
import { clearChatSnapshots } from './chatSnapshot';

// This suite retains coverage for the legacy height-based layout (Android).
// Native iOS focus/pan behavior is exercised separately in nativeChatViewport.
vi.mock('../../hooks/nativeKeyboardLayout', async original => ({
  ...await original<typeof import('../../hooks/nativeKeyboardLayout')>(),
  usesNativeKeyboardLayout: () => false,
}));

declare module 'vitest/browser' {
  interface BrowserCommands { inputPanelDrag(selector: string, dy: number): Promise<void> }
}

let reactRoot: Root | undefined;
afterEach(async () => {
  reactRoot?.unmount(); reactRoot = undefined;
  clearChatSnapshots(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); document.documentElement.removeAttribute('style');
  await page.viewport(390, 844);
});
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function mountChat(messages: Array<{ id: string; role: string; content: string; createdAt: number; status: string }> = []) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages })));
  syncInitialViewportCssVars();
  const host = document.createElement('div'); host.id = 'root'; document.body.append(host);
  function App() {
    useViewportHeight();
    return <div className="flex h-full flex-col overflow-hidden"><header className="relative h-11 shrink-0">会话标题</header><main className="min-h-0 flex-1 overflow-hidden"><SessionChatView sessionId="terminal-chat-layout" onTerminal={() => {}} /></main></div>;
  }
  reactRoot = createRoot(host); reactRoot.render(<App />);
  await expect.element(page.getByRole('textbox')).toBeVisible(); await frame();
}

it.each([0, 34])('uses the terminal layout to keep navigation and the conversation top stable (safe bottom %i)', async safeBottom => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  if (safeBottom) {
    vi.spyOn(screen, 'width', 'get').mockReturnValue(390); vi.spyOn(screen, 'height', 'get').mockReturnValue(844);
    const matchMedia = window.matchMedia.bind(window), standalone = matchMedia('(display-mode: standalone)');
    vi.spyOn(standalone, 'matches', 'get').mockReturnValue(true);
    vi.spyOn(window, 'matchMedia').mockImplementation(query => query === standalone.media ? standalone : matchMedia(query));
  }
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  await mountChat();
  const header = document.querySelector('header')!, list = document.querySelector('.session-chat-scroll')!, composer = document.querySelector('.session-chat-composer')!;
  const initial = { header: header.getBoundingClientRect().top, list: list.getBoundingClientRect().top, height: list.getBoundingClientRect().height };
  const scrollTo = vi.spyOn(window, 'scrollTo');
  await page.getByRole('textbox').fill('草稿\n第二行');
  for (const [height, offsetTop] of [[680, 0], [470, 0], [470, 80], [470, 0], [844, 0], [460, 0], [844, 0]]) {
    Object.assign(viewport, { height, offsetTop }); viewport.dispatchEvent(new Event('resize')); await frame();
    expect(header.getBoundingClientRect().top).toBe(initial.header);
    expect(list.getBoundingClientRect().top).toBe(initial.list);
    expect(composer.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    expect(getComputedStyle(composer).transform).toBe('none');
    if (height < 700) expect(list.getBoundingClientRect().height).toBeLessThan(initial.height);
    expect(readChatEditor(document.querySelector('[role="textbox"]') as HTMLElement).text).toBe('草稿\n第二行');
  }
  expect(scrollTo).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.termdockNativeChatLayout).toBeUndefined();
  // Numeric diagnostics may be sent; editor content never belongs in them.
  for (const [url, init] of vi.mocked(fetch).mock.calls) {
    if (url === '/api/client-log') expect(String(init?.body)).not.toContain('草稿');
  }
});

it('keeps the latest message above the composer while preserving an older reading position', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  await mountChat(Array.from({ length: 18 }, (_, i) => ({ id: `m${i}`, role: 'user', content: `第 ${i + 1} 条消息。`, createdAt: i + 1, status: 'stored' })));
  await expect.element(page.getByText('第 18 条消息。')).toBeVisible(); await frame();
  const list = document.querySelector<HTMLElement>('.session-chat-scroll')!, composer = document.querySelector('.session-chat-composer')!;
  await page.getByRole('textbox').click();
  viewport.height = 470; viewport.dispatchEvent(new Event('resize')); await frame();
  expect(document.querySelector('[data-chat-message="m17"]')!.getBoundingClientRect().bottom).toBeLessThanOrEqual(composer.getBoundingClientRect().top);
  list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); await frame();
  for (const height of [844, 460, 844]) {
    viewport.height = height; viewport.dispatchEvent(new Event('resize')); await frame();
    expect(list.scrollTop).toBe(0);
  }
});

it('keeps the desktop editor in normal flow', async () => {
  await page.viewport(1280, 900); await mountChat();
  await page.getByRole('textbox').fill('桌面输入'); await frame();
  expect(getComputedStyle(document.querySelector('.session-chat')!).transform).toBe('none');
  expect(getComputedStyle(document.querySelector('.session-chat-scroll')!).marginTop).toBe('0px');
  expect(document.querySelector('.session-chat-composer')!.getBoundingClientRect().bottom).toBe(900);
});

it('retains the original layout base through native pan and subsequent keyboard sessions', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  await mountChat();
  const input = document.querySelector('[role="textbox"]') as HTMLElement, header = document.querySelector('header')!;
  const list = document.querySelector('.session-chat-scroll')!, composer = document.querySelector('.session-chat-composer')!;
  const initialTop = list.getBoundingClientRect().top;
  for (const [height, offsetTop, focused] of [[470, 330, true], [844, 44, false], [470, 0, true], [844, 44, false], [460, 44, true]] as const) {
    if (focused) input.focus(); else input.blur();
    vi.stubGlobal('innerHeight', height);
    Object.assign(viewport, { height, offsetTop }); viewport.dispatchEvent(new Event('resize')); await frame();
    expect(document.documentElement.style.getPropertyValue('--app-base-vh')).toBe('844px');
    expect(document.getElementById('root')!.getBoundingClientRect().height).toBe(844);
    expect(header.getBoundingClientRect().top).toBe(0);
    expect(list.getBoundingClientRect().top).toBe(initialTop);
    expect(composer.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
  }
});

it('grows the composer in normal flow without moving the empty-state anchor or resetting the live contenteditable editor', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  await mountChat();
  const input = document.querySelector('[role="textbox"]') as HTMLElement, welcome = document.querySelector('.session-chat-welcome')!;
  const list = document.querySelector('.session-chat-scroll')!, composer = document.querySelector('.session-chat-composer')!;
  await page.getByRole('textbox').click();
  viewport.height = 470; viewport.dispatchEvent(new Event('resize')); await frame();
  const top = welcome.getBoundingClientRect().top;
  const oldStyles: string[] = [];
  const mutations = new MutationObserver(records => records.forEach(record => oldStyles.push(record.oldValue || '')));
  mutations.observe(input, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
  for (const lines of [1, 2, 3, 6, 12, 3, 1]) {
    await page.getByRole('textbox').fill(Array.from({ length: lines }, (_, i) => `第${i + 1}行`).join('\n'));
    await frame();
    expect(input.getBoundingClientRect().height).toBe(Math.min(176, lines * 28 + 16));
    expect(welcome.getBoundingClientRect().top).toBe(top);
    expect(list.scrollTop).toBe(0);
    expect(composer.getBoundingClientRect().bottom).toBe(470);
    expect(window.scrollY).toBe(0);
  }
  mutations.disconnect();
  expect(oldStyles.some(style => /height:\s*auto/.test(style))).toBe(false);
  await page.getByRole('textbox').fill('第一行\n'); await frame();
  expect(input.getBoundingClientRect().height).toBe(72);
});

it('keeps an older reading position while the composer grows and shrinks', async () => {
  await mountChat(Array.from({ length: 35 }, (_, i) => ({ id: `grow-${i}`, role: 'user', content: `历史消息第 ${i + 1} 条。`, createdAt: i + 1, status: 'stored' })));
  await expect.element(page.getByText('历史消息第 35 条。')).toBeVisible(); await frame();
  const list = document.querySelector<HTMLElement>('.session-chat-scroll')!;
  await page.getByRole('textbox').fill('第一行\n第二行\n第三行\n第四行'); await frame();
  expect(document.querySelector('[data-chat-message="grow-34"]')!.getBoundingClientRect().bottom)
    .toBeLessThanOrEqual(document.querySelector('.session-chat-composer')!.getBoundingClientRect().top);
  list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); await frame();
  const first = document.querySelector('[data-chat-message="grow-0"]')!;
  const top = first.getBoundingClientRect().top;
  for (const draft of ['一行', '第一行\n第二行\n第三行', '一行']) {
    await page.getByRole('textbox').fill(draft); await frame();
    expect(list.scrollTop).toBe(0);
    expect(first.getBoundingClientRect().top).toBe(top);
  }
});

it('reflows the editor from its content when available width changes', async () => {
  await mountChat();
  await page.getByRole('textbox').fill('自然换行的中文内容 mixed text '.repeat(18)); await frame();
  const input = document.querySelector('[role="textbox"]') as HTMLElement;
  const narrow = input.getBoundingClientRect().height;
  await page.viewport(1280, 900); await frame();
  expect(input.getBoundingClientRect().height).toBeLessThan(narrow);
  expect(input.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
});

it('contains touch drags at the editor boundary while keeping long drafts natively scrollable', async () => {
  await mountChat();
  const input = document.querySelector('[role="textbox"]') as HTMLElement;
  let prevented = false;
  const observe = (event: TouchEvent) => { prevented ||= event.defaultPrevented; };
  document.addEventListener('touchmove', observe);
  try {
    await commands.inputPanelDrag('[role="textbox"]', -80);
    expect(prevented).toBe(true);
    expect(window.scrollY).toBe(0);
    await page.getByRole('textbox').fill(Array.from({ length: 25 }, (_, i) => `草稿第${i + 1}行`).join('\n')); await frame();
    input.scrollTop = 0;
    await commands.inputPanelDrag('[role="textbox"]', -80);
    await expect.poll(() => input.scrollTop).toBeGreaterThan(0);
    input.scrollTop = input.scrollHeight;
    prevented = false;
    await commands.inputPanelDrag('[role="textbox"]', -80);
    expect(prevented).toBe(true);
    expect(window.scrollY).toBe(0);
  } finally { document.removeEventListener('touchmove', observe); }
});
