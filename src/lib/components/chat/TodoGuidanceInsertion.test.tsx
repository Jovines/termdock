// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionChatView } from './SessionChatView';
import { requestReferenceInsertion } from '../sidebar/requestReferenceInsertion';
import { TODO_GUIDANCE } from '../../todos/guidance';
import { clearChatSnapshots } from './chatSnapshot';
afterEach(() => { cleanup(); clearChatSnapshots(); sessionStorage.clear(); vi.unstubAllGlobals(); });
it('inserts the short guidance at the caret, preserves surrounding text and never posts a chat message', async () => {
  const fetch = vi.fn(async () => Response.json({ agentAvailable: true, messages: [] })); vi.stubGlobal('fetch', fetch);
  render(<SessionChatView sessionId="todo-inline-guidance" onTerminal={() => {}} />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '前半句后半句' } }); input.setSelectionRange(3, 3);
  await act(async () => expect(await requestReferenceInsertion(` ${TODO_GUIDANCE} `, 'todo-inline-guidance', () => true, input, { paste: true, submitAfterPaste: false, focus: true })).toBe(true));
  expect(input.value).toBe(`前半句 ${TODO_GUIDANCE} 后半句`);
  await waitFor(() => expect(input.selectionStart).toBe(3 + TODO_GUIDANCE.length + 2));
  expect(fetch.mock.calls.some(call => (call as unknown[])[1] && ((call as unknown[])[1] as RequestInit).method === 'POST')).toBe(false);
});
