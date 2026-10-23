import { describe, expect, it } from 'vitest';
import { chatTurns, hasUnansweredMessage, type ChatMessage } from './chatMessages';
const user: ChatMessage = { id: 'u', role: 'user', content: '问题', createdAt: 1, status: 'delivered' };
const reply = (id: string, responseKind: string): ChatMessage => ({ id, role: 'assistant', content: id, createdAt: 2, status: 'stored', replyTo: 'u', responseKind });
describe('chat reading and reply feedback', () => {
  it('groups adjacent assistant updates while preserving text, order, and user boundaries', () => {
    const messages = [user, reply('a1', 'progress'), reply('a2', 'result'), { ...user, id: 'u2' }, reply('a3', 'result')];
    const turns = chatTurns(messages);
    expect(turns.map(turn => turn.messages.map(message => message.id))).toEqual([['u'], ['a1', 'a2'], ['u2'], ['a3']]);
    expect(messages).toHaveLength(5);
  });
  it('keeps waiting through acknowledgments and progress until a matching final reply', () => {
    expect(hasUnansweredMessage([])).toBe(false);
    expect(hasUnansweredMessage([user])).toBe(true);
    expect(hasUnansweredMessage([user, reply('a1', 'ack'), reply('a2', 'progress')])).toBe(true);
    expect(hasUnansweredMessage([user, { ...reply('other', 'result'), replyTo: 'older' }])).toBe(true);
    expect(hasUnansweredMessage([user, reply('a3', 'result')])).toBe(false);
    expect(hasUnansweredMessage([{ ...user, status: 'failed' }])).toBe(false);
    expect(hasUnansweredMessage([user, reply('a3', 'result'), { ...user, id: 'next' }])).toBe(true);
  });
});
