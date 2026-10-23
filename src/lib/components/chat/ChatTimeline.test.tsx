// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ChatTimeline, ChatUserMessage } from './ChatTimeline';
import type { ChatMessage } from './chatMessages';
vi.mock('./ChatMarkdown', () => ({ ChatMarkdown: ({ content }: { content: string }) => <p>{content}<a href="#details">资料链接</a></p> }));
vi.mock('./chatRenderers', () => ({ getChatRichContent: () => null }));
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); });
const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '整理资料', createdAt: 1, status: 'delivered' },
  { id: 'a1', role: 'assistant', content: '第一条进展', createdAt: 2, status: 'stored' },
  { id: 'a2', role: 'assistant', content: '第二条进展', createdAt: 3, status: 'stored' },
];
function setup(canWrite = true) {
  const onReference = vi.fn(), onCopy = vi.fn();
  const view = render(<><ChatTimeline messages={messages} agentName="Codex" sessionId="test" uiWritable={canWrite} canWrite={canWrite} copied="" onCopy={onCopy} onReference={onReference} onAction={async () => true} /><button>会话外操作</button></>);
  const message = (id: string) => view.container.querySelector<HTMLElement>(`[data-chat-message="${id}"]`)!;
  return { ...view, message, onCopy, onReference };
}
function tap(element: Element) {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  fireEvent.pointerDown(element); fireEvent.click(element, { detail: 1 });
}
it('keeps consecutive replies individually timed, copyable and quotable under one author', () => {
  const { message, onReference, onCopy } = setup();
  expect(screen.getAllByText('Codex')).toHaveLength(1);
  for (const reply of messages.slice(1)) {
    const body = message(reply.id);
    expect(body.querySelector('time')?.dateTime).toBe(new Date(reply.createdAt).toISOString());
    fireEvent.click(within(body).getByRole('button', { name: '引用消息' }));
    expect(onReference).toHaveBeenLastCalledWith(reply);
    fireEvent.click(within(body).getByRole('button', { name: '复制回复' }));
    expect(onCopy).toHaveBeenLastCalledWith(reply.content, reply.id);
  }
});
it('reveals only the tapped message and dismisses on a second tap, outside interaction or Escape', () => {
  const { message } = setup();
  tap(within(message('a1')).getByText('第一条进展'));
  expect(message('a1').hasAttribute('data-actions-open')).toBe(true);
  tap(within(message('a2')).getByText('第二条进展'));
  expect(message('a1').hasAttribute('data-actions-open')).toBe(false);
  expect(message('a2').hasAttribute('data-actions-open')).toBe(true);
  tap(within(message('a2')).getByText('第二条进展'));
  expect(message('a2').hasAttribute('data-actions-open')).toBe(false);
  tap(within(message('u1')).getByText('整理资料'));
  fireEvent.pointerDown(screen.getByText('会话外操作'));
  expect(message('u1').hasAttribute('data-actions-open')).toBe(false);
  tap(within(message('a1')).getByText('第一条进展'));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(message('a1').hasAttribute('data-actions-open')).toBe(false);
});
it('leaves selected text and embedded controls to their existing interactions', () => {
  const { message, onReference } = setup();
  const body = message('a1');
  tap(within(body).getByRole('link'));
  expect(body.hasAttribute('data-actions-open')).toBe(false);
  const range = document.createRange(); range.selectNodeContents(within(body).getByText('第一条进展'));
  window.getSelection()!.addRange(range);
  tap(within(body).getByText('第一条进展'));
  expect(body.hasAttribute('data-actions-open')).toBe(false);
  window.getSelection()!.removeAllRanges();
  tap(within(body).getByText('第一条进展'));
  fireEvent.click(within(body).getByRole('button', { name: '引用消息' }));
  expect(onReference).toHaveBeenCalledWith(messages[1]);
  expect(body.hasAttribute('data-actions-open')).toBe(false);
});
it('retains copying for read-only recipients and keeps pending retry actions directly available', () => {
  const { message } = setup(false);
  expect(screen.queryByRole('button', { name: '引用消息' })).toBeNull();
  tap(within(message('a1')).getByText('第一条进展'));
  expect(within(message('a1')).getByRole('button', { name: '复制回复' })).toBeTruthy();
  render(<ChatUserMessage content="待发送消息" createdAt={4} status="待重试"><button>重试发送</button></ChatUserMessage>);
  expect(screen.getByRole('button', { name: '重试发送' }).closest('.chat-message-tools')).toBeNull();
});

it('keeps existing reply nodes mounted when earlier or later messages join the same assistant turn', () => {
  const props = { agentName: 'Codex', sessionId: 'stable-group', uiWritable: true, canWrite: true, copied: '', onCopy: vi.fn(), onReference: vi.fn(), onAction: async () => true };
  const view = render(<ChatTimeline {...props} messages={messages.slice(1)} />);
  const first = screen.getByText('第一条进展');
  const earlier: ChatMessage = { id: 'a0', role: 'assistant', content: '更早的进展', createdAt: 0, status: 'stored' };
  view.rerender(<ChatTimeline {...props} messages={[earlier, ...messages.slice(1)]} />);
  expect(screen.getByText('第一条进展')).toBe(first);
  view.rerender(<ChatTimeline {...props} messages={[earlier, ...messages.slice(1), { ...earlier, id: 'a3', content: '新的进展', createdAt: 4 }]} />);
  expect(screen.getByText('第一条进展')).toBe(first);
});
