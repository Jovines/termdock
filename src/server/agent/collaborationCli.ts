import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { COLLAB_LIMITS, CollaborationError, canonicalShortId } from './collaborationProtocol.js';

export interface CollaborationCommand {
  action: 'status' | 'inbox' | 'send' | 'handoff' | 'reply' | 'add' | 'remove' | 'spawn' | 'message' | 'cursor' | 'rebind' | 'role' | 'rename' | 'cleanup' | 'drive' | 'capabilities' | 'help';
  target?: string; message?: string; groupId?: string; sessionId?: string; sessionIds?: string[]; agentSlug?: string; name?: string; cwd?: string; task?: string; role?: string;
  json: boolean;
  options: Record<string, string | boolean>;
  operation?: string;
}
export const COLLAB_HELP = `td collab — durable messages; no agent-specific hooks required
  (everywhere an id is taken, the 8-character id shown in deliveries and --text
   output works too; a shorter unique prefix down to 4 characters also resolves —
   an ambiguous prefix is refused, so use more characters or the full id)
  status | capabilities
  rebind [--pane %3] (explicitly bind this peer to its current Agent; resumes queued delivery)
  send <session-id> <message> | reply <message-id> <message> | handoff <session-id> <message>
    (send fan-out: comma-separated same-group ids, e.g. send a,b "任务"; every
    recipient sees it as 群发 with the sibling list; waiting options apply to
    single-recipient sends only)
    --group <id> --thread <id> --idempotency-key <key>
    --file <path> | --stdin (instead of inline body; -- ends option parsing)
    --wait-until queued|delivered|read --timeout 30s
    --expect-reply ack|result|any
    --response-kind ack|progress|result --metadata '<JSON object>'
    --expires-at <ISO timestamp or epoch milliseconds>
    reply: --task-envelope '<JSON: task_id,status,progress?,evidence?,blocker?>'
      (status reporting happens only via reply; send/handoff dispatch carries no task state)
  message get <message-id> [--receipt-only]
  message read <message-id> (explicit consumption; not application ACK)
  message watch <message-id> [--wait-until delivered|read] [--timeout 30s]
  inbox [--unread] [--since <ISO or epoch-ms>] [--after-id <id>]
    [--cursor <token>] [--consumer <name>] [--limit 1..200]
    [--from <id>] [--group <id>] [--thread <id>] [--kind <kind>]
    [--response-kind ack|progress|result] [--follow] [--timeout 30s]
  cursor commit <token> --consumer <name> (commit after processing the page)
  add|remove <group-id> <session-id>
  spawn <group-id> <agent-slug> [--name <name>] [--cwd <path>] [--task <text>]
  role list <group-id>
  role set <group-id> <session-id> <role…> (trailing words join as the role)
  role unset <group-id> <session-id>
    (roles are shared within the group; members set each other's, your own
    rides the delivery shell header)
  rename <session-id> <name…> (rename a member of any shared group;
    trailing words join as the new name; roster and shells show it at once)
  drive <session-id> approve|enter|escape|space|left|right|up|down|capture
  drive <session-id> run <command…>
    (drive the terminal of a member session you share a group with — terminal
    operations are shell operations: approve dismisses an interactive approval
    dialog and refuses unless one is actually showing; named keys inject one
    key; capture reads the current screen back; run submits one line and
    returns the screen. Works on plain shell members too (no agent needed) for
    run/capture; key actions (approve/enter/…) require an agent pane, and are
    refused while the user has the pane scrolled into copy-mode. Cannot target
    your own session. Treat every drive as strong control: the member's shell
    executes what you send.)
  cleanup <session-id>… 移除协作会话并终止其 tmux/进程（仅限与你同组的会话；
    不能清理当前会话自身，也不能通过清理解散你所在的组）
    风险操作：默认只打印清理计划并拒绝执行（exit 1）——这是不可恢复的删除。
    必须先向用户（人类）说明将清理的会话与影响并获得其明确同意，
    才能以 --confirm 重跑执行；每次执行都需要当场的人类授权。
  --json (default) | --jsonl | --text
Exit codes: 0 requested condition met; 1 invalid request/network error;
cleanup without --confirm prints the plan and refuses (also 1);
2 wait timeout (message may still deliver); 3 failed/expired.
Message limit: ${COLLAB_LIMITS.message_bytes} UTF-8 bytes; metadata: ${COLLAB_LIMITS.metadata_bytes} bytes.
Idempotency retention: 7 days. read/ACK/result never imply each other.
Inbox defaults to unread first, newest 50; cursor/consumer mode reads oldest unseen first.
Reading never advances a consumer or marks messages read automatically.`;

/** One roster row: prefer the member's human name, keep the full session id
 * reachable for role set/unset targeting, mark unset members explicitly. */
function roleLine(member: { sessionId: string; name?: string | null }, role?: string): string {
  const label = member.name ? `${member.name} (${member.sessionId})` : member.sessionId;
  return role ? `- ${label}：${role}` : `- ${label}（未设置）`;
}

interface RoleGroupView {
  id: string; name?: string; sessionIds: string[];
  roles?: Record<string, string>;
  members?: Array<{ sessionId: string; name?: string | null }>;
}

const BOOLEAN_OPTIONS = new Set(['json', 'jsonl', 'text', 'unread', 'follow', 'stdin', 'receipt-only', 'confirm', 'help']);
const VALUE_OPTIONS = new Set(['group', 'thread', 'idempotency-key', 'file', 'wait-until', 'timeout', 'expect-reply', 'response-kind', 'metadata', 'task-envelope', 'expires-at', 'since', 'after-id', 'cursor', 'consumer', 'limit', 'from', 'kind', 'name', 'cwd', 'task', 'pane']);
export function parseCollaborationCommand(argv: string[]): CollaborationCommand {
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let literal = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--' && !literal) { literal = true; continue; }
    if (!literal && value.startsWith('--')) {
      const [flag, ...inline] = value.slice(2).split('=');
      if (BOOLEAN_OPTIONS.has(flag)) { if (inline.length) throw new Error(`--${flag} takes no value`); options[flag] = true; }
      else if (VALUE_OPTIONS.has(flag)) {
        const next = inline.length ? inline.join('=') : argv[++index];
        if (!next || (!inline.length && next.startsWith('--'))) throw new Error(`--${flag} requires a value`);
        options[flag] = next;
      } else throw new Error(`Unknown collaboration option: --${flag}`);
    } else positional.push(value);
  }
  const action = (options.help ? 'help' : positional.shift() ?? 'status') as CollaborationCommand['action'];
  if (!['status', 'inbox', 'send', 'handoff', 'reply', 'add', 'remove', 'spawn', 'message', 'cursor', 'rebind', 'role', 'rename', 'cleanup', 'drive', 'capabilities', 'help'].includes(action)) throw new Error('Unknown collaboration command; see td collab --help');
  if (options.pane && !/^%\d+$/.test(String(options.pane))) throw new Error('pane must be a tmux pane id such as %3');
  if (['json', 'jsonl', 'text'].filter((key) => options[key]).length > 1) throw new Error('Choose one output format');
  if (options['wait-until'] && !['queued', 'delivered', 'read'].includes(String(options['wait-until']))) throw new Error('wait-until must be queued, delivered or read');
  if (options['expect-reply'] && !['ack', 'result', 'any'].includes(String(options['expect-reply']))) throw new Error('expect-reply must be ack, result or any');
  if (options.timeout) duration(String(options.timeout));
  const command: CollaborationCommand = { action, json: !options.text, options };
  if (['send', 'reply', 'handoff'].includes(action)) {
    command.target = positional.shift(); command.message = positional.join(' ');
    if (!command.target || (!command.message && !options.file && !options.stdin)) throw new Error(`${action} requires a target and message`);
    if ([Boolean(command.message), Boolean(options.file), Boolean(options.stdin)].filter(Boolean).length !== 1) throw new Error('Choose inline body, --file, or --stdin');
  } else if (action === 'message') {
    command.operation = positional.shift(); command.target = positional.shift();
    if (!['get', 'watch', 'read'].includes(command.operation ?? '') || !command.target || positional.length) throw new Error('Usage: td collab message get|watch|read <id>');
  } else if (action === 'cursor') {
    command.operation = positional.shift(); command.target = positional.shift();
    if (command.operation !== 'commit' || !command.target || !options.consumer || positional.length) throw new Error('Usage: td collab cursor commit <token> --consumer <name>');
  } else if (action === 'add' || action === 'remove' || action === 'spawn') {
    command.groupId = positional.shift();
    if (action === 'spawn') command.agentSlug = positional.shift(); else command.sessionId = positional.shift();
    if (!command.groupId || !(command.agentSlug || command.sessionId) || positional.length) throw new Error(`${action} requires two identifiers`);
    command.name = options.name as string; command.cwd = options.cwd as string; command.task = options.task as string;
  } else if (action === 'role') {
    command.operation = positional.shift();
    command.groupId = positional.shift();
    if (command.operation === 'list') {
      if (!command.groupId || positional.length) throw new Error('Usage: td collab role list <group-id>');
    } else if (command.operation === 'set') {
      command.sessionId = positional.shift();
      command.role = positional.join(' ');
      if (!command.groupId || !command.sessionId || !command.role?.trim()) throw new Error('Usage: td collab role set <group-id> <session-id> <role…>');
    } else if (command.operation === 'unset') {
      command.sessionId = positional.shift();
      if (!command.groupId || !command.sessionId || positional.length) throw new Error('Usage: td collab role unset <group-id> <session-id>');
    } else throw new Error('Usage: td collab role list|set|unset (see td collab --help)');
  } else if (action === 'rename') {
    command.sessionId = positional.shift();
    command.name = positional.join(' ');
    if (!command.sessionId || !command.name?.trim()) throw new Error('Usage: td collab rename <session-id> <name…>');
  } else if (action === 'cleanup') {
    command.sessionIds = [...positional];
    if (command.sessionIds.length === 0) throw new Error('Usage: td collab cleanup <session-id> [<session-id>…]');
  } else if (action === 'drive') {
    command.sessionId = positional.shift();
    command.operation = positional.shift();
    if (!command.sessionId || !command.operation) throw new Error('Usage: td collab drive <session-id> approve|enter|escape|space|left|right|up|down|capture|run <command…>');
    if (command.operation === 'run') {
      command.message = positional.join(' ');
      if (!command.message?.trim()) throw new Error('Usage: td collab drive <session-id> run <command…>');
    } else if (positional.length || !['approve', 'enter', 'escape', 'space', 'left', 'right', 'up', 'down', 'capture'].includes(command.operation)) {
      throw new Error(`Unknown drive action ${command.operation ?? ''}; use approve|enter|escape|space|left|right|up|down|capture|run`);
    }
  } else if (positional.length && action !== 'help') throw new Error(`Unexpected arguments for ${action}`);
  const allowed = new Set(['json', 'jsonl', 'text', 'help']);
  const byAction: Record<string, string[]> = {
    status: [], capabilities: [], rebind: ['pane'], help: [...BOOLEAN_OPTIONS, ...VALUE_OPTIONS],
    send: ['group', 'thread', 'idempotency-key', 'file', 'stdin', 'wait-until', 'timeout', 'expect-reply', 'response-kind', 'metadata', 'expires-at', 'kind'],
    handoff: ['group', 'thread', 'idempotency-key', 'file', 'stdin', 'wait-until', 'timeout', 'expect-reply', 'response-kind', 'metadata', 'expires-at'],
    reply: ['idempotency-key', 'file', 'stdin', 'wait-until', 'timeout', 'expect-reply', 'response-kind', 'metadata', 'task-envelope', 'expires-at'],
    inbox: ['unread', 'since', 'after-id', 'cursor', 'consumer', 'limit', 'from', 'group', 'thread', 'kind', 'response-kind', 'follow', 'timeout'],
    message: ['receipt-only', 'follow', 'wait-until', 'timeout', 'expect-reply'], cursor: ['consumer'],
    add: [], remove: [], spawn: ['name', 'cwd', 'task'], role: [], rename: [], cleanup: ['confirm'], drive: [],
  };
  for (const option of byAction[action]) allowed.add(option);
  for (const option of Object.keys(options)) if (!allowed.has(option)) throw new Error(`--${option} is not supported by ${action}`);
  if (action === 'message' && command.operation === 'read' && Object.keys(options).some((option) => !['json', 'jsonl', 'text', 'help'].includes(option))) throw new Error('message read does not accept wait or filtering options');
  return command;
}
export function duration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value);
  const result = match ? Number(match[1]) * (match[2] === 'm' ? 60000 : match[2] === 's' ? 1000 : 1) : NaN;
  if (!Number.isFinite(result) || result < 1 || result > 86_400_000) throw new Error('timeout must be 1ms–24h, e.g. 30s (plain numbers are milliseconds)');
  return result;
}
type Json = Record<string, any>;
export interface CollaborationCliIO {
  request: (method: 'GET' | 'POST', endpoint: string, body: unknown, timeoutMs: number) => Promise<{ statusCode: number; body: string }>;
  write: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  stdin?: () => Promise<string>;
}
export function waitSatisfied(receipt: Json, stage: string, reply?: string): boolean {
  const reached = stage === 'queued' || (stage === 'delivered' && ['delivered', 'read'].includes(receipt.status)) || (stage === 'read' && receipt.status === 'read');
  return reached && (!reply || (reply === 'ack' ? receipt.ack_at != null : reply === 'result' ? receipt.result_ids?.length > 0 : receipt.reply_ids?.length > 0));
}
export async function executeCollaborationCommand(command: CollaborationCommand, context: Record<string, string>, io: CollaborationCliIO): Promise<number> {
  const o = command.options;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let deadline = now() + duration(String(o.timeout ?? '30s'));
  const query = new URLSearchParams(context);
  const request = async (method: 'GET' | 'POST', route: string, body?: Json): Promise<Json> => {
    const response = await io.request(method, `/api/terminal/operations/orchestration${route}${method === 'GET' ? `${route.includes('?') ? '&' : '?'}${query}` : ''}`, method === 'POST' ? { ...context, ...body } : undefined, Math.max(1, Math.min(10000, deadline - now())));
    let parsed: Json;
    try { parsed = JSON.parse(response.body); } catch { throw new CollaborationError('INVALID_RESPONSE', 'Service returned a non-JSON response'); }
    if (response.statusCode < 200 || response.statusCode >= 300) throw new CollaborationError(parsed.code ?? 'REQUEST_FAILED', parsed.error ?? 'Collaboration request failed', response.statusCode);
    return parsed;
  };
  const output = (value: Json) => {
    if (o.text) {
      if (Array.isArray(value.messages)) for (const message of value.messages) {
        const fanIds = Array.isArray(message.fanOutIds) ? (message.fanOutIds as string[]) : [];
        const names = (value.names as Record<string, string | null> | undefined) ?? {};
        io.write(`[${message.responseKind ?? message.kind}] ${canonicalShortId(message.id)} from ${message.fromSessionId ?? 'user'}${fanIds.length ? ' · 群发' : ''}`);
        // A fan-out dispatch names its sibling recipients so a broadcast is
        // never read as a one-to-one assignment; unknown ids stay raw.
        if (fanIds.length) io.write(`同时发给了:${fanIds.map((id) => names[id] ?? id).join('、')}`);
        io.write(message.content);
      }
      else if (value.message) io.write(`[${value.status}] ${canonicalShortId(String(value.message_id ?? ''))}\n${value.message.content}`);
      else if (value.message_id) {
        io.write(`${value.status} ${canonicalShortId(String(value.message_id))}${value.thread_id ? ` thread=${canonicalShortId(String(value.thread_id))}` : ''}${value.code ? ` ${value.code}` : ''}${value.failure_reason ? ` ${value.failure_reason}` : ''}`);
        // A timeout after the wait stage itself was reached means delivery
        // (or reading) completed — only the expected reply/result is late.
        if (value.code === 'WAIT_TIMEOUT' && value.stage_reached && value.expect_reply) {
          io.write(`\n投递已完成；等待${value.expect_reply === 'result' ? '结果' : '回复'}超时（expect-reply=${value.expect_reply}）`);
        }
        if (value.snapshot) io.write(`\n${value.snapshot}`);
      }
      else io.write(JSON.stringify(value, null, 2));
      if (value.next_cursor) io.write(`next_cursor=${value.next_cursor} has_more=${value.has_more}`);
    } else if (o.jsonl && Array.isArray(value.messages) && command.action === 'inbox') {
      for (const message of value.messages) io.write(JSON.stringify({ type: 'message', ...message }));
      io.write(JSON.stringify({ type: 'cursor', next_cursor: value.next_cursor, has_more: value.has_more, retention_gap: value.retention_gap ?? false, consumer: value.consumer }));
    } else io.write(JSON.stringify(value, null, o.jsonl || o.follow || command.operation === 'watch' ? undefined : 2));
  };
  let receipt: Json | undefined;
  let idempotencyKey: string | undefined;
  try {
    if (command.action === 'help') {
      io.write(COLLAB_HELP);
      // Append the caller's own groups with every member role — help doubles
      // as the newcomer's one-shot introduction to the current roster. The
      // snapshot requires a managed session, so it degrades to bare help
      // outside one (a plain CLI read still prints the full surface).
      try {
        const mine = await request('GET', '/role') as { groups?: RoleGroupView[] };
        const groups = mine.groups ?? [];
        if (groups.length) {
          io.write('\n本会话所在协作组的成员定位：');
          for (const group of groups) {
            io.write(`组「${group.name ?? ''}」(${group.sessionIds.length} 个成员)`);
            const members = new Map((group.members ?? []).map((member) => [member.sessionId, member.name ?? null]));
            for (const id of group.sessionIds) io.write(roleLine({ sessionId: id, name: members.get(id) ?? null }, group.roles?.[id]));
          }
        }
      } catch { /* help stays available without a server or session */ }
      return 0;
    }
    if (command.action === 'capabilities' || command.action === 'status') { output(await request('GET', command.action === 'status' ? '/peers' : '/capabilities')); return 0; }
    if (command.action === 'rebind') { output(await request('POST', '/route/rebind', { pane: o.pane ?? null })); return 0; }
    if (command.action === 'inbox') {
      let cursor = o.cursor as string | undefined;
      do {
        const params = new URLSearchParams();
        for (const key of ['unread', 'since', 'after-id', 'consumer', 'limit', 'from', 'group', 'thread', 'kind', 'response-kind']) if (o[key]) params.set(key.replaceAll('-', '_'), String(o[key]));
        if (cursor) { params.set('cursor', cursor); params.delete('after_id'); }
        const page = await request('GET', `/inbox?${params}`);
        if (!o.follow || page.messages?.length || page.retention_gap) output(page);
        cursor = page.next_cursor;
        if (!o.follow) return 0;
        if (!page.has_more) await sleep(Math.min(1000, Math.max(0, deadline - now())));
      } while (now() < deadline);
      return 0;
    }
    if (command.action === 'cursor') { output(await request('POST', '/cursor/commit', { cursor: command.target, consumer: o.consumer })); return 0; }
    if (command.action === 'message') {
      const route = `/message/${encodeURIComponent(command.target!)}`;
      if (command.operation === 'read') { output(await request('POST', `${route}/read`)); return 0; }
      receipt = await request('GET', `${route}${o['receipt-only'] || command.operation === 'watch' ? '?receipt_only=true' : ''}`);
      if (command.operation === 'get' && !o.follow && !o['wait-until'] && !o['expect-reply']) { output(receipt); return 0; }
    } else if (['send', 'reply', 'handoff'].includes(command.action)) {
      let content = command.message ?? '';
      if (o.file) {
        if (fs.statSync(String(o.file)).size > COLLAB_LIMITS.message_bytes) throw new Error('Message file exceeds 1 MiB');
        content = fs.readFileSync(String(o.file), 'utf8');
      }
      if (o.stdin) { if (!io.stdin) throw new Error('stdin is unavailable'); content = await io.stdin(); }
      if (Buffer.byteLength(content) > COLLAB_LIMITS.message_bytes) throw new Error('Message exceeds 1 MiB');
      const expiresAt = o['expires-at'] ? /^\d+$/.test(String(o['expires-at'])) ? Number(o['expires-at']) : Date.parse(String(o['expires-at'])) : undefined;
      if (expiresAt !== undefined && !Number.isFinite(expiresAt)) throw new Error('Invalid expires-at timestamp');
      idempotencyKey = String(o['idempotency-key'] ?? randomUUID());
      const extras = { group_id: o.group, thread_id: o.thread, idempotency_key: idempotencyKey, response_kind: o['response-kind'],
        metadata: o.metadata ? JSON.parse(String(o.metadata)) : undefined, task: o['task-envelope'] ? JSON.parse(String(o['task-envelope'])) : undefined, expires_at: expiresAt };
      // A comma-separated target list fans one dispatch out to several
      // recipients of a shared group; every edge carries the sibling list so
      // recipients see the 群发 framing. Reply stays one-to-one by nature.
      const targets = command.target!.split(',').map((id) => id.trim()).filter(Boolean);
      const fanOut = command.action !== 'reply' && targets.length > 1;
      if (command.action !== 'reply' && !targets.length) throw new Error(`${command.action} requires a target session id`);
      if (fanOut && (o['wait-until'] || o['expect-reply'])) throw new Error('--wait-until/--expect-reply need a single recipient; fan-out confirms queued delivery only');
      deadline = now() + duration(String(o.timeout ?? '30s'));
      receipt = await request('POST', command.action === 'reply' ? '/reply' : '/send', command.action === 'reply'
        ? { ...extras, messageId: command.target, content }
        : { ...extras, ...(fanOut ? { toSessionIds: targets } : { targetSessionId: targets[0] }), message: content, kind: command.action === 'handoff' ? 'handoff' : o.kind ?? 'message' });
      // CLI receipts stay small even when the message is a large evidence package.
      delete receipt.messages;
      receipt.idempotency_key = idempotencyKey;
    } else if (command.action === 'role') {
      if (command.operation === 'list') {
        const body = await request('GET', `/role?group=${encodeURIComponent(command.groupId!)}`);
        if (o.text) {
          const group = body.group as RoleGroupView;
          io.write(`定位表（${group.name ? `组「${group.name}」· ` : ''}${group.sessionIds.length} 个成员）：`);
          const members = new Map((group.members ?? []).map((member) => [member.sessionId, member.name ?? null]));
          for (const id of group.sessionIds) io.write(roleLine({ sessionId: id, name: members.get(id) ?? null }, group.roles?.[id]));
        } else output(body);
        return 0;
      }
      const body = await request('POST', '/role', { group_id: command.groupId, session_id: command.sessionId,
        role: command.operation === 'unset' ? null : command.role });
      if (o.text) {
        io.write(command.operation === 'set'
          ? `定位已设置：${command.sessionId} = ${(body.group as { roles?: Record<string, string> }).roles?.[command.sessionId!] ?? ''}`
          : `定位已清除：${command.sessionId}`);
      } else output(body);
      return 0;
    } else if (command.action === 'rename') {
      const body = await request('POST', '/name', { session_id: command.sessionId, name: command.name });
      if (o.text) io.write(`已改名：${command.sessionId} = ${(body as { name?: string }).name ?? command.name}`);
      else output(body);
      return 0;
    } else if (command.action === 'drive') {
      const body = await request('POST', '/drive', { session: command.sessionId, action: command.operation, text: command.message });
      const result = body as { ok?: boolean; approved?: boolean; snapshot?: string; error?: string };
      if (o.text) {
        if (command.operation === 'run') {
          io.write(`已向 ${command.sessionId} 发送一行并提交：${command.message}`);
          if (result.snapshot) io.write(`--- ${command.sessionId} 当前屏幕 ---\n${result.snapshot}`);
        } else if (command.operation === 'capture') {
          if (result.snapshot) io.write(result.snapshot);
          else io.write('（无快照）');
        } else if (command.operation === 'approve') {
          io.write(result.approved ? `已批准 ${command.sessionId} 的审批对话框` : '目标面板当前没有显示审批对话框；未发送任何按键');
        } else io.write(`已向 ${command.sessionId} 发送 ${command.operation}`);
      } else output(body);
      return 0;
    } else if (command.action === 'cleanup') {
      const plan = await request('POST', '/cleanup', { sessionIds: command.sessionIds, confirmed: Boolean(o.confirm) });
      const targets = (plan.plan?.targets ?? []) as Array<{ sessionId: string; name: string | null; mode: string | null; tmuxSessionName?: string | null }>;
      const groups = (plan.plan?.groups ?? []) as Array<{ id: string; name: string | null; sizeBefore: number; sizeAfter: number; dissolves: boolean }>;
      if (plan.ok !== true) {
        if (o.text) {
          io.write('清理计划（未执行 —— 需要人类授权）');
          for (const target of targets) io.write(`- ${target.name ?? target.sessionId}（${target.sessionId}）${target.mode === 'tmux' && target.tmuxSessionName ? ` · tmux ${target.tmuxSessionName}` : target.mode ? ` · ${target.mode}` : ''}`);
          if (groups.length) {
            io.write('协作组影响：');
            for (const group of groups) io.write(group.dissolves
              ? `- 组「${group.name ?? group.id}」将被解散（组内消息一并清除）`
              : `- 组「${group.name ?? group.id}」：${group.sizeBefore} 个成员 → ${group.sizeAfter} 个成员`);
          }
          io.write('⚠ 这是不可恢复的风险操作：将移除上述会话记录并终止其 tmux/进程。');
          io.write('执行前必须先向用户（人类）说明以上内容并获得明确同意，再以 --confirm 重跑本命令；每次执行都需要当场的人类授权。');
        } else output(plan);
        return 1;
      }
      const removed = (plan.removed ?? []) as Array<{ sessionId: string; name?: string | null; tmuxSessionName?: string | null; alreadyGone?: boolean; killed?: boolean }>;
      if (o.text) {
        io.write(`已清理 ${removed.length} 个会话：`);
        for (const entry of removed) io.write(`- ${entry.name ?? entry.sessionId}（${entry.sessionId}）：${entry.tmuxSessionName ? (entry.alreadyGone ? 'tmux 已不存在，记录已移除' : `tmux ${entry.tmuxSessionName} 已终止`) : entry.killed ? '进程已终止，记录已移除' : '记录已移除'}`);
      } else output(plan);
      return 0;
    } else {
      const body = command.action === 'spawn' ? { groupId: command.groupId, agentSlug: command.agentSlug, name: command.name, cwd: command.cwd, task: command.task }
        : { groupId: command.groupId, targetSessionId: command.sessionId, action: command.action };
      output(await request('POST', command.action === 'spawn' ? '/spawn' : '/members', body)); return 0;
    }
    const stage = String(o['wait-until'] ?? (command.action === 'message' ? 'read' : 'queued'));
    let previous = '';
    for (;;) {
      if (['failed', 'expired'].includes(receipt!.status)) { output(receipt!); return 3; }
      if (waitSatisfied(receipt!, stage, o['expect-reply'] as string)) { output(receipt!); return 0; }
      if (o.follow || command.operation === 'watch') {
        const serialized = JSON.stringify(receipt);
        if (serialized !== previous) { output(receipt!); previous = serialized; }
      }
      if (now() >= deadline) {
        output({ ...receipt, ok: false, code: 'WAIT_TIMEOUT', wait_until: stage, stage_reached: waitSatisfied(receipt!, stage, undefined),
          expect_reply: o['expect-reply'] ?? null, delivery_continues: true });
        return 2;
      }
      await sleep(Math.min(500, deadline - now()));
      if (now() >= deadline) continue;
      receipt = { ...await request('GET', `/message/${encodeURIComponent(receipt!.message_id)}?receipt_only=true`), ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) };
    }
  } catch (error) {
    if (receipt && now() >= deadline) { output({ ...receipt, ok: false, code: 'WAIT_TIMEOUT', delivery_continues: true, last_error: error instanceof Error ? error.message : String(error) }); return 2; }
    output({ ...(receipt ?? {}), ok: false, code: error instanceof CollaborationError ? error.code : 'COLLABORATION_ERROR',
      error: error instanceof Error ? error.message : String(error), ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}), ...(receipt ? { delivery_continues: true } : {}) });
    return 1;
  }
}
