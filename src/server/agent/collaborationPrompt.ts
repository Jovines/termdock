import type { CollaborationGroup, CollaborationMessage } from './collaborationStore.js';

interface CollaborationPromptSession {
  sessionId: string;
  agentNativeSessionId?: string | null;
  name: string;
  status: string;
}

const SHELL_RULE = '─'.repeat(30);

/** Body larger than this (in UTF-8 bytes) is replaced by a retrieval pointer
 * instead of being injected into the terminal verbatim. */
const MAX_INLINE_BODY_BYTES = 8_192;

/**
 * Characters that would corrupt the delivery shell `协作消息 · 组「X」` and
 * the per-message `来自:X · kind` line: the quote brackets, the middle dot
 * used as the field delimiter, and control sequences (C0 controls + DEL)
 * that could inject terminal output. Legacy and federated names may carry
 * them, so the render layer neutralizes them defensively; user-entered
 * names are rejected at creation instead.
 */
export const COLLAB_NAME_FORBIDDEN = /[【】「」·\x00-\x1f\x7f]/;

/** Render-safe name for shell header / per-message source lines: reserved
 * bracket and delimiter characters become spaces (they would otherwise split
 * the `协作消息 · 组「X」` and `来自:X · kind` lines), control characters are
 * neutralized, whitespace collapses, and the display length is capped. */
export function sanitizeCollaborationName(name: string, max = 40): string {
  const cleaned = name
    .replace(/[【】「」]/g, ' ')
    .replace(/·/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** A single delivered message: `来自:X · kind` over a fenced body, with the
 * reply route for agent-sourced messages kept outside the fence. */
function formatCollaborationMessage(message: CollaborationMessage, source: string, fence: string): string {
  const lines = [`来自:${source} · ${message.kind}`, '', fence, message.content, fence];
  if (message.task) lines.push('', `任务上报:${JSON.stringify(message.task)}`);
  if (message.fromSessionId) lines.push('', `回复:td collab reply ${message.id} "回复内容" --text`);
  return lines.join('\n');
}

export function formatCollaborationDelivery(input: {
  targetSessionId: string;
  messages: CollaborationMessage[];
  groups: CollaborationGroup[];
  sessions: CollaborationPromptSession[];
  /**
   * false: omit the static routing help (peer roster + `td collab --help`
   * pointer). Dynamic notices (unreachable peers, cross-service keep-alive)
   * are always included — they report current conditions, not education.
   * Callers gate this on a per-session education state keyed by roster.
   */
  showRoutingHelp?: boolean;
}): string {
  const groupsById = new Map(input.groups.map((group) => [group.id, group]));
  const sessionsById = new Map(input.sessions.map((session) => [session.sessionId, session]));

  const blocks: string[] = [];
  for (const message of input.messages) {
    const sourceSession = message.fromSessionId ? sessionsById.get(message.fromSessionId) : null;
    const source = message.fromSessionId
      ? sanitizeCollaborationName(sourceSession?.name ?? message.fromSessionId)
      : '用户';
    const bytes = Buffer.byteLength(message.content);
    const body = bytes > MAX_INLINE_BODY_BYTES
      ? `大消息已完整保存（${bytes} 字节）。使用 td collab message get ${message.id} --json 获取正文；不要把这条提示当作消息正文。`
      : message.content;
    const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length + 1)));
    blocks.push(formatCollaborationMessage({ ...message, content: body }, source, fence));
  }

  // The shell header names the group only when every block belongs to one;
  // a mixed batch keeps the structure but drops the single-group claim.
  const groupIds = [...new Set(input.messages.map((message) => message.groupId))];
  const shellHeader = groupIds.length === 1
    ? ['协作消息', `组「${sanitizeCollaborationName(groupsById.get(groupIds[0]!)?.name ?? '协作组')}」`]
    : ['协作消息'];

  const peerIds = Array.from(new Set(input.groups.flatMap((group) => group.sessionIds)))
    .filter((sessionId) => sessionId !== input.targetSessionId);
  // Keep routing IDs once, only for peers who are not already directly replyable.
  const sourceIds = new Set(input.messages.map((message) => message.fromSessionId));
  const peers = peerIds.filter((id) => !sourceIds.has(id)).map((sessionId) => {
    const session = sessionsById.get(sessionId);
    return `- ${session ? sanitizeCollaborationName(session.name) : '离线会话'}：\`td collab send ${sessionId} "消息内容" --text\``;
  });
  const unreachable = peerIds.filter((id) => sessionsById.get(id)?.status === 'service-unreachable');
  const routingHelp = input.showRoutingHelp === false ? [] : [
    ...(peers.length ? ['联系其他成员：', ...peers] : []),
    '更多操作：`td collab --help`。',
  ];
  const dynamicNotices = [
    ...(peerIds.some((id) => id.startsWith('remote:'))
      ? ['跨服务通信使用 td collab；转发客户端须保持运行，网页或 PWA 暂停后需返回前台继续转发。'] : []),
    ...unreachable.map((id) => {
      const session = sessionsById.get(id);
      return `注意：${session ? sanitizeCollaborationName(session.name) : id} 服务不可达，消息无法送达；仅可排队等待重连。`;
    }),
  ];

  const notes = [...routingHelp, ...dynamicNotices];
  // Notes (education + dynamic notices) live inside the shell, after the last
  // message, so the closing rule still marks the end of the delivered block.
  if (!blocks.length) return notes.join('\n');
  return [SHELL_RULE, ...shellHeader, '', blocks.join('\n\n'), ...(notes.length ? ['', ...notes] : []), SHELL_RULE].join('\n');
}
