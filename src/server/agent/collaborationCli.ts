import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { COLLAB_LIMITS, CollaborationError, canonicalShortId } from './collaborationProtocol.js';

export interface CollaborationCommand {
  action: 'status' | 'inbox' | 'send' | 'handoff' | 'reply' | 'add' | 'remove' | 'spawn' | 'message' | 'cursor' | 'rebind' | 'role' | 'rename' | 'cleanup' | 'drive' | 'capabilities' | 'transport' | 'group' | 'rules' | 'help';
  target?: string; message?: string; groupId?: string; sessionId?: string; sessionIds?: string[]; agentSlug?: string; name?: string; cwd?: string; task?: string; role?: string;
  json: boolean;
  options: Record<string, string | boolean>;
  operation?: string;
}
export const COLLAB_HELP = `td collab — durable messages; no agent-specific hooks required
  我想…
    回复刚收到的消息 → 用投递「来自」行里的 id: td collab reply <id> "内容" --text
    看有谁、我在哪些组 → td collab status --text
    主动找人 → td collab send <成员id> "消息内容" --text
    看对方在干什么 → td collab capture <成员id> --text（只读巡屏，不发送按键）
    取大消息全文 → td collab message get <id> --text
    改我的显示名 → td collab rename <我的id> <新名字>
    设角色定位 → td collab role set <组id> <成员id> <定位>
    查/改群规 → td collab rules get|set <组id>
    消息发出去没动静 → td collab message get <id>（投递状态与重试原因）
  Output: --json (default) | --jsonl | --text (human-readable lines; prefer it
    when reading results yourself. Commands without a dedicated --text form
    still print JSON)
  Source identity (all collab commands): --session <full-Termdock-session-id>
    or TERMDOCK_COLLAB_SESSION_ID. CLI option wins; explicit identity bypasses
    environment/tmux detection. Use your own full member ID from status output,
    not a tmux name, backend ID or Claude session ID. Unknown IDs are refused.
    Example: td collab --session <your-full-session-id> status
  Ids: wherever an id is taken, the short id shown in deliveries and --text
    output works too; a shorter unique prefix down to 4 characters also
    resolves — an ambiguous prefix is refused, so use more characters.
  Scheduled self-reminders: td automation create --name 'Review progress' --every 30 --self --prompt 'Review group progress and continue'
  Scheduling help: td automation --help

── 常用 ──
  status (who is in my groups, their names, roles, observed activity.
    Status values: service-reachable/service-unreachable mark remote node
    connectivity; local members show their own session state instead.
    观测时距终端输出 N 秒 is an observation, never task progress)
  send <session-id> <message> (deliver to one member; comma-separated same-group
    ids fan out, e.g. send a,b "任务" — recipients see it as 群发)
  reply <message-id> <message> (answer a message you received; one-to-one)
  handoff <session-id> <message> (like send, framed as a task hand-off)
    shared options: --group <id> --thread <id> --idempotency-key <key>
      --file <path> | --stdin (instead of inline body; -- ends option parsing)
      --wait-until queued|delivered --timeout 30s --expect-reply ack|result|any
      --response-kind ack|progress|result --metadata '<JSON object>'
      --expires-at <ISO timestamp or epoch milliseconds>
    reply also: --task-envelope '<JSON: task_id,status,progress?,evidence?,blocker?>'
      (status reporting happens only via reply; send/handoff dispatch carries no task state)
  message get <id> [--receipt-only] [--raw] [--no-rules] [--text]
    (delivery status, retries and the full body of large messages)
  message confirm-shell <message-id> (sender confirms delivery into a shell; continues the same message)
  message watch <message-id> [--wait-until delivered] [--timeout 30s]
  capture <session-id> [--lines 1..10000] [--raw] [--text]
    (查看伙伴正在做什么：读取同组、本机 tmux 成员的当前屏幕，不发送按键、不打断对方。
    不是完整聊天历史或完成凭证；用 status --text 查成员 ID；不支持远端成员，远端请 send 询问进展。)
── 群与规则 ──
  group save --file group.json
    JSON: {name, sessionIds, id?, expectedUpdatedAt?}; same service API as the UI.
  add|remove <group-id> <session-id>
  spawn <group-id> <agent-slug> [--name <name>] [--cwd <path>] [--task <text>]
  rules get <group-id> [--text] | rules set <group-id> <text> | --file <path> | --stdin [--if-version <version>]
    | rules clear <group-id> [--if-version <version>]
    (shared group guidance, up to 8192 UTF-8 bytes; message envelopes retain
    its version. if-version rejects concurrent overwrites with GROUP_CHANGED)
  rename <session-id> <name…> (rename a member of any shared group;
    trailing words join as the new name; roster and shells show it at once)
  role list <group-id> | role set <group-id> <session-id> <role…> | role unset <group-id> <session-id>
    (roles are shared within the group; members set each other's, your own
    rides the delivery shell header. traits is an alias of role)
── 收件箱与游标 ──
  inbox [--since <ISO or epoch-ms>] [--after-id <id>] [--cursor <token>]
    [--consumer <name>] [--limit 1..200] [--from <id>] [--group <id>]
    [--thread <id>] [--kind <kind>] [--response-kind ack|progress|result]
    [--follow] [--timeout 30s]
    (defaults to newest 50; cursor/consumer mode reads oldest unseen first.
    Reading never advances a consumer. Read receipts are not supported)
  cursor commit <token> --consumer <name> (commit after processing the page)
── 传输与运维 ──
  transport list (server-owned remote session directory) | transport info (this service's public identity and CA fingerprint, no private keys)
  transport invite --origin https://this-service:9834
    (create a 10-minute invitation granting collaboration directory/group
    access; transfer its JSON privately — no browser required)
  transport accept --origin https://this-service:9834 --file invitation.json
    (pair both services once; discovery, groups and delivery become automatic)
  transport register <group-id> --file <nodes.json>
    (one-time server peer registration; nodes.json is an array of public
    {serviceId, origin, caFingerprint256?} entries, including this service.
    Obtain pins from each administrator's transport info over a trusted
    channel. Registered servers deliver without an open browser or Desktop client)
  rebind [--pane %3] (explicitly bind this peer to its current Agent; resumes queued delivery)
  drive <session-id> approve|enter|escape|space|left|right|up|down|capture
  drive <session-id> run <command…>
    (drive the terminal of a member session you share a group with — terminal
    operations are shell operations: approve dismisses an interactive approval
    dialog and refuses unless one is actually showing; named keys inject one
    key; capture reads the current screen back; run submits one line and
    returns the screen. Works on plain shell members too (no agent needed) for
    run/capture; key actions require an agent pane and are refused while the
    user has the pane scrolled into copy-mode. Cannot target your own session.
    Treat every drive as strong control: the member's shell executes what you send)
  cleanup <session-id>… 移除协作会话并终止其 tmux/进程（仅限与你同组的会话；
    不能清理当前会话自身，也不能通过清理解散你所在的组）
    风险操作：默认只打印清理计划并拒绝执行（exit 1）——这是不可恢复的删除。
    必须先向用户（人类）说明将清理的会话与影响并获得其明确同意，
    才能以 --confirm 重跑执行；每次执行都需要当场的人类授权。
  help (this text; when a managed session is available it also lists the
    groups you are in with every member's id, name and role)
Exit codes: 0 requested condition met; 1 invalid request/network error;
cleanup without --confirm prints the plan and refuses (also 1);
2 wait timeout (message may still deliver); 3 failed/expired.
Message limit: ${COLLAB_LIMITS.message_bytes} UTF-8 bytes; metadata: ${COLLAB_LIMITS.metadata_bytes} bytes.
Idempotency retention: 7 days. Terminal delivery, ACK and result never imply each other.
Delivery semantics: delivered = written to the terminal — never proof of
reading or task completion; a timeout stops waiting, it does not cancel delivery.
The service cannot see whether the recipient's agent consumed a message. To
judge for yourself, use --wait-until delivered and read the recipient-screen
snapshot in the receipt: if your message is not visible on that screen, send it
again (a fresh send is a new message and will be written again); if it is
visible but unanswered, the recipient may simply not have started yet.`;

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

const BOOLEAN_OPTIONS = new Set(['json', 'jsonl', 'text', 'follow', 'stdin', 'receipt-only', 'confirm', 'raw', 'help', 'no-rules']);
const VALUE_OPTIONS = new Set(['session', 'group', 'thread', 'idempotency-key', 'file', 'wait-until', 'timeout', 'expect-reply', 'response-kind', 'metadata', 'task-envelope', 'expires-at', 'since', 'after-id', 'cursor', 'consumer', 'limit', 'from', 'kind', 'name', 'cwd', 'task', 'pane', 'lines', 'if-version', 'origin']);
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
  const requestedAction = options.help ? 'help' : positional.shift() ?? 'status';
  // A discoverable read-only entry point, sharing capture's existing scope and transport.
  if (requestedAction === 'capture') {
    if (positional.length !== 1) throw new Error('Usage: td collab capture <session-id> [--lines 1..10000] [--raw] [--text]');
    positional.push('capture');
  }
  const action = (requestedAction === 'capture' ? 'drive' : requestedAction === 'traits' ? 'role' : requestedAction) as CollaborationCommand['action'];
  if (!['status', 'inbox', 'send', 'handoff', 'reply', 'add', 'remove', 'spawn', 'message', 'cursor', 'rebind', 'role', 'rename', 'cleanup', 'drive', 'capabilities', 'transport', 'group', 'rules', 'help'].includes(action)) throw new Error('Unknown collaboration command; see td collab --help');
  if (typeof options.session === 'string' && !options.session.trim()) throw new Error('--session requires a non-empty full Termdock session id');
  if (options.pane && !/^%\d+$/.test(String(options.pane))) throw new Error('pane must be a tmux pane id such as %3');
  if (['json', 'jsonl', 'text'].filter((key) => options[key]).length > 1) throw new Error('Choose one output format');
  if (options['wait-until'] && !['queued', 'delivered'].includes(String(options['wait-until']))) throw new Error('wait-until must be queued or delivered');
  if (options['expect-reply'] && !['ack', 'result', 'any'].includes(String(options['expect-reply']))) throw new Error('expect-reply must be ack, result or any');
  if (options.timeout) duration(String(options.timeout));
  const command: CollaborationCommand = { action, json: !options.text, options };
  if (['send', 'reply', 'handoff'].includes(action)) {
    command.target = positional.shift(); command.message = positional.join(' ');
    if (!command.target || (!command.message && !options.file && !options.stdin)) throw new Error(`${action} requires a target and message`);
    if ([Boolean(command.message), Boolean(options.file), Boolean(options.stdin)].filter(Boolean).length !== 1) throw new Error('Choose inline body, --file, or --stdin');
  } else if (action === 'rules') {
    command.operation = positional.shift(); command.groupId = positional.shift(); command.message = positional.join(' ');
    if (!command.groupId || !['get', 'set', 'clear'].includes(command.operation ?? '')) throw new Error('Usage: td collab rules get|set|clear <group-id>');
    if (command.operation === 'set' ? [Boolean(command.message), Boolean(options.file), Boolean(options.stdin)].filter(Boolean).length !== 1
      : Boolean(command.message || options.file || options.stdin)) throw new Error('rules set requires inline text, --file or --stdin');
  } else if (action === 'group') {
    command.operation = positional.shift();
    if (command.operation !== 'save' || positional.length || !options.file) throw new Error('Usage: td collab group save --file group.json');
  } else if (action === 'transport') {
    command.operation = positional.shift(); command.groupId = positional.shift();
    if (positional.length || !['info', 'list', 'invite', 'accept', 'register'].includes(command.operation ?? '')) throw new Error('Usage: td collab transport info|list|invite|accept|register');
    if (command.operation === 'register') {
      if (!command.groupId || !options.file || options.origin) throw new Error('transport register requires <group-id> --file nodes.json');
    } else if (command.groupId || (['info', 'list'].includes(command.operation!) ? options.file || options.origin
      : !options.origin || (command.operation === 'accept' ? !options.file : options.file))) throw new Error('transport invite needs --origin; accept needs --origin and --file');
  } else if (action === 'message') {
    command.operation = positional.shift(); command.target = positional.shift();
    if (!['get', 'watch', 'confirm-shell'].includes(command.operation ?? '') || !command.target || positional.length) throw new Error('Usage: td collab message get|watch|confirm-shell <id>');
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
  const allowed = new Set(['json', 'jsonl', 'text', 'help', 'session']);
  const byAction: Record<string, string[]> = {
    rules: ['file', 'stdin', 'if-version'], transport: ['file', 'origin'], group: ['file'], status: [], capabilities: [], rebind: ['pane'], help: [...BOOLEAN_OPTIONS, ...VALUE_OPTIONS],
    send: ['group', 'thread', 'idempotency-key', 'file', 'stdin', 'wait-until', 'timeout', 'expect-reply', 'response-kind', 'metadata', 'expires-at', 'kind'],
    handoff: ['group', 'thread', 'idempotency-key', 'file', 'stdin', 'wait-until', 'timeout', 'expect-reply', 'response-kind', 'metadata', 'expires-at'],
    reply: ['idempotency-key', 'file', 'stdin', 'wait-until', 'timeout', 'expect-reply', 'response-kind', 'metadata', 'task-envelope', 'expires-at'],
    inbox: ['raw', 'since', 'after-id', 'cursor', 'consumer', 'limit', 'from', 'group', 'thread', 'kind', 'response-kind', 'follow', 'timeout'],
    message: ['raw', 'receipt-only', 'no-rules', 'follow', 'wait-until', 'timeout', 'expect-reply'], cursor: ['consumer'],
    add: [], remove: [], spawn: ['name', 'cwd', 'task'], role: [], rename: [], cleanup: ['confirm'], drive: ['lines', 'raw'],
  };
  for (const option of byAction[action]) allowed.add(option);
  for (const option of Object.keys(options)) if (!allowed.has(option)) throw new Error(`--${option} is not supported by ${action}`);
  if (options.lines && (!/^\d+$/.test(String(options.lines)) || Number(options.lines) < 1 || Number(options.lines) > 10000)) throw new Error('--lines must be 1..10000 history rows');
  if (action === 'drive' && command.operation !== 'capture' && (options.lines || options.raw)) throw new Error('--lines/--raw only apply to capture');
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
  const reached = stage === 'queued' || (stage === 'delivered' && ['delivered', 'read'].includes(receipt.status));
  return reached && (!reply || (reply === 'ack' ? receipt.ack_at != null : reply === 'result' ? receipt.result_ids?.length > 0 : receipt.reply_ids?.length > 0));
}

/** Delivery diagnoses a sender can act on. `delivered` means the bytes reached
 *  the recipient's pty — never that anything consumed them; these map the
 *  machine reasons onto what the sender should do next, so a settled-but-
 *  unconsumed message is not mistaken for a lost one (or a good one). */
const DELIVERY_DIAGNOSTICS: Record<string, string> = {
  AGENT_CONSUME_UNCONFIRMED: '消息已写入对方终端，但未确认被对方消费；它可能尚未开始处理，可用 capture 查看当前屏幕或重发',
  SHELL_CONFIRMATION_REQUIRED: '目标当前是 shell，消息可能被当命令执行；确认请运行 message confirm-shell <id>',
  DELIVERY_IN_PROGRESS: '投递进行中（写入前的中间标记，正常会在数秒内推进为 delivered 或带原因的重试）',
  TERMINAL_WRITE_FAILED: '写入对方终端失败，会按重试间隔继续尝试',
  TMUX_PANE_CHANGED: '目标面板已变化，投递已跳过，等待重新绑定',
  TMUX_PANE_IN_MODE: '目标面板处于 tmux 模式（如滚动查看），按键已跳过',
};
export function deliveryDiagnosticText(lastError: unknown): string {
  if (typeof lastError !== 'string' || !lastError) return '';
  const code = lastError.split(':', 1)[0]!.trim();
  const known = DELIVERY_DIAGNOSTICS[code];
  return known ? `${code}：${known}` : lastError;
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
      let diagnosed = false;
      if (Array.isArray(value.messages)) for (const message of value.messages) {
        const fanIds = Array.isArray(message.fanOutIds) ? (message.fanOutIds as string[]) : [];
        const names = (value.names as Record<string, string | null> | undefined) ?? {};
        io.write(`[${message.responseKind ?? message.kind}] ${canonicalShortId(message.id)} from ${message.fromSessionId ?? 'user'}${fanIds.length ? ' · 群发' : ''}`);
        // A fan-out dispatch names its sibling recipients so a broadcast is
        // never read as a one-to-one assignment; unknown ids stay raw.
        if (fanIds.length) io.write(`同时发给了:${fanIds.map((id) => names[id] ?? id).join('、')}`);
        io.write(message.content);
      }
      else if (value.message) {
        // One line instead of the full rules text — the CLI is stateless so it
        // cannot diff versions across calls; --no-rules silences it entirely.
        if (!o['no-rules'] && value.message.instructions?.text) io.write(`消息附群规版本 ${value.message.instructions.version}；td collab rules get <组id> --text 查看全文`);
        io.write(`[${value.status}] ${canonicalShortId(String(value.message_id ?? ''))}\n${value.message.content}`);
        // A pending message keeps retrying by design (the alternative is
        // dropping it); surface why and when the next attempt is so the sender
        // can decide to wait or resend instead of guessing.
        if (value.status === 'pending' && (value.attempt_count || value.last_error)) {
          const retryIn = value.next_retry_at ? Math.max(0, Math.ceil((Number(value.next_retry_at) - now()) / 1000)) : null;
          io.write(`投递中：第 ${value.attempt_count ?? 0} 次尝试${retryIn !== null ? `，下次重试约 ${retryIn} 秒后` : ''}${value.last_error ? `，最近原因 ${deliveryDiagnosticText(value.last_error)}` : ''}`);
          diagnosed = true;
        }
      }
      else if (value.message_id) {
        io.write(`${value.status} ${canonicalShortId(String(value.message_id))}${value.thread_id ? ` thread=${canonicalShortId(String(value.thread_id))}` : ''}${value.code ? ` ${value.code}` : ''}${value.failure_reason ? ` ${value.failure_reason}` : ''}`);
        // A timeout after the wait stage itself was reached means delivery
        // completed — only the expected reply/result is late.
        if (value.code === 'WAIT_TIMEOUT' && value.stage_reached && value.expect_reply) {
          io.write(`\n投递已完成；等待${value.expect_reply === 'result' ? '结果' : '回复'}超时（expect-reply=${value.expect_reply}）`);
        }
        // The screen rides the receipt as the delivery credential: the service
        // observes terminal writes, never reading, so this capture is the only
        // evidence the message actually landed. Kept visible in --text, but
        // fenced and labelled so it cannot be mistaken for delivery state.
        if (value.snapshot) io.write(`\n对方终端当前屏幕（凭证：确认你的消息已写入；不代表已读或任务完成）：\n───\n${value.snapshot}\n───`);
      }
      else io.write(JSON.stringify(value, null, 2));
      if (value.last_error && !diagnosed) io.write(`诊断：${deliveryDiagnosticText(value.last_error)}`);
      if (value.next_cursor) io.write(`next_cursor=${value.next_cursor} has_more=${value.has_more}`);
    } else if (o.jsonl && Array.isArray(value.messages) && command.action === 'inbox') {
      for (const message of value.messages) io.write(JSON.stringify({ type: 'message', ...message }));
      io.write(JSON.stringify({ type: 'cursor', next_cursor: value.next_cursor, has_more: value.has_more, retention_gap: value.retention_gap ?? false, consumer: value.consumer }));
    } else io.write(JSON.stringify(value, null, o.jsonl || o.follow || command.operation === 'watch' ? undefined : 2));
  };
  let receipt: Json | undefined;
  let idempotencyKey: string | undefined;
  try {
    if (command.action === 'rules') {
      let body: Json;
      if (command.operation === 'get') body = await request('GET', `/rules?group=${encodeURIComponent(command.groupId!)}`);
      else {
        if (o.stdin && !io.stdin) throw new Error('stdin is unavailable');
        if (o.file && fs.statSync(String(o.file)).size > 8192) throw new Error('群规最多 8192 UTF-8 字节');
        const text = command.operation === 'clear' ? '' : o.file ? fs.readFileSync(String(o.file), 'utf8') : o.stdin ? await io.stdin!() : command.message!;
        body = await request('POST', '/rules', { group_id: command.groupId, text, expected_version: o['if-version'] });
      }
      if (o.text) io.write(`群规版本：${body.instructions?.version ?? '未设置'}\n${body.instructions?.text ?? ''}`); else output(body);
      return 0;
    }
    if (command.action === 'group') {
      if (fs.statSync(String(o.file)).size > 64 * 1024) throw new Error('Group input exceeds 64 KiB');
      const saved = await request('POST', '/group', { input: JSON.parse(fs.readFileSync(String(o.file), 'utf8')) }) as { group?: { id?: string; name?: string; sessionIds?: string[]; updatedAt?: number } };
      if (o.text && saved.group) {
        io.write(`已保存协作组「${saved.group.name ?? saved.group.id ?? ''}」（${saved.group.sessionIds?.length ?? 0} 个成员，updatedAt=${saved.group.updatedAt ?? '未知'}）`);
      } else output(saved);
      return 0;
    }
    if (command.action === 'transport') {
      if (command.operation === 'info') output(await request('GET', '/transport'));
      else if (command.operation === 'list') output(await request('GET', '/directory'));
      else if (command.operation === 'invite') output(await request('POST', '/transport/invite', { origin: o.origin }));
      else {
        if (fs.statSync(String(o.file)).size > 64 * 1024) throw new Error('Peer registration is too large');
        const raw = fs.readFileSync(String(o.file), 'utf8');
        if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Peer registration is too large');
        output(await request('POST', command.operation === 'accept' ? '/transport/accept' : '/transport', command.operation === 'accept'
          ? { origin: o.origin, invitation: JSON.parse(raw) } : { groupId: command.groupId, nodes: JSON.parse(raw) }));
      }
      return 0;
    }
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
          io.write('给成员发消息: td collab send <成员id> "消息内容" --text（成员 id 见上表）');
        }
      } catch { /* help stays available without a server or session */ }
      return 0;
    }
    if (command.action === 'capabilities' || command.action === 'status') {
      const result = await request('GET', command.action === 'status' ? '/peers' : '/capabilities') as Json & { source?: { sessionId?: string; name?: string }; peers?: Array<Json & { sessionId?: string; name?: string }>; groups?: Array<Json> };
      if (command.action === 'status' && o.text) {
        // Human-readable status: no JSON dump, one line per fact.
        const source = result.source as { sessionId?: string; name?: string } | undefined;
        if (source?.sessionId) io.write(`我:${source.name ?? ''}（${source.sessionId}）`);
        for (const peer of result.peers ?? []) {
          const facts = peer as { sessionId?: string; name?: string; status?: string; output_idle_seconds?: number; last_terminal_output_at?: number; activity_observed_at?: number };
          const line = `- ${facts.name || facts.sessionId}（${facts.sessionId}）${facts.status ? ` · ${facts.status}` : ''}`;
          io.write(line);
          if (facts.last_terminal_output_at && facts.activity_observed_at) {
            io.write(`  观测时距终端输出 ${facts.output_idle_seconds ?? Math.max(0, Math.floor((facts.activity_observed_at - facts.last_terminal_output_at) / 1000))} 秒（不代表任务进度）`);
          }
        }
        for (const group of result.groups ?? []) {
          const view = group as unknown as RoleGroupView;
          io.write(`组「${view.name}」成员定位：`);
          const peersAndSource = [...(result.peers ?? []), result.source] as Array<{ sessionId?: string; name?: string } | undefined>;
          for (const id of view.sessionIds ?? []) {
            const member = peersAndSource.find(item => item?.sessionId === id);
            io.write(roleLine({ sessionId: id, name: member?.name }, view.roles?.[id]));
          }
        }
        io.write('查看伙伴当前屏幕（只读，仅本机 tmux）：');
        for (const peer of result.peers ?? []) {
          const id = (peer as { sessionId?: string }).sessionId;
          const name = (peer as { name?: string }).name;
          if (typeof id !== 'string' || id === source?.sessionId) continue;
          io.write(`- ${name || id}：${id.startsWith('remote:')
            ? `远端成员，请用 td collab send ${id} "当前进展？" --text`
            : `td collab capture ${id} --text`}`);
        }
        return 0;
      }
      output(result);
      return 0;
    }
    if (command.action === 'rebind') { output(await request('POST', '/route/rebind', { pane: o.pane ?? null })); return 0; }
    if (command.action === 'inbox') {
      let cursor = o.cursor as string | undefined;
      do {
        const params = new URLSearchParams();
        for (const key of ['raw', 'since', 'after-id', 'consumer', 'limit', 'from', 'group', 'thread', 'kind', 'response-kind']) if (o[key]) params.set(key.replaceAll('-', '_'), String(o[key]));
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
      if (command.operation === 'confirm-shell') { output(await request('POST', `${route}/${command.operation}`)); return 0; }
      receipt = await request('GET', `${route}?receipt_only=${Boolean(o['receipt-only'] || command.operation === 'watch')}&raw=${Boolean(o.raw)}`);
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
          ? `定位已设置：${command.sessionId} = ${(body.group as { roles?: Record<string, string> }).roles?.[command.sessionId!] ?? ''}\n（改成员显示名: td collab rename ${command.sessionId} <新名字>）`
          : `定位已清除：${command.sessionId}`);
      } else output(body);
      return 0;
    } else if (command.action === 'rename') {
      const body = await request('POST', '/name', { session_id: command.sessionId, name: command.name });
      if (o.text) io.write(`已改名：${command.sessionId} = ${(body as { name?: string }).name ?? command.name}`);
      else output(body);
      return 0;
    } else if (command.action === 'drive') {
      const body = await request('POST', '/drive', { session: command.sessionId, action: command.operation, text: command.message, ...(o.lines ? { lines: Number(o.lines) } : {}), ...(o.raw ? { raw: true } : {}) });
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
    const stage = String(o['wait-until'] ?? (command.action === 'message' ? 'delivered' : 'queued'));
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
          expect_reply: o['expect-reply'] ?? null, delivery_continues: true,
          delivery: receipt!.delivery ?? { status: receipt!.status },
          reply: { ...receipt!.reply, status: o['expect-reply'] ? 'timeout' : receipt!.reply?.status ?? 'pending', expected: o['expect-reply'] ?? null } });
        return 2;
      }
      await sleep(Math.min(500, deadline - now()));
      if (now() >= deadline) continue;
      receipt = { ...await request('GET', `/message/${encodeURIComponent(receipt!.message_id)}?receipt_only=true`), ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) };
    }
  } catch (error) {
    if (receipt && now() >= deadline) { output({ ...receipt, ok: false, code: 'WAIT_TIMEOUT', delivery_continues: true, last_error: error instanceof Error ? error.message : String(error) }); return 2; }
    const code = error instanceof CollaborationError ? error.code : 'COLLABORATION_ERROR';
    const message = error instanceof Error ? error.message : String(error);
    if (o.text) {
      // Single-line errors in text mode; the enqueued-message hint keeps a
      // mid-wait failure from reading as a lost message.
      io.write(`${code}: ${message}${receipt?.message_id ? `（消息 ${canonicalShortId(String(receipt.message_id))} 已入队，投递继续）` : ''}`);
      return 1;
    }
    output({ ...(receipt ?? {}), ok: false, code,
      error: message, ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}), ...(receipt ? { delivery_continues: true } : {}) });
    return 1;
  }
}
