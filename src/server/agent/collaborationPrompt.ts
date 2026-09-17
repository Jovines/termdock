import { canonicalShortId } from './collaborationProtocol.js';
import { sanitizeCollaborationRole, type CollaborationGroup, type CollaborationMessage } from './collaborationStore.js';

interface CollaborationPromptSession {
  sessionId: string;
  agentNativeSessionId?: string | null;
  name: string;
  status: string;
}

const SHELL_RULE = '─'.repeat(3);

/** Body larger than this (in UTF-8 bytes) is replaced by a retrieval pointer
 * instead of being injected into the terminal verbatim. */
const MAX_INLINE_BODY_BYTES = 4_096;

/** Relative age is captured when the terminal prompt is rendered. */
export function collaborationRulesAge(updatedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
  return `${Math.floor(seconds / 86400)}天前`;
}

/**
 * Characters that would corrupt the delivery shell header `「X」群 · N 人`
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

/** A single delivered message: `来自:X · kind · id` over a fenced body. The
 *  message id rides the source line — it is the one place a recipient can
 *  look up how to reply (`td collab --help`, always present below) without a
 *  per-message command template. A fan-out dispatch (message.fanOutIds
 *  present) is flagged `· 群发` and names the sibling recipients on their own
 *  line, so a broadcast is never mistaken for a one-to-one assignment — raw
 *  ids fall back to the sanitized id itself. The id must stay in every block:
 *  the delivery-confirm gate searches the terminal text for this exact token. */
function formatCollaborationMessage(message: CollaborationMessage, source: string, fannedNames: string[], fence: string, token: string): string {
  const kindSuffix = message.kind === 'message' ? '' : ` · ${message.kind}`;
  const lines = [`来自:${source}${kindSuffix}${fannedNames.length ? ' · 群发' : ''} · ${token}`];
  if (fannedNames.length) lines.push(`同时发给了:${fannedNames.join('、')}`);
  lines.push('', fence, message.content, fence);
  if (message.task) lines.push('', `任务上报:${JSON.stringify(message.task)}`);
  return lines.join('\n');
}

export function formatCollaborationDelivery(input: {
  targetSessionId: string;
  messages: CollaborationMessage[];
  groups: CollaborationGroup[];
  sessions: CollaborationPromptSession[];
  /**
   * false: omit the one-time education block (routing examples, capture and
   * cross-service guidance, the current group rules). Dynamic notices
   * (unreachable peers) and the help line are always included — they report
   * current conditions, not education. Callers gate this on a per-session
   * education state keyed by roster plus rules version, so a rule change
   * re-educates on the next delivery.
   */
  showRoutingHelp?: boolean;
  now?: number;
}): string {
  const groupsById = new Map(input.groups.map((group) => [group.id, group]));
  const sessionsById = new Map(input.sessions.map((session) => [session.sessionId, session]));

  const now = input.now ?? Date.now();
  const tokens = collaborationMessageAnchorTokens(input.messages);
  const blocks: string[] = [];
  for (const message of input.messages) {
    const sourceSession = message.fromSessionId ? sessionsById.get(message.fromSessionId) : null;
    const source = message.fromSessionId
      ? sanitizeCollaborationName(sourceSession?.name ?? message.fromSessionId)
      : '用户';
    const token = tokens.get(message.id) ?? message.id;
    const bytes = Buffer.byteLength(message.content);
    // A remote recipient's CLI cannot detect its identity (the session is not
    // on this machine's tmux), so retrieval commands it can copy verbatim must
    // carry --session explicitly; local members keep the short form.
    const sessionPrefix = input.targetSessionId.startsWith('remote:') ? `--session ${input.targetSessionId} ` : '';
    const body = bytes > MAX_INLINE_BODY_BYTES
      ? `大消息已完整保存（${bytes} 字节）。先执行 td collab ${sessionPrefix}message get ${token} --text 查看完整正文；不要把这条提示当作消息正文。`
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
    ? `「${sanitizeCollaborationName(singleGroup.name ?? '协作组')}」td群 · ${singleGroup.sessionIds.length} 人`
    : '';

  // One-time education block: static guidance that only rides the first
  // delivery (and again whenever the roster or the group rules change).
  // Current group guidance is preferred over the message's stored snapshot —
  // the snapshot stays reachable through message get.
  const educated = input.showRoutingHelp !== false;
  const education: string[] = [];
  if (educated) {
    const rules = singleGroup?.instructions ?? input.messages.find((message) => message.instructions)?.instructions;
    if (rules?.text) {
      const age = collaborationRulesAge(rules.updatedAt, now);
      const inline = Array.from(rules.text).length <= 200 && rules.text.split(/\r\n?|\n/).length <= 4;
      education.push(inline
        ? `群规[${age}]:${rules.text}`
        : `查看群规[${age}]:td collab rules get ${singleGroup?.id ?? input.messages[0]!.groupId} --text`);
    }
    const peerIds = Array.from(new Set(input.groups.flatMap((group) => group.sessionIds)))
      .filter((sessionId) => sessionId !== input.targetSessionId);
    // Keep routing IDs once, only for peers who are not already directly replyable.
    const sourceIds = new Set(input.messages.map((message) => message.fromSessionId));
    const peers = peerIds.filter((id) => !sourceIds.has(id)).map((sessionId) => {
      const session = sessionsById.get(sessionId);
      return `- ${session ? sanitizeCollaborationName(session.name) : '离线会话'}：\`td collab send ${sessionId} "消息内容" --text\``;
    });
    if (peers.length) education.push('联系其他成员：', ...peers);
    const captureHelp = '查看屏幕：`td collab capture <会话ID> --text`（只读，不打断对方；仅同组本机 tmux，远端用 send 询问）。ID：`td collab status --text`。快照不代表完成，勿循环轮询。';
    education.push(captureHelp);
    if (peerIds.some((id) => id.startsWith('remote:'))) {
      education.push('跨服务通信使用 td collab；已登记节点由服务后台直接投递，使用 message get 查看送达回执与重试原因。');
      // A cross-service member runs the CLI against its own service, where
      // identity detection usually fails — every copied command needs an
      // explicit --session or it dies with SESSION_NOT_FOUND.
      education.push('跨服务节点执行 td collab 命令需显式带 --session <你的会话id>（status --text 查看），否则报 SESSION_NOT_FOUND。');
    }
  }

  // Dynamic notices report current conditions and are never gated:
  // an unreachable peer changes what a reply can actually do, every delivery.
  const peerIds = Array.from(new Set(input.groups.flatMap((group) => group.sessionIds)))
    .filter((sessionId) => sessionId !== input.targetSessionId);
  const unreachable = peerIds.filter((id) => sessionsById.get(id)?.status === 'service-unreachable');
  const dynamicNotices = unreachable.map((id) => {
    const session = sessionsById.get(id);
    return `注意：${session ? sanitizeCollaborationName(session.name) : id} 服务不可达，消息无法送达；仅可排队等待重连。`;
  });
  const notes = [...education, ...dynamicNotices, '帮助:td collab --help'];

  if (!blocks.length) return notes.join('\n');
  // Recipient identity rides the shell under the header so the recipient
  // always knows the name peers see (a rename lands on the next delivery — no
  // separate notification needed) and, in a single-group delivery, its role
  // (定位). The name needs no group claim and survives mixed batches; the
  // role only rides when the batch maps to exactly one group.
  const ownName = sanitizeCollaborationName(sessionsById.get(input.targetSessionId)?.name ?? '');
  const ownRole = singleGroup
    ? sanitizeCollaborationRole(singleGroup.roles?.[input.targetSessionId] ?? '')
    : '';
  const contextLines = [shellHeader, ownName ? `收件人:${ownName}${ownRole ? ` · 定位:${ownRole}` : ''}` : ''].filter(Boolean);
  const lines = [SHELL_RULE, ...contextLines];
  // A blank line separates the who/where context block from the message
  // stream: the shell reads as context, then one compact block per message.
  if (contextLines.length) lines.push('');
  lines.push(blocks.join('\n\n'), ...notes, SHELL_RULE);
  return lines.join('\n');
}
