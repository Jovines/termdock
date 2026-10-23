// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearChatSnapshots } from './chatSnapshot';
import { AppFeedbackHost } from '../ui/AppFeedback';
import { SECURE_READY_EVENT } from '../../federation/connectionRecovery';
const markdownRender = vi.hoisted(() => vi.fn());
import type { ChatMessage } from './chatMessages';
import { SessionChatView } from './SessionChatView';
vi.mock('../markdown/Markdown', () => ({ Markdown: ({ content }: { content: string }) => { markdownRender(content); return <p data-testid="chat-markdown">{content}</p>; } }));
afterEach(() => { cleanup(); clearChatSnapshots(); sessionStorage.clear(); markdownRender.mockClear(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function pagedHistory(url: unknown, all: ChatMessage[]) {
  const params = new URL(String(url), location.origin).searchParams;
  const before = params.get('before'), after = params.get('after');
  const at = all.findIndex(message => message.id === (before || after));
  const end = before ? at : after ? Math.min(all.length, at + 31) : all.length;
  const start = after ? at + 1 : Math.max(0, end - 30);
  return Response.json({ agentAvailable: true, messages: all.slice(start, end), updates: after ? all.slice(Math.max(0, at - 29), at + 1) : undefined, page: { hasOlder: start > 0, hasNewer: end < all.length, mode: before ? 'before' : after ? 'after' : 'latest' } });
}

it('presents its loading UI without waiting for a hidden terminal or stalled history request', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  const ready = vi.fn();
  const view = render(<SessionChatView sessionId="startup-history" onReadyChange={ready} onTerminal={() => {}} />);
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(ready).toHaveBeenLastCalledWith(true);
  view.unmount();
  expect(ready).toHaveBeenLastCalledWith(false);
});

it('dismisses the selection toolbar when the selection collapses, clears, moves outside or spans messages', async () => {
  const messages = ['第一条消息', '第二条消息'].map((content, index) => ({ id: `a${index}`, role: 'assistant', content, createdAt: index + 1, status: 'stored' }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages })));
  render(<><SessionChatView sessionId="selection" onTerminal={() => {}} /><p>会话外的文字</p></>);
  // A real Selection must target the loaded renderer, not a Suspense fallback
  // text node that can be detached as the lazy Markdown module resolves.
  await waitFor(() => expect(screen.getAllByTestId('chat-markdown')).toHaveLength(2));
  const first = screen.getByText('第一条消息'), second = screen.getByText('第二条消息'), outside = screen.getByText('会话外的文字');
  const selection = window.getSelection()!;
  const select = (element: Element) => act(() => {
    const range = document.createRange(); range.selectNodeContents(element);
    selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange'));
  });
  const toolbar = () => screen.queryByRole('button', { name: '引用选中内容' });
  select(first); expect(toolbar()).toBeTruthy();
  act(() => { selection.collapseToEnd(); document.dispatchEvent(new Event('selectionchange')); });
  expect(toolbar()).toBeNull();
  select(first);
  act(() => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
  expect(toolbar()).toBeNull();
  select(first); select(outside); expect(toolbar()).toBeNull();
  select(first);
  act(() => {
    const range = document.createRange(); range.setStart(first.firstChild!, 0); range.setEnd(second.firstChild!, 2);
    selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange'));
  });
  expect(toolbar()).toBeNull();
  act(() => selection.removeAllRanges());
});
it('keeps an explicitly added quote in the composer after its text selection is cleared', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages: [{ id: 'a', role: 'assistant', content: '需要引用的原话', createdAt: 1, status: 'stored' }] })));
  render(<SessionChatView sessionId="selected-quote" onTerminal={() => {}} />);
  const text = await screen.findByTestId('chat-markdown');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '请解释这一句' } });
  act(() => {
    const range = document.createRange(); range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
  });
  const quote = screen.getByRole('button', { name: '引用选中内容' });
  fireEvent.pointerDown(quote); fireEvent.click(quote);
  act(() => document.dispatchEvent(new Event('selectionchange')));
  expect(screen.queryByRole('button', { name: '引用选中内容' })).toBeNull();
  expect(screen.getByRole('button', { name: '移除消息引用' })).toBeTruthy();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('请解释这一句');
});
it('retains a failed message across remounts and restores it for editing', async () => {
  const posts: { content: string; requestId: string }[] = [];
  const fetch = vi.fn(async (_url, init?: RequestInit) => {
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); posts.push(body); if (posts.length === 1) throw new Error('网络中断'); return Response.json({ id: 'sent', createdAt: Date.now(), status: 'pending' }); }
    return Response.json({ agentAvailable: true, messages: [] });
  });
  vi.stubGlobal('fetch', fetch);
  const { unmount } = render(<SessionChatView sessionId="one" onTerminal={() => {}} />);
  await waitFor(() => expect(screen.queryByText('正在读取对话…')).toBeNull());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '请解释结果' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '重试发送' });
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  expect(screen.getByText('请解释结果')).toBeTruthy();
  expect(JSON.parse(sessionStorage.getItem(`termdock:chat:${location.origin}:one:pending`) || 'null')?.content).toBe('请解释结果');
  unmount();
  render(<SessionChatView sessionId="one" onTerminal={() => {}} />);
  await screen.findByRole('button', { name: '重试发送' });
  expect(screen.getByText('请解释结果')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '修改草稿' }));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('请解释结果');
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(posts).toHaveLength(2));
});
it('retries the retained message without clearing a new draft', async () => {
  const posts: { content: string; requestId: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (posts.length === 1) throw new Error('网络中断');
      return Response.json({ id: 'sent', status: 'pending' });
    }
    return Response.json({ agentAvailable: true, messages: [] });
  }));
  render(<SessionChatView sessionId="retry" onTerminal={() => {}} />);
  await screen.findByText('想一起完成什么？');
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '请解释结果' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '重试发送' });
  fireEvent.change(input, { target: { value: '下一条补充' } });
  fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
  await waitFor(() => expect(posts).toHaveLength(2)); expect(posts[0].requestId).toBe(posts[1].requestId);
  await waitFor(() => expect(screen.queryByText('发送中…')).toBeNull());
  expect(input.value).toBe('下一条补充');
});
it('clears the composer and quote immediately while preserving an identical next draft after acknowledgement', async () => {
  let acknowledge!: (response: Response) => void;
  const posts: { content: string; requestId: string }[] = [];
  const messages = [{ id: 'a', role: 'assistant', content: '需要解释的原话', createdAt: 1, status: 'stored' }];
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Promise<Response>(resolve => { acknowledge = resolve; });
    }
    return Response.json({ agentAvailable: true, agent: { displayName: 'Codex' }, messages });
  }));
  render(<SessionChatView sessionId="delayed" onTerminal={() => {}} />);
  await screen.findByText('需要解释的原话');
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '请解释' } });
  fireEvent.click(screen.getByRole('button', { name: '引用消息' }));
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input.value).toBe('');
  expect(screen.queryByRole('button', { name: '移除消息引用' })).toBeNull();
  expect(screen.getByText('发送中…')).toBeTruthy();
  expect(posts[0].content).toContain('需要解释的原话');
  fireEvent.change(input, { target: { value: '请解释' } });
  fireEvent.click(screen.getByRole('button', { name: '引用消息' }));
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(posts).toHaveLength(1);
  await act(async () => acknowledge(Response.json({ id: 'sent', status: 'pending' })));
  expect(input.value).toBe('请解释');
  expect(screen.getByRole('button', { name: '移除消息引用' })).toBeTruthy();
});
it('routes references into the active chat draft and acknowledges without sending terminal input', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages: [] })));
  render(<SessionChatView sessionId="one" onTerminal={() => {}} />); await screen.findByText('想一起完成什么？');
  const ack = vi.fn(), terminal = vi.fn(); window.addEventListener('termdock-insert-reference-ack', ack); window.addEventListener('termdock-insert-reference', terminal);
  fireEvent(window, new CustomEvent('termdock-insert-reference', { detail: { text: '/tmp/shared/spec.md', sessionId: 'one', nonce: 'ref' } }));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('/tmp/shared/spec.md'); expect(ack.mock.calls[0][0].detail).toEqual({ nonce: 'ref', ok: true }); expect(terminal).not.toHaveBeenCalled();
  window.removeEventListener('termdock-insert-reference-ack', ack); window.removeEventListener('termdock-insert-reference', terminal);
});
it('keeps read-only recipients from sending or accepting references', async () => {
  const fetch = vi.fn(async () => Response.json({ agentAvailable: true, messages: [] })); vi.stubGlobal('fetch', fetch);
  render(<SessionChatView sessionId="readonly" canWrite={false} onTerminal={() => {}} />); await screen.findByText('想一起完成什么？');
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true); expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true);
});

it('keeps reply feedback through progress, renders consecutive updates together, and clears it on the final reply', async () => {
  let messages = [{ id: 'u', role: 'user', content: '帮我整理', createdAt: 1, status: 'delivered' }];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, agent: { slug: 'codex', displayName: 'Codex' }, messages })));
  const { container } = render(<SessionChatView sessionId="waiting" onTerminal={() => {}} />);
  await screen.findByText('工作中…');
  expect(screen.getByRole('status', { name: 'Codex工作中' })).toBeTruthy();
  messages = [...messages, { id: 'a1', role: 'assistant', content: '先整理资料', createdAt: 2, status: 'stored', replyTo: 'u', responseKind: 'progress' } as typeof messages[number]];
  fireEvent(window, new Event('online')); await screen.findByText('先整理资料'); expect(screen.getByText('工作中…')).toBeTruthy();
  messages = [...messages, { id: 'a2', role: 'assistant', content: '这是结果', createdAt: 3, status: 'stored', replyTo: 'u', responseKind: 'result' } as typeof messages[number]];
  fireEvent(window, new Event('online')); await screen.findByText('这是结果');
  await waitFor(() => expect(screen.queryByText('工作中…')).toBeNull());
  expect(container.querySelectorAll('[data-chat-turn="assistant"]')).toHaveLength(1);
  const bodies = container.querySelectorAll('[data-chat-turn="assistant"] [data-chat-message]');
  expect(bodies).toHaveLength(2);
  expect(container.querySelector('[data-chat-continuation]')).toBeNull();
  expect(bodies[0].querySelector('time')?.getAttribute('datetime')).toBe(new Date(2).toISOString());
  expect(bodies[1].querySelector('time')?.getAttribute('datetime')).toBe(new Date(3).toISOString());
  expect(screen.getAllByRole('button', { name: '复制回复' })).toHaveLength(2);
  for (const body of bodies) expect(body.querySelector('[data-chat-message-actions] button[aria-label="引用消息"]')).toBeTruthy();
});

it('sends with Enter, keeps Shift+Enter for newlines, and never sends IME confirmation', async () => {
  const post = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => { if (init?.method === 'POST') { post(JSON.parse(String(init.body))); return Response.json({ id: 'sent', status: 'pending' }); } return Response.json({ agentAvailable: true, messages: [] }); }));
  render(<SessionChatView sessionId="keyboard" onTerminal={() => {}} />); await screen.findByText('想一起完成什么？');
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: '中文消息' } });
  expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 }); expect(post).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' }); await waitFor(() => expect(post).toHaveBeenCalledOnce()); expect(post.mock.calls[0][0].content).toBe('中文消息');
});
it('quotes a message without sending it, preserves the draft, and persists the quote in the submitted text', async () => {
  const posts: { content: string }[] = [];
  const messages = [{ id: 'a', role: 'assistant', content: '这里是需要解释的原话', createdAt: 1, status: 'stored' }];
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => { if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return Response.json({ id: 'u', status: 'pending' }); } return Response.json({ agentAvailable: true, agent: { displayName: 'Codex' }, messages }); }));
  render(<SessionChatView sessionId="quote" onTerminal={() => {}} />); await screen.findByText('这里是需要解释的原话'); expect(screen.getByText('Codex')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '请解释这句话' } }); fireEvent.click(screen.getByRole('button', { name: '引用消息' }));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('请解释这句话'); expect(posts).toHaveLength(0);
  expect(screen.getByRole('button', { name: '移除消息引用' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '发送消息' })); await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].content).toContain('> Codex'); expect(posts[0].content).toContain('> 这里是需要解释的原话'); expect(posts[0].content).toContain('请解释这句话');
});
it('replaces the current draft selection when inserting an existing file reference', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages: [] })));
  render(<SessionChatView sessionId="caret" onTerminal={() => {}} />); await screen.findByText('想一起完成什么？');
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '前文替换后文' } }); input.setSelectionRange(2, 4);
  fireEvent(window, new CustomEvent('termdock-insert-reference', { detail: { text: '/tmp/spec.md ', sessionId: 'caret', nonce: 'ref', focus: false } }));
  expect(input.value).toBe('前文/tmp/spec.md 后文');
});

it('does not render history again while typing a draft', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages: [{ id: 'reply', role: 'assistant', content: '已完成的回复', createdAt: 1, status: 'stored' }] })));
  render(<SessionChatView sessionId="memo-history" onTerminal={() => {}} />);
  await screen.findByTestId('chat-markdown');
  const renders = markdownRender.mock.calls.length;
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '新的草稿' } });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '新的草稿继续输入' } });
  expect(markdownRender).toHaveBeenCalledTimes(renders);
});

it('requests only the recent page, prefetches older messages on scroll, and preserves the reading anchor', async () => {
  const messages: ChatMessage[] = Array.from({ length: 130 }, (_, index) => ({ id: `history-${index}`, sequence: index + 1, role: 'user', content: `历史消息 ${index}`, createdAt: index + 1, status: 'stored' }));
  const fetch = vi.fn(async (url: unknown) => pagedHistory(url, messages)); vi.stubGlobal('fetch', fetch);
  const { container } = render(<SessionChatView sessionId="long-history" onTerminal={() => {}} />);
  await screen.findByText('历史消息 129');
  expect(container.querySelectorAll('[data-chat-message]')).toHaveLength(30);
  expect(screen.queryByText('历史消息 99')).toBeNull();
  expect(new URL(String(fetch.mock.calls[0][0]), location.origin).searchParams.get('limit')).toBe('30');
  const scroller = container.querySelector('.session-chat > div') as HTMLElement;
  Object.defineProperty(scroller, 'clientHeight', { value: 500 });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => container.querySelectorAll('[data-chat-message]').length * 100 });
  scroller.scrollTop = 200; fireEvent.scroll(scroller);
  await screen.findByText('历史消息 70');
  expect(container.querySelectorAll('[data-chat-message]')).toHaveLength(60);
  expect(scroller.scrollTop).toBe(3200);
  scroller.scrollTop = 100; fireEvent.scroll(scroller);
  await screen.findByText('历史消息 40');
  expect(container.querySelectorAll('[data-chat-message]')).toHaveLength(90);
  expect(scroller.scrollTop).toBe(3100);
  expect(screen.queryByRole('button', { name: /查看更早的消息/ })).toBeNull();
});

it('restores a recently unmounted conversation and reading position while revalidation is stalled', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages: [{ id: 'kept', role: 'assistant', content: '返回时保留这段对话', createdAt: 1, status: 'stored' }] })));
  const first = render(<SessionChatView sessionId="restore-history" onTerminal={() => {}} />);
  await screen.findByTestId('chat-markdown');
  const scroller = first.container.querySelector('.session-chat > div') as HTMLElement;
  Object.defineProperty(scroller, 'clientHeight', { value: 500 });
  Object.defineProperty(scroller, 'scrollHeight', { value: 2000 });
  scroller.scrollTop = 320; fireEvent.scroll(scroller); first.unmount();
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  const second = render(<SessionChatView sessionId="restore-history" onTerminal={() => {}} />);
  expect(screen.getByText('返回时保留这段对话')).toBeTruthy();
  expect(screen.queryByText('正在读取对话…')).toBeNull();
  expect((second.container.querySelector('.session-chat > div') as HTMLElement).scrollTop).toBe(320);
});

it('does not show the welcome state when the first history request fails', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json({ messages: [], agentAvailable: true }));
  vi.stubGlobal('fetch', fetch);
  render(<><AppFeedbackHost /><SessionChatView sessionId="failed-history" onTerminal={() => {}} /></>);
  await act(async () => {});
  expect(screen.queryByText('想一起完成什么？')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(2500));
  expect(screen.getByText('正在恢复对话同步…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull();
  await act(async () => { window.dispatchEvent(new Event(SECURE_READY_EVENT)); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('正在恢复对话同步…')).toBeNull();
  expect(screen.getByText('想一起完成什么？')).toBeTruthy();
});

it('keeps a failed send actionable when background history refresh succeeds', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (_url, init?: RequestInit) => {
    if (init?.method === 'POST') throw new TypeError('Failed to fetch');
    return Response.json({ agentAvailable: true, messages: [] });
  });
  vi.stubGlobal('fetch', fetch);
  render(<><AppFeedbackHost /><SessionChatView sessionId="send-sync-failure" onTerminal={() => {}} /></>);
  await act(async () => {});
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '需要重试的消息' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('发送失败');
  await act(async () => { window.dispatchEvent(new Event(SECURE_READY_EVENT)); });
  expect(screen.getByRole('alert').textContent).toContain('发送失败');
  expect(screen.getByRole('button', { name: '重试发送' })).toBeTruthy();
  expect(screen.getByText('需要重试的消息')).toBeTruthy();
});

it('ignores a response from the previous session and keeps drafts separate', async () => {
  let resolveOld!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('old-session') ? new Promise<Response>(resolve => { resolveOld = resolve; }) : Promise.resolve(Response.json({ agentAvailable: true, messages: [] }))));
  const view = render(<SessionChatView sessionId="old-session" onTerminal={() => {}} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '原会话的草稿' } });
  view.rerender(<SessionChatView sessionId="new-session" onTerminal={() => {}} />);
  await screen.findByText('想一起完成什么？');
  await act(async () => resolveOld(Response.json({ agentAvailable: true, messages: [{ id: 'old', role: 'user', content: '过期响应', status: 'stored', createdAt: 1 }] })));
  expect(screen.queryByText('过期响应')).toBeNull();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
});

it('keeps the first visible row when new replies arrive during history reading', async () => {
  let messages: ChatMessage[] = Array.from({ length: 80 }, (_, index) => ({ id: `live-${index}`, role: 'user', content: `持续对话 ${index}`, createdAt: index + 1, status: 'stored' }));
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => pagedHistory(url, messages)));
  const { container } = render(<SessionChatView sessionId="live-reading" onTerminal={() => {}} />);
  await screen.findByText('持续对话 79');
  const scroller = container.querySelector('.session-chat > div') as HTMLElement;
  Object.defineProperty(scroller, 'clientHeight', { value: 500 });
  Object.defineProperty(scroller, 'scrollHeight', { value: 5000 });
  scroller.scrollTop = 900; fireEvent.scroll(scroller);
  messages = [...messages, { id: 'next', role: 'assistant', content: '新到达的回复', createdAt: 100, status: 'stored' }];
  fireEvent(window, new Event('online')); await screen.findByText('新到达的回复');
  expect(container.querySelector('[data-chat-message]')?.getAttribute('data-chat-message')).toBe('live-50');
  expect(scroller.scrollTop).toBe(900);
});

it('backs off failed polling and stops all background requests when inactive', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => { throw new Error('offline'); }); vi.stubGlobal('fetch', fetch);
  const view = render(<SessionChatView sessionId="backoff" onTerminal={() => {}} />);
  await act(async () => {}); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); }); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<SessionChatView sessionId="backoff" active={false} onTerminal={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); }); expect(fetch).toHaveBeenCalledTimes(2);
});

it('acknowledges an earlier pending request and retains reply feedback when only later progress fits in the page', async () => {
  const requestId = 'pending-outside-current-page';
  sessionStorage.setItem(`termdock:chat:${location.origin}:paged-pending:pending`, JSON.stringify({ content: '已经送达的原请求', requestId, createdAt: 1 }));
  const messages = Array.from({ length: 30 }, (_, index) => ({ id: `progress-${index}`, role: 'assistant', content: `正在处理第 ${index} 步`, createdAt: index + 2, status: 'stored', responseKind: 'progress' }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages, confirmedRequestId: requestId, replyPending: true, page: { mode: 'latest', hasOlder: true, hasNewer: false } })));
  render(<SessionChatView sessionId="paged-pending" onTerminal={() => {}} />);
  await screen.findByText('工作中…');
  expect(screen.queryByText('已经送达的原请求')).toBeNull();
  expect(screen.queryByRole('button', { name: '重试发送' })).toBeNull();
});
