import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export const TODO_HELP = `td todo — persistent todos on the local Termdock service
  list
  add --title <title> [--description <text> | --file <path> | --stdin]
    [--source <direction>] [--external-id <stable-id>] [--url <https-url>]
    [--collector <collector-id>] [--idempotency-key <key>]
  report <run-id> --status complete|blocked|failed (--content <text> | --file <path> | --stdin)
  complete|reopen|ignore <todo-id>
  --help | --json
External IDs deduplicate within a source. Reports attach to the exact execution run;
only complete marks a todo completed. An Agent report never accepts a todo for the user.
Use the running local service (same OS user); no unauthenticated HTTP fallback.`;
export interface TodoCommand { action: 'help' | 'list' | 'add' | 'report' | 'complete' | 'reopen' | 'ignore'; id?: string; options: Record<string, string | boolean> }
export function parseTodoCommand(argv: string[]): TodoCommand {
  const positional: string[] = [], options: TodoCommand['options'] = {};
  const values = ['title', 'description', 'file', 'source', 'external-id', 'url', 'collector', 'idempotency-key', 'status', 'content'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [key, ...inline] = arg.slice(2).split('=');
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option --${key}`);
    if (['help', 'json', 'stdin'].includes(key)) { if (inline.length) throw new Error(`--${key} takes no value`); options[key] = true; }
    else if (values.includes(key)) { const value = inline.length ? inline.join('=') : argv[++i]; if (!value || (!inline.length && value.startsWith('--'))) throw new Error(`--${key} requires a value`); options[key] = value; }
    else throw new Error(`Unknown option --${key}`);
  }
  const action = (options.help ? 'help' : positional.shift() ?? 'help') as TodoCommand['action'];
  if (!['help', 'list', 'add', 'report', 'complete', 'reopen', 'ignore'].includes(action)) throw new Error('See td todo --help');
  if (action === 'help') return { action, options };
  const allowed: Record<string, string[]> = { list: [], add: ['title', 'description', 'file', 'stdin', 'source', 'external-id', 'url', 'collector', 'idempotency-key'], report: ['status', 'content', 'file', 'stdin'], complete: [], reopen: [], ignore: [] };
  for (const flag of Object.keys(options)) if (flag !== 'json' && !allowed[action].includes(flag)) throw new Error(`--${flag} is not supported by ${action}`);
  const id = !['list', 'add'].includes(action) ? positional.shift() : undefined;
  if ((!['list', 'add'].includes(action) && !id) || positional.length) throw new Error('Invalid arguments; see td todo --help');
  if (action === 'add' && !options.title) throw new Error('--title is required');
  if (['description', 'content', 'file', 'stdin'].filter(k => options[k]).length > 1) throw new Error('Choose one content input');
  if (action === 'report' && (!['complete', 'blocked', 'failed'].includes(String(options.status)) || !['content', 'file', 'stdin'].some(k => options[k]))) throw new Error('report requires --status and content');
  return { action, id, options };
}
export async function executeTodoCommand(command: TodoCommand, io: {
  request(method: 'GET' | 'POST', endpoint: string, body?: unknown): Promise<{ statusCode: number; body: string }>;
  stdin(): Promise<string>; write(line: string): void;
}): Promise<number> {
  try {
    if (command.action === 'help') { io.write(TODO_HELP); return 0; }
    const base = '/api/terminal/operations/todos', o = command.options;
    const request = async (method: 'GET' | 'POST', suffix = '', body?: unknown) => { const response = await io.request(method, base + suffix, body); const data = JSON.parse(response.body); if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(data.error || 'Todo request failed'); return data; };
    const content = o.file ? fs.readFileSync(String(o.file), 'utf8') : o.stdin ? await io.stdin() : String(o.content ?? o.description ?? '');
    let result;
    if (command.action === 'list') result = await request('GET');
    else if (command.action === 'add') result = await request('POST', '', { title: o.title, description: content, source: o.source || '外部注入', sourceUrl: o.url, externalId: o['external-id'], collectorId: o.collector, idempotencyKey: o['idempotency-key'] || randomUUID() });
    else if (command.action === 'report') result = await request('POST', `/runs/${encodeURIComponent(command.id!)}/report`, { status: o.status, content });
    else { const snapshot = await request('GET'); const todo = snapshot.todos.find((t: { id: string }) => t.id === command.id); if (!todo) throw new Error('Todo not found'); result = await request('POST', `/${encodeURIComponent(command.id!)}`, { revision: todo.revision, status: command.action === 'complete' ? 'completed' : command.action === 'ignore' ? 'ignored' : 'open' }); }
    io.write(JSON.stringify(result)); return 0;
  } catch (error) { io.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); return 1; }
}
