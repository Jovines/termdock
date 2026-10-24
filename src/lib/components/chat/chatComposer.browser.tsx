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
import { readChatEditor, setChatEditorCaret } from './ChatRichEditor';
import { useSessionDirectoryStore } from '../../stores/useSessionDirectory';
vi.mock('../../terminal/api', async original => ({ ...await original<typeof import('../../terminal/api')>(),
  listCollaborationGroups: async () => ({ groups: [{ id: 'team', name: '界面打磨', sessionIds: ['browser-composer', 'worker'] }], sessions: [] }),
  subscribeCollaborationGroups: () => () => {},
  uploadFiles: async () => ({ files: [{ path: '/tmp/pasted.png' }] }),
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

it.each([390, 1280])('keeps inline attachments in place through sending at width %i', async width => {
  await page.viewport(width, 844);
  const files = [{ path: '/tmp/one.png', name: '截图.png', type: 'image/png', reference: '图片1' }];
  const text = '请看【图片1】这里的间距';
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:draft`, text);
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:extras`, composeChatDraft(text, files, []));
  await mount();
  const editor = document.querySelector('[role="textbox"]') as HTMLElement;
  const chip = editor.querySelector<HTMLElement>('[data-chat-inline-token]')!;
  const before = chip.getBoundingClientRect(), beforeFont = getComputedStyle(chip).fontSize;
  const saved: object[] = [];
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      const { content } = JSON.parse(String(init.body));
      const message = { id: 'sent-inline', role: 'user', content, createdAt: Date.now(), status: 'delivered' };
      saved.push(message);
      return Response.json(message);
    }
    return Response.json({ agentAvailable: true, messages: saved });
  });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.element(page.getByRole('group', { name: '附件 图片1 · 截图.png' })).toBeVisible();
  const bubble = document.querySelector('[data-chat-user-bubble]')!;
  const sentChip = bubble.querySelector<HTMLElement>('[data-chat-inline-token]')!;
  expect(sentChip.previousSibling?.textContent).toBe('请看');
  expect(sentChip.nextSibling?.textContent).toBe('这里的间距');
  expect(bubble.querySelector('ul')).toBeNull();
  expect(sentChip.getBoundingClientRect().height).toBe(before.height);
  expect(getComputedStyle(sentChip).fontSize).toBe(beforeFont);
  expect(document.querySelector('.session-chat-scroll')!.scrollWidth).toBe(document.querySelector('.session-chat-scroll')!.clientWidth);
  await page.screenshot({ path: `/tmp/chat-inline-sent-${width}.png` });
});

it.each([390, 1280])('previews a picture while editing and after sending at width %i', async width => {
  await page.viewport(width, 844);
  const files = [{ path: '/tmp/preview.png', name: '预览图.png', type: 'image/png', reference: '图片1' }];
  const text = '看看【图片1】间距';
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:draft`, text);
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:extras`, composeChatDraft(text, files, []));
  await mount();
  const saved: object[] = [];
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/api/terminal/fs/blob?')) {
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv10AAAAASUVORK5CYII='), char => char.charCodeAt(0));
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    }
    if (init?.method === 'POST') {
      const { content } = JSON.parse(String(init.body));
      const message = { id: 'preview-sent', role: 'user', content, createdAt: Date.now(), status: 'delivered' };
      saved.push(message); return Response.json(message);
    }
    return Response.json({ agentAvailable: true, messages: saved });
  });
  const editor = document.querySelector('[role="textbox"]') as HTMLElement;
  editor.focus();
  (document.querySelector('[aria-label="预览图片 预览图.png"]') as HTMLButtonElement).focus();
  await userEvent.keyboard('{Enter}');
  expect(saved).toHaveLength(0);
  await expect.element(page.getByRole('img', { name: '预览图.png' })).toBeVisible();
  expect(document.querySelector('[data-markdown-image-lightbox] img')?.getAttribute('src')).toMatch(/^blob:/);
  await page.getByRole('button', { name: 'Close image preview' }).click();
  expect(readChatEditor(editor).text).toBe(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => document.querySelector('[data-chat-user-bubble]')).not.toBeNull();
  await page.getByRole('button', { name: '预览图片 预览图.png' }).click();
  await expect.element(page.getByRole('img', { name: '预览图.png' })).toBeVisible();
  await page.screenshot({ path: `/tmp/chat-image-preview-${width}.png` });
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => document.querySelector('[data-markdown-image-lightbox]')).toBeNull();
  expect(saved).toHaveLength(1);
});

it.each([390, 1280])('removes a pasted image with a single Backspace at width %i', async width => {
  await page.viewport(width, 844); await mount();
  const editor = document.querySelector('[role="textbox"]') as HTMLElement;
  editor.focus();
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File(['image'], '很长的截图文件名.png', { type: 'image/png' }));
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  await expect.element(page.getByRole('button', { name: /移除附件 termdock-clipboard-/ })).toBeVisible();
  await expect.poll(() => readChatEditor(editor).end).toBe('【图片1】 '.length);
  await userEvent.keyboard('{Backspace}');
  await expect.poll(() => editor.querySelector('[data-chat-inline-token]')).toBeNull();
  expect(readChatEditor(editor)).toMatchObject({ text: '', start: 0, end: 0 });
  await expect.element(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
});

it.each([
  { text: '前【图片1】 后', at: '前【图片1】 '.length, key: 'Backspace', expected: '前后', caret: 1, chips: 0 },
  { text: '【图片1】文字', at: '【图片1】文'.length, key: 'Backspace', expected: '【图片1】字', caret: '【图片1】'.length, chips: 1 },
  { text: '【图片1】【图片1】', at: '【图片1】【图片1】'.length, key: 'Backspace', expected: '【图片1】', caret: '【图片1】'.length, chips: 1 },
  { text: '前【图片1】后', at: 1, key: 'Delete', expected: '前后', caret: 1, chips: 0 },
  { text: '【图片1】 ', at: '【图片1】 '.length, key: 'deleteContentBackward', expected: '', caret: 0, chips: 0 },
])('deletes inline chips or adjacent text predictably: $text / $key', async ({ text, at, key, expected, caret, chips }) => {
  const files = [{ path: '/tmp/one.png', name: '一个很长的图片文件名.png', reference: '图片1' }];
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:draft`, text);
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:extras`, composeChatDraft(text, files, []));
  await mount(); const editor = document.querySelector('[role="textbox"]') as HTMLElement;
  expect(editor.querySelector('[data-chat-inline-token]')?.textContent).toBe('图片1');
  editor.focus(); setChatEditorCaret(editor, at);
  if (key === 'deleteContentBackward') {
    const event = new InputEvent('beforeinput', { inputType: key, bubbles: true, cancelable: true });
    editor.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  } else await userEvent.keyboard(`{${key}}`);
  await expect.poll(() => readChatEditor(editor).text).toBe(expected);
  expect(readChatEditor(editor)).toMatchObject({ start: caret, end: caret });
  expect(editor.querySelectorAll('[data-chat-inline-token]')).toHaveLength(chips);
});

it.each([390, 1280])('keeps an empty composer the same height through deletion at width %i', async width => {
  await page.viewport(width, 844); await mount();
  const editor = document.querySelector('[role="textbox"]') as HTMLElement;
  editor.focus(); const initialHeight = editor.getBoundingClientRect().height;
  const composer = document.querySelector('[data-chat-composer]')!;
  const composerHeight = composer.getBoundingClientRect().height;
  for (const keys of ['{Backspace}', 'x{Backspace}', '{Backspace}', 'abc{Backspace}{Backspace}{Backspace}', '{Delete}']) {
    await userEvent.keyboard(keys); await frame();
    expect({ html: editor.innerHTML, text: readChatEditor(editor).text, height: editor.getBoundingClientRect().height }).toMatchObject({ text: '', height: initialHeight });
    expect(composer.getBoundingClientRect().height).toBe(composerHeight);
    expect(document.activeElement).toBe(editor);
    await expect.element(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    expect(getComputedStyle(editor, '::before').content).toContain('输入消息');
  }
  await userEvent.keyboard('{Shift>}{Enter}{/Shift}'); await frame();
  expect(readChatEditor(editor).text).toBe('\n');
  expect(editor.getBoundingClientRect().height).toBe(initialHeight + 28);
  await userEvent.keyboard('{Backspace}'); await frame();
  expect(readChatEditor(editor).text).toBe('');
  expect(editor.getBoundingClientRect().height).toBe(initialHeight);
});

it.each([390, 1280])('previews a video in the editor and sent message at width %i', async width => {
  await page.viewport(width, 844);
  const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
  const stream = canvas.captureStream(5), chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const recorded = new Promise<Blob>(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
  recorder.start();
  const drawing = canvas.getContext('2d')!; drawing.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chrome-bg'); drawing.fillRect(0, 0, 160, 90);
  await new Promise(resolve => setTimeout(resolve, 250)); recorder.stop();
  const clip = await recorded; stream.getTracks().forEach(track => track.stop());
  const files = [{ path: '/tmp/recorded-demo.webm', name: '录屏演示.webm', type: 'video/webm', reference: '视频1' }];
  const text = '看看【视频1】这个问题';
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:draft`, text);
  sessionStorage.setItem(`termdock:chat:${location.origin}:browser-composer:extras`, composeChatDraft(text, files, []));
  await mount(); const saved: object[] = [];
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/api/terminal/fs/video?')) return new Response(clip, { headers: { 'Content-Type': 'video/webm' } });
    if (init?.method === 'POST' && String(url).includes('/chat')) {
      const message = { id: 'video-sent', role: 'user', content: JSON.parse(String(init.body)).content, createdAt: Date.now(), status: 'delivered' };
      saved.push(message); return Response.json(message);
    }
    return Response.json({ agentAvailable: true, messages: saved });
  });
  const editor = document.querySelector('[role="textbox"]') as HTMLElement;
  expect(editor.querySelector('[data-chat-inline-token]')?.textContent).toBe('视频1');
  for (const stage of ['editor', 'sent']) {
    await page.getByRole('button', { name: '预览视频 录屏演示.webm' }).click();
    await expect.element(page.getByRole('dialog', { name: '视频预览' })).toBeVisible();
    await expect.poll(() => document.querySelector<HTMLVideoElement>('video')?.readyState, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
    const video = document.querySelector<HTMLVideoElement>('video')!;
    expect(video.src).toMatch(/^blob:/);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => video.paused).toBe(false);
    await page.screenshot({ path: `/tmp/chat-video-${stage}-${width}.png` });
    await page.getByRole('button', { name: '关闭视频预览' }).click();
    if (stage === 'editor') {
      expect(readChatEditor(editor).text).toBe(text);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect.poll(() => document.querySelector('[data-chat-user-bubble]')).not.toBeNull();
      expect(document.querySelector('[data-chat-user-bubble] [data-chat-inline-token]')?.textContent).toBe('视频1');
    }
  }
  expect(saved).toHaveLength(1);
});
