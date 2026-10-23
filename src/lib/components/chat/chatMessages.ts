export interface ChatMessage {
  id: string; role: 'user' | 'assistant'; content: string; createdAt: number; status: string;
  replyTo?: string; requestId?: string; responseKind?: string;
}
export interface ChatTurn { id: string; role: ChatMessage['role']; messages: ChatMessage[] }
/** Adjacent assistant updates read as one turn, with one author and action row. */
export function chatTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    const previous = turns[turns.length - 1];
    if (message.role === 'assistant' && previous?.role === 'assistant') previous.messages.push(message);
    else turns.push({ id: message.id, role: message.role, messages: [message] });
  }
  return turns;
}
/** This observes an unanswered message, never the Agent's internal activity. */
export function hasUnansweredMessage(messages: ChatMessage[]): boolean {
  const last = messages.slice().reverse().find(message => message.role === 'user');
  if (!last || ['failed', 'expired'].includes(last.status)) return false;
  return !messages.some(message => message.role === 'assistant' && message.replyTo === last.id && !['ack', 'progress'].includes(message.responseKind || ''));
}
export function chatSendStatus(status: string): string {
  return ({ pending: '已发送', delivered: '已发送', stored: '已发送', failed: '发送失败', expired: '发送失败' }[status] || '待确认');
}
