import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../../index.css';
import { syncInitialViewportCssVars, useViewportHeight } from '../../hooks/useViewportHeight';
import { SessionChatView } from './SessionChatView';
import { clearChatSnapshots } from './chatSnapshot';

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
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('草稿\n第二行');
  }
  expect(scrollTo).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.termdockNativeChatLayout).toBeUndefined();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/client-log')).toBe(false);
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
