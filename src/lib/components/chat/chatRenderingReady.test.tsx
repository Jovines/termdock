// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { clearChatSnapshots } from './chatSnapshot';
const renderer = vi.hoisted(() => ({ load: vi.fn(), get: vi.fn() }));
vi.mock('./chatRenderers', () => ({ loadChatRichContent: renderer.load, getChatRichContent: renderer.get }));
vi.mock('../markdown/Markdown', () => ({ Markdown: ({ content }: { content: string }) => <p>{content}</p> }));
import { SessionChatView } from './SessionChatView';
afterEach(() => { cleanup(); clearChatSnapshots(); vi.unstubAllGlobals(); });
it('waits for interactive content before showing a reply, without flashing its prose fallback', async () => {
  let ready!: () => void;
  renderer.load.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  renderer.get.mockReturnValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agentAvailable: true, messages: [{ id: 'rich', role: 'assistant', content: '不应闪现的 Markdown 原文', createdAt: 1, status: 'stored', ui: { version: 1, code: 'example' } }] })));
  render(<SessionChatView sessionId="delayed-renderer" onTerminal={() => {}} />);
  await act(async () => {});
  expect(renderer.load).toHaveBeenCalledOnce();
  expect(screen.queryByText('不应闪现的 Markdown 原文')).toBeNull();
  expect(screen.getByRole('status', { name: '正在加载对话' })).toBeTruthy();
  renderer.get.mockReturnValue(() => <table><tbody><tr><td>排版后的表格</td></tr></tbody></table>);
  await act(async () => ready());
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.queryByText('不应闪现的 Markdown 原文')).toBeNull();
});
