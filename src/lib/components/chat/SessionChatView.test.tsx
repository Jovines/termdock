// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionChatView } from './SessionChatView';
vi.mock('../markdown/MarkdownPreview', () => ({ MarkdownPreview: ({ content }: { content: string }) => <p>{content}</p> }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
it('preserves unsent text and reuses an idempotency key after an ambiguous network failure', async () => {
  const posts: { content: string; requestId: string }[] = [];
  const fetch = vi.fn(async (_url, init?: RequestInit) => {
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); posts.push(body); if (posts.length === 1) throw new Error('网络中断'); return Response.json({ id: 'sent', createdAt: Date.now(), status: 'pending' }); }
    return Response.json({ agentAvailable: true, messages: [] });
  });
  vi.stubGlobal('fetch', fetch);
  render(<SessionChatView sessionId="one" onTerminal={() => {}} />);
  await waitFor(() => expect(screen.queryByText('正在读取对话…')).toBeNull());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '请解释结果' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '重试发送' });
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('请解释结果');
  fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
  await waitFor(() => expect(posts).toHaveLength(2)); expect(posts[0].requestId).toBe(posts[1].requestId);
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''));
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
  await screen.findByText('思考中…');
  expect(screen.getByRole('status', { name: 'Codex思考中' })).toBeTruthy();
  messages = [...messages, { id: 'a1', role: 'assistant', content: '先整理资料', createdAt: 2, status: 'stored', replyTo: 'u', responseKind: 'progress' } as typeof messages[number]];
  fireEvent(window, new Event('online')); await screen.findByText('先整理资料'); expect(screen.getByText('思考中…')).toBeTruthy();
  messages = [...messages, { id: 'a2', role: 'assistant', content: '这是结果', createdAt: 3, status: 'stored', replyTo: 'u', responseKind: 'result' } as typeof messages[number]];
  fireEvent(window, new Event('online')); await screen.findByText('这是结果');
  await waitFor(() => expect(screen.queryByText('思考中…')).toBeNull());
  expect(container.querySelectorAll('[data-chat-turn="assistant"]')).toHaveLength(1);
  const bodies = container.querySelectorAll('[data-chat-turn="assistant"] [data-chat-message]');
  expect(bodies).toHaveLength(2);
  expect(bodies[0].querySelector('[data-chat-continuation]')).toBeNull();
  expect(bodies[1].querySelector('[data-chat-continuation] time')?.getAttribute('datetime')).toBe(new Date(3).toISOString());
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
