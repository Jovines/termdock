import { canonicalShortId } from './collaborationProtocol.js';
import { sanitizeCollaborationRole, type CollaborationGroup, type CollaborationMessage } from './collaborationStore.js';

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
 * Characters that would corrupt the delivery shell header `「X」群(N 个成员)`
 * and the per-message `来自:X · kind` line: the quote brackets and the middle
 * dot, which the render layer uses as structure, plus control sequences
 * (C0 controls + DEL) that could inject terminal output. Legacy and federated
 * names may carry them, so the render layer neutralizes them defensively;
 * user-entered names are rejected at creation instead.
 */
export const COLLAB_NAME_FORBIDDEN = /[【】「」·\x00-\x1f\x7f]/;

/** Render-safe name for shell header / per-message source lines: reserved
 * bracket and delimiter characters become spaces (they would otherwise split
 * the `「X」群` and `来自:X · kind` lines), control characters are
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

/** The id form a delivery shows and the confirm gate searches for, per message.
 *  Canonical UUIDs shorten to their SHORT_ID_LENGTH prefix (a 36-character id
 *  wraps in a narrow pane and has to be retyped by whoever answers it); ids
 *  that are not canonical UUIDs pass through untouched. A prefix shared by two
 *  messages in the same delivery would make a `includes` search match the wrong block —
 *  including against the other one's line still sitting in terminal history —
 *  so every colliding message falls back to its full id. The batch is the unit
 *  because one delivery is what a confirm search scans against.
 *
 *  Delivered text and the confirm gate must both derive the token here: if the
 *  text carried a short id while the gate searched the full one, the gate could
 *  never match a delivery again and would re-write it until the attempt bound
 *  (the "one message arrived three times" regression). */
export function collaborationMessageAnchorTokens(messages: CollaborationMessage[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const short = canonicalShortId(message.id);
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }
  return new Map(messages.map((message) => {
    const short = canonicalShortId(message.id);
    return [message.id, counts.get(short) === 1 ? short : message.id];
  }));
}

/** The one line of a delivered block that carries the message's id, chosen by
 *  what the recipient can actually do with it: an agent-sourced message gets the
 *  reply command, a user message gets the read-back command (`td collab reply`
 *  refuses user messages — NO_REPLY_TARGET — so naming it there would be a dead
 *  command). Both routes accept the short form (the CLI resolves id prefixes),
 *  so whichever token collaborationMessageAnchorTokens picks for this delivery is what
 *  the recipient can paste back. Every message must carry its token regardless
 *  of source: the invariant is pinned by the "carries its id" test in
 *  collaborationPrompt.test.ts. */
export function collaborationMessageAnchorLine(message: CollaborationMessage, token: string = canonicalShortId(message.id)): string {
  return message.fromSessionId
    ? `回复:td collab reply ${token} "回复内容" --text`
    : `详情:td collab message get ${token} --json`;
}

/** A single delivered message: `来自:X · kind` over a fenced body, with the
 * anchor line (reply route / read-back route) kept outside the fence. A fan-out
 * dispatch (message.fanOutIds present) is flagged `· 群发` and names the
 * sibling recipients on their own line, so a broadcast is never mistaken for
 * a one-to-one assignment — raw ids fall back to the sanitized id itself. */
function formatCollaborationMessage(message: CollaborationMessage, source: string, fannedNames: string[], fence: string, token: string): string {
  const lines = [`来自:${source} · ${message.kind}${fannedNames.length ? ' · 群发' : ''}`];
  if (fannedNames.length) lines.push(`同时发给了:${fannedNames.join('、')}`);
  lines.push('', fence, message.content, fence);
  if (message.task) lines.push('', `任务上报:${JSON.stringify(message.task)}`);
  lines.push('', collaborationMessageAnchorLine(message, token));
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

  const tokens = collaborationMessageAnchorTokens(input.messages);
  const blocks: string[] = [];
  for (const message of input.messages) {
    const sourceSession = message.fromSessionId ? sessionsById.get(message.fromSessionId) : null;
    const source = message.fromSessionId
      ? sanitizeCollaborationName(sourceSession?.name ?? message.fromSessionId)
      : '用户';
    const token = tokens.get(message.id) ?? message.id;
    const bytes = Buffer.byteLength(message.content);
    const body = bytes > MAX_INLINE_BODY_BYTES
      ? `大消息已完整保存（${bytes} 字节）。使用 td collab message get ${token} --json 获取正文；不要把这条提示当作消息正文。`
      : message.content;
    const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length + 1)));
    const fannedNames = (message.fanOutIds ?? [])
      .map((sessionId) => sanitizeCollaborationName(sessionsById.get(sessionId)?.name ?? sessionId));
    blocks.push(formatCollaborationMessage({ ...message, content: body }, source, fannedNames, fence, token));
  }

  // The shell header names the group only when every block belongs to one;
  // a mixed batch drops the header entirely (no single-group claim to make).
  // The member count rides along as the at-a-glance size of that group.
  const groupIds = [...new Set(input.messages.map((message) => message.groupId))];
  const singleGroup = groupIds.length === 1 ? groupsById.get(groupIds[0]!) : null;
  const shellHeader = singleGroup
    ? `「${sanitizeCollaborationName(singleGroup.name ?? '协作组')}」群(${singleGroup.sessionIds.length} 个成员)`
    : '';

  const peerIds = Array.from(new Set(input.groups.flatMap((group) => group.sessionIds)))
    .filter((sessionId) => sessionId !== input.targetSessionId);
  // Keep routing IDs once, only for peers who are not already directly replyable.
  const sourceIds = new Set(input.messages.map((message) => message.fromSessionId));
  const peers = peerIds.filter((id) => !sourceIds.has(id)).map((sessionId) => {
    const session = sessionsById.get(sessionId);
    return `- ${session ? sanitizeCollaborationName(session.name) : '离线会话'}：\`td collab send ${sessionId} "消息内容" --text\``;
  });
  const unreachable = peerIds.filter((id) => sessionsById.get(id)?.status === 'service-unreachable');
  // Education (peer roster examples) decays once the session knows the group;
  // the `--help` pointer stays permanently as the one-line entrance to the
  // full command surface — everything else can be looked up from there.
  const routingHelp = input.showRoutingHelp === false ? [] : (peers.length ? ['联系其他成员：', ...peers] : []);
  const dynamicNotices = [
    ...(peerIds.some((id) => id.startsWith('remote:'))
      ? ['跨服务通信使用 td collab；转发客户端须保持运行，网页或 PWA 暂停后需返回前台继续转发。'] : []),
    ...unreachable.map((id) => {
      const session = sessionsById.get(id);
      return `注意：${session ? sanitizeCollaborationName(session.name) : id} 服务不可达，消息无法送达；仅可排队等待重连。`;
    }),
  ];

  const notes = [...routingHelp, ...dynamicNotices, '更多操作：`td collab --help`。'];
  // Notes (education + dynamic notices) live inside the shell, after the last
  // message, so the closing rule still marks the end of the delivered block.
  if (!blocks.length) return notes.join('\n');
  // Self-identity rides the shell under the header so the recipient always
  // knows the name peers see (a rename lands on the next delivery — no
  // separate notification needed) and, in a single-group delivery, its role.
  // The name needs no group claim and survives mixed batches; the role (定位)
  // only rides when the batch maps to exactly one group.
  const ownName = sanitizeCollaborationName(sessionsById.get(input.targetSessionId)?.name ?? '');
  const ownRole = singleGroup
    ? sanitizeCollaborationRole(singleGroup.roles?.[input.targetSessionId] ?? '')
    : '';
  const lines = [SHELL_RULE];
  if (shellHeader) lines.push(shellHeader);
  if (ownName) lines.push(`你的名字:${ownName}`);
  if (ownRole) lines.push(`你的定位:${ownRole}`);
  // No blank line between the identity block and the first message, nor
  // between the last message and the notes: the shell reads as one compact
  // block, and only message-to-message boundaries keep a blank line.
  lines.push(blocks.join('\n\n'), ...notes, SHELL_RULE);
  return lines.join('\n');
}
