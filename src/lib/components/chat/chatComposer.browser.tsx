import { createRoot, type Root } from 'react-dom/client';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';
import '../../../index.css';
import { SessionChatView } from './SessionChatView';
import { SESSION_NO_SWIPE, SESSION_SWIPER_FOCUSABLE_ELEMENTS } from './sessionSwipe';
import { clearChatSnapshots } from './chatSnapshot';
import { composeChatDraft } from './chatComposerContent';
import { readChatEditor } from './ChatRichEditor';
import { useSessionDirectoryStore } from '../../stores/useSessionDirectory';
vi.mock('../../terminal/api', async original => ({ ...await original<typeof import('../../terminal/api')>(),
  listCollaborationGroups: async () => ({ groups: [{ id: 'team', name: '界面打磨', sessionIds: ['browser-composer', 'worker'] }], sessions: [] }),
  subscribeCollaborationGroups: () => () => {},
}));

declare module 'vitest/browser' {
  interface BrowserCommands { touchDrag(selector: string, dx: number, dy: number): Promise<void> }
}
let root: Root | undefined, swiper: SwiperInstance | undefined;
afterEach(async () => { root?.unmount(); root = undefined; clearChatSnapshots(); sessionStorage.clear(); vi.unstubAllGlobals(); document.body.replaceChildren(); useSessionDirectoryStore.getState().replace([]); await page.viewport(390, 844); });
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function mount(messages: object[] = []) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages })));
  const host = document.createElement('div'); host.style.height = '100dvh'; document.body.append(host);
  function App() {
    const [index, setIndex] = useState(0);
    return <Swiper onSwiper={value => { swiper = value; }} onSlideChange={value => setIndex(value.activeIndex)} speed={0} touchStartPreventDefault={false} noSwipingSelector={SESSION_NO_SWIPE} focusableElements={SESSION_SWIPER_FOCUSABLE_ELEMENTS} className="session-chat-swiper h-full">
      <SwiperSlide><SessionChatView sessionId="browser-composer" active={index === 0} onTerminal={() => {}} /></SwiperSlide>
      <SwiperSlide><div>第二个 Session</div></SwiperSlide>
    </Swiper>;
  }
  root = createRoot(host); root.render(<App />);
  await expect.element(page.getByRole('textbox')).toBeVisible(); await frame();
}
it('switches Sessions with a native touch swipe on the empty conversation canvas', async () => {
  await mount(); await expect.element(page.getByText('想一起完成什么？')).toBeVisible();
  await commands.touchDrag('.session-chat-scroll', -240, 2);
  await expect.poll(() => swiper?.activeIndex).toBe(1);
  await commands.touchDrag('.swiper-slide-active', 240, 2);
  await expect.poll(() => swiper?.activeIndex).toBe(0);
});
it('switches Sessions from the composer while keeping vertical history scrolling local', async () => {
  await mount(Array.from({ length: 30 }, (_, index) => ({ id: `m${index}`, role: 'user', content: `消息 ${index}\n多行正文\n继续阅读`, createdAt: index, status: 'stored' })));
  await commands.touchDrag('[data-chat-composer]', -220, 2);
  await expect.poll(() => swiper?.activeIndex).toBe(1);
  await commands.touchDrag('.swiper-slide-active', 220, 2);
  await expect.poll(() => swiper?.activeIndex).toBe(0);
  await page.getByRole('textbox').fill('正在编辑的草稿');
  await commands.touchDrag('[role="textbox"]', -220, 1);
  await expect.poll(() => swiper?.activeIndex).toBe(1);
  await commands.touchDrag('.swiper-slide-active', 220, 1);
  await expect.poll(() => swiper?.activeIndex).toBe(0);
  const scroll = document.querySelector('.session-chat-scroll')!;
  scroll.scrollTop = 500; await frame(); const initial = scroll.scrollTop;
  await commands.touchDrag('.session-chat-scroll', 1, -160);
  await expect.poll(() => scroll.scrollTop).toBeGreaterThan(initial);
  expect(swiper?.activeIndex).toBe(0);
  await commands.touchDrag('.session-chat-scroll', -240, 1);
  await expect.poll(() => swiper?.activeIndex).toBe(1);
});
it('scrolls code horizontally without switching the Session', async () => {
  await page.viewport(390, 844);
  await mount([{ id: 'code', role: 'assistant', content: `\`\`\`text\n${'long_code_line_'.repeat(40)}\n\`\`\``, createdAt: 1, status: 'stored' }]);
  await expect.element(page.getByRole('code')).toBeVisible();
  const pre = document.querySelector('pre')!;
  expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
  await commands.touchDrag('[data-session-chat] pre', -200, 1);
  await expect.poll(() => pre.scrollLeft).toBeGreaterThan(0);
  expect(swiper?.activeIndex).toBe(0);
});
it.each([390, 1280])('keeps attachments, the editor and send action visible at width %i', async width => {
  await page.viewport(width, 844);
  const files = [{ path: '/tmp/cover.png', name: '界面截图.png', type: 'image/png', size: 12000 }, { path: '/tmp/demo.mov', name: '操作演示.mov', type: 'video/quicktime', size: 2000000 }];
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:extras`, composeChatDraft('', files, []));
  await mount(); await expect.element(page.getByRole('button', { name: '移除附件 操作演示.mov' })).toBeVisible();
  const composer = document.querySelector('[data-chat-composer]')!.getBoundingClientRect();
  expect(composer.top).toBeGreaterThan(500); expect(composer.bottom).toBeLessThanOrEqual(844);
  const editor = (document.querySelector('[role="textbox"]') as HTMLElement).getBoundingClientRect(), toolbar = document.querySelector('[data-chat-composer-toolbar]')!.getBoundingClientRect();
  expect(editor.width).toBeGreaterThan(composer.width * .9); expect(toolbar.top).toBeGreaterThanOrEqual(editor.bottom);
  expect(readChatEditor(document.querySelector('[role="textbox"]') as HTMLElement).text).toBe('【图片1】 【视频2】');
  await expect.element(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.screenshot({ path: `/tmp/chat-composer-${width}.png` });
  await page.getByRole('button', { name: '移除附件 界面截图.png' }).click();
  await expect.element(page.getByRole('button', { name: '移除附件 界面截图.png' })).not.toBeInTheDocument();
});
it('keeps the member picker above the composer and selects without sending', async () => {
  useSessionDirectoryStore.getState().replace([{ sessionId: 'worker', name: '设计助手', customName: true, cwd: '/project/ui', lastActivity: 1, agent: { slug: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null } }]);
  await mount(); await page.getByRole('button', { name: '提及协作成员' }).click();
  await expect.element(page.getByRole('option')).toBeVisible();
  const menu = document.querySelector('[role="listbox"]')!.getBoundingClientRect(), composer = document.querySelector('[data-chat-composer]')!.getBoundingClientRect();
  expect(menu.top).toBeGreaterThanOrEqual(0); expect(menu.bottom).toBeLessThanOrEqual(composer.top);
  await commands.touchDrag('[role="listbox"]', -160, 2); expect(swiper?.activeIndex).toBe(0);
  await page.screenshot({ path: '/tmp/chat-composer-mentions.png' });
  await page.getByRole('option').click();
  await expect.element(page.getByRole('listbox')).not.toBeInTheDocument();
  expect(readChatEditor(document.querySelector('[role="textbox"]') as HTMLElement).text).toContain('设计助手');
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('renders independent inline attachment chips between editable prose', async () => {
  const files = [{ path: '/tmp/a.png', name: '第一张.png', type: 'image/png', reference: '图片1' }, { path: '/tmp/b.png', name: '第二张.png', type: 'image/png', reference: '图片2' }];
  const text = '请对比这张【图片1】与这张【图片2】，说明差别。';
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:draft`, text);
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:extras`, composeChatDraft(text, files, []));
  await mount(); const editor = document.querySelector('[role="textbox"]') as HTMLElement;
  expect(readChatEditor(editor).text).toBe(text);
  expect(editor.querySelectorAll('[data-chat-inline-token][contenteditable="false"]')).toHaveLength(2);
  expect(editor.getBoundingClientRect().width).toBeGreaterThan(document.querySelector('[data-chat-composer]')!.clientWidth * .9);
  await page.screenshot({ path: '/tmp/chat-composer-inline.png' });
  await page.getByRole('textbox').fill(text.repeat(15)); await frame();
  expect(editor.scrollHeight).toBeGreaterThan(editor.clientHeight);
  expect(readChatEditor(editor).text).toBe(text.repeat(15));
});
it('uses the mobile return key for a newline and the send button for sending', async () => {
  await mount(); await page.getByRole('textbox').fill('第一行');
  await userEvent.keyboard('{End}{Enter}');
  expect(readChatEditor(document.querySelector('[role="textbox"]') as HTMLElement).text).toBe('第一行\n');
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
