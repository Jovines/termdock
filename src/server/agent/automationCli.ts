import fs from 'node:fs';
import path from 'node:path';
import type { AutomationSchedule } from './automationStore.js';

export const AUTOMATION_HELP = `td automation — manage scheduled tasks on the local Termdock service
  list
  create --name <name> (--every <minutes> | --at HH:MM [--weekdays 0,1,...,6])
    (--self | --session <full-session-id> | --command <launch-command>)
    [--prompt <text> | --file <path> | --stdin] [--cwd <path>] [--disabled]
  show|run|pause|resume|delete <automation-id>
  --json (default) | --text
--self resolves this Termdock session, including surviving tmux panes after restart.
--session targets an existing local session; --command without a target opens a new one.
Targeted tasks require a running Agent when due. Daily times use the server timezone;
weekdays: 0=Sunday, 1=Monday, ..., 6=Saturday (default: every day).
Intervals are whole minutes, 1–43200. Tasks repeat while enabled and the service runs.
run dispatches immediately; success means delivered, not Agent work completed.
Examples:
  td automation create --name '进度复查' --every 30 --self --prompt '检查协作组进度并继续推进'
  td automation create --name '每日巡检' --at 09:00 --weekdays 1,2,3,4,5 --command claude --file task.txt
  td automation pause <automation-id>
Exit codes: 0 success; 1 invalid arguments, unavailable session/service, or request failure.`;

export interface AutomationCommand {
  action: 'help' | 'list' | 'create' | 'show' | 'run' | 'pause' | 'resume' | 'delete';
  id?: string;
  options: Record<string, string | boolean>;
  schedule?: AutomationSchedule;
}
const flags = new Set(['help', 'json', 'text', 'self', 'stdin', 'disabled']);
const values = new Set(['name', 'every', 'at', 'weekdays', 'session', 'command', 'prompt', 'file', 'cwd']);
export function parseAutomationCommand(argv: string[]): AutomationCommand {
  const options: AutomationCommand['options'] = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [key, ...inline] = arg.slice(2).split('=');
    if (key in options) throw new Error(`Duplicate option: --${key}`);
    if (flags.has(key)) {
      if (inline.length) throw new Error(`--${key} takes no value`);
      options[key] = true;
    } else if (values.has(key)) {
      const value = inline.length ? inline.join('=') : argv[++i];
      if (!value?.trim() || (!inline.length && value.startsWith('--'))) throw new Error(`--${key} requires a value`);
      options[key] = value;
    } else throw new Error(`Unknown automation option: --${key}`);
  }
  const action = (options.help ? 'help' : positional.shift() ?? 'help') as AutomationCommand['action'];
  if (!['help', 'list', 'create', 'show', 'run', 'pause', 'resume', 'delete'].includes(action)) throw new Error('Unknown command; see td automation --help');
  if (options.json && options.text) throw new Error('Choose --json or --text');
  const command: AutomationCommand = { action, options };
  if (action === 'help') return command;
  if (action !== 'create') {
    for (const key of Object.keys(options)) if (!['json', 'text'].includes(key)) throw new Error(`--${key} is not supported by ${action}`);
    if (action !== 'list') {
      command.id = positional.shift();
      if (!command.id) throw new Error(`${action} requires an automation id`);
    }
  } else {
    if (!options.name) throw new Error('--name is required');
    if (Boolean(options.every) === Boolean(options.at)) throw new Error('Choose --every or --at');
    if (options.every) {
      const minutes = Number(options.every);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200) throw new Error('--every must be an integer from 1 to 43200');
      if (options.weekdays) throw new Error('--weekdays requires --at');
      command.schedule = { kind: 'interval', everyMinutes: minutes };
    } else {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(options.at))) throw new Error('--at must be HH:MM');
      if (options.weekdays && !/^[0-6](,[0-6])*$/.test(String(options.weekdays))) throw new Error('--weekdays must be comma-separated numbers 0–6');
      command.schedule = { kind: 'daily', time: String(options.at), weekdays: options.weekdays ? [...new Set(String(options.weekdays).split(',').map(Number))] : [0, 1, 2, 3, 4, 5, 6] };
    }
    if (options.self && options.session) throw new Error('Choose --self or --session');
    if (!options.self && !options.session && !options.command) throw new Error('New sessions require --command; use --self or --session for an existing Agent');
    const prompts = ['prompt', 'file', 'stdin'].filter(key => options[key]);
    if (prompts.length > 1) throw new Error('Choose --prompt, --file or --stdin');
    if (!prompts.length && !options.command) throw new Error('A prompt or command is required');
  }
  if (positional.length) throw new Error(`Unexpected arguments for ${action}`);
  return command;
}

export interface AutomationCliIO {
  request(method: 'GET' | 'POST' | 'DELETE', endpoint: string, body?: unknown): Promise<{ statusCode: number; body: string }>;
  self(): Promise<string>;
  stdin(): Promise<string>;
  write(line: string): void;
}
export async function executeAutomationCommand(command: AutomationCommand, io: AutomationCliIO): Promise<number> {
  try {
    if (command.action === 'help') { io.write(AUTOMATION_HELP); return 0; }
    const base = '/api/terminal/operations/automations';
    const request = async (method: 'GET' | 'POST' | 'DELETE', endpoint: string, body?: unknown) => {
      const response = await io.request(method, endpoint, body);
      const data = response.statusCode === 204 ? { ok: true } : JSON.parse(response.body);
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(data.error || `Request failed (${response.statusCode})`);
      return data;
    };
    let result;
    if (command.action === 'create') {
      const o = command.options;
      const prompt = o.file ? fs.readFileSync(String(o.file), 'utf8') : o.stdin ? await io.stdin() : String(o.prompt ?? '');
      if (!prompt.trim() && !o.command) throw new Error('Prompt must not be empty');
      const targetSessionId = o.self ? await io.self() : o.session || null;
      result = await request('POST', base, {
        name: o.name, schedule: command.schedule, enabled: !o.disabled,
        ...(o.cwd ? { cwd: path.resolve(String(o.cwd)) } : !targetSessionId ? { cwd: process.cwd() } : {}),
        command: String(o.command ?? ''), prompt, targetSessionId,
      });
    } else if (command.action === 'list' || command.action === 'show') {
      result = await request('GET', base);
      if (command.action === 'show') {
        const automation = result.automations.find((item: { id: string }) => item.id === command.id);
        if (!automation) throw new Error('Automation not found');
        result = { automation, runs: result.runs.filter((run: { automationId: string }) => run.automationId === command.id) };
      }
    } else {
      const route = `${base}/${encodeURIComponent(command.id!)}`;
      result = command.action === 'delete' ? await request('DELETE', route)
        : command.action === 'run' ? await request('POST', `${route}/run`, {})
        : await request('POST', `${route}/enabled`, { enabled: command.action === 'resume' });
    }
    io.write(JSON.stringify(result, null, command.options.text ? 2 : undefined));
    return 0;
  } catch (error) {
    io.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return 1;
  }
}
