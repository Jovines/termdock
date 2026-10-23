import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { nextAutomationRunAt, normalizeAutomationSchedule } from '../agent/automationStore.js';
import type { TodoCollector, TodoCreateInput, TodoItem, TodoLaunchConfig, TodoRun, TodoSnapshot } from './types.js';

interface Document extends TodoSnapshot { version: 1; requests: Record<string, { hash: string; id: string }> }
export class TodoError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
function string(value: unknown, max: number, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new TodoError('内容格式或长度无效');
  return value.trim();
}
function title(value: unknown): string { const s = string(value, 200); if (!s) throw new TodoError('请填写标题'); return s; }
export function launchConfig(input: Partial<TodoLaunchConfig>, base?: TodoLaunchConfig): TodoLaunchConfig {
  return { agentSlug: string(input.agentSlug, 100, base?.agentSlug), command: string(input.command, 4000, base?.command),
    cwd: string(input.cwd, 4096, base?.cwd), prompt: string(input.prompt, 20000, base?.prompt) };
}
const blank = (): Document => ({ version: 1, todos: [], collectors: [], runs: [], requests: {}, defaults: { agentSlug: '', command: '', cwd: '', prompt: '' } });
export class TodoStore {
  private doc: Document = blank();
  constructor(private readonly file: string) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Document;
      if (doc.version !== 1 || !Array.isArray(doc.todos) || !Array.isArray(doc.collectors) || !Array.isArray(doc.runs) || !doc.requests || !doc.defaults) throw new Error('无效的 Todo 数据文件');
      this.doc = doc;
      // Never replay a launch after a crash: it might already have reached a terminal.
      if (doc.runs.some(r => r.status === 'launching')) this.transaction(next => {
        for (const run of next.runs) if (run.status === 'launching') { run.status = 'failed'; run.error = '服务重启中断了启动确认，请检查已有终端后重新发起'; run.updatedAt = Date.now(); }
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private transaction<T>(change: (doc: Document) => T): T {
    const next = structuredClone(this.doc), result = change(next);
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) throw new TodoError('待办记录已达容量上限，请整理后重试', 409);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    const directory = fs.openSync(path.dirname(this.file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    this.doc = next; return structuredClone(result);
  }
  openCount(): number { return this.doc.todos.filter(t => t.status === 'open').length; }
  snapshot(): TodoSnapshot { const { requests: _, version: _v, ...snapshot } = this.doc; return structuredClone(snapshot); }
  get(id: string): TodoItem { const todo = this.doc.todos.find(t => t.id === id); if (!todo) throw new TodoError('待办不存在', 404); return structuredClone(todo); }
  collector(id: string): TodoCollector { const collector = this.doc.collectors.find(c => c.id === id); if (!collector) throw new TodoError('收集方向不存在', 404); return structuredClone(collector); }
  run(id: string): TodoRun { const run = this.doc.runs.find(r => r.id === id); if (!run) throw new TodoError('执行记录不存在', 404); return structuredClone(run); }
  private check(revision: unknown, current: number) { if (revision !== current) throw new TodoError('记录已更新，请刷新后重试', 409); }
  create(input: TodoCreateInput): TodoItem {
    const sourceUrl = string(input.sourceUrl, 4096);
    if (sourceUrl) { try { if (!['http:', 'https:'].includes(new URL(sourceUrl).protocol)) throw new Error(); } catch { throw new TodoError('来源链接须为有效的 http 或 https 地址'); } }
    const collectorId = string(input.collectorId, 100) || null;
    const collectorName = collectorId ? this.doc.collectors.find(c => c.id === collectorId)?.name ?? this.doc.runs.find(r => r.collectorId === collectorId)?.name : null;
    if (collectorId && !collectorName) throw new TodoError('收集方向不存在', 404);
    const values = { title: title(input.title), description: string(input.description, 40000), source: string(input.source, 200, collectorName ?? '手动添加') || '外部注入',
      sourceUrl, externalId: string(input.externalId, 500), collectorId };
    const key = string(input.idempotencyKey, 200);
    const hash = this.hash(values);
    const previous = key && this.doc.requests[`create:${key}`];
    if (previous) { if (previous.hash !== hash) throw new TodoError('同一请求标识的内容不一致', 409); return this.get(previous.id); }
    const existing = values.externalId && this.doc.todos.find(t => t.source === values.source && t.externalId === values.externalId);
    if (existing) return structuredClone(existing);
    return this.transaction(doc => {
      const now = Date.now(); const todo: TodoItem = { ...values, id: randomUUID(), status: 'open', createdAt: now, updatedAt: now, revision: 1 };
      doc.todos.unshift(todo); if (key) doc.requests[`create:${key}`] = { hash, id: todo.id }; return todo;
    });
  }
  update(id: string, input: { revision: number; title?: string; description?: string; status?: TodoItem['status'] }): TodoItem {
    return this.transaction(doc => {
      const todo = doc.todos.find(t => t.id === id); if (!todo) throw new TodoError('待办不存在', 404); this.check(input.revision, todo.revision);
      if (input.title !== undefined) todo.title = title(input.title);
      if (input.description !== undefined) todo.description = string(input.description, 40000);
      if (input.status !== undefined) { if (!['open', 'completed', 'ignored'].includes(input.status)) throw new TodoError('待办状态无效'); todo.status = input.status; }
      todo.revision++; todo.updatedAt = Date.now(); return todo;
    });
  }
  defaults(input: Partial<TodoLaunchConfig>): TodoLaunchConfig { const config = launchConfig(input, this.doc.defaults); return this.transaction(doc => doc.defaults = config); }
  saveCollector(input: Partial<TodoCollector> & { name: string; config: TodoLaunchConfig }): TodoCollector {
    const name = title(input.name), config = launchConfig(input.config);
    if (!config.agentSlug || !config.command || !config.prompt) throw new TodoError('请选择 Agent 并填写收集提示词');
    const schedule = input.schedule == null ? null : normalizeAutomationSchedule(input.schedule);
    if (input.schedule != null && !schedule) throw new TodoError('运行频率无效');
    return this.transaction(doc => {
      const previous = input.id ? doc.collectors.find(c => c.id === input.id) : null;
      if (input.id && !previous) throw new TodoError('收集方向不存在', 404);
      if (previous) this.check(input.revision, previous.revision);
      const now = Date.now(), enabled = input.enabled !== false;
      const collector: TodoCollector = { id: previous?.id ?? randomUUID(), name, config, enabled, schedule,
        nextRunAt: schedule && enabled ? (previous?.enabled && JSON.stringify(previous.schedule) === JSON.stringify(schedule) ? previous.nextRunAt : nextAutomationRunAt(schedule, now, now)) : null,
        createdAt: previous?.createdAt ?? now, updatedAt: now, revision: (previous?.revision ?? 0) + 1 };
      if (previous) Object.assign(previous, collector); else doc.collectors.push(collector); return collector;
    });
  }
  removeCollector(id: string, revision: number): void { this.transaction(doc => { const c = doc.collectors.find(c => c.id === id); if (!c) throw new TodoError('收集方向不存在', 404); this.check(revision, c.revision); doc.collectors = doc.collectors.filter(c => c.id !== id); }); }
  due(now = Date.now()): TodoCollector[] { return this.doc.collectors.filter(c => c.enabled && c.nextRunAt !== null && c.nextRunAt <= now).map(c => structuredClone(c)); }
  begin(kind: TodoRun['kind'], id: string, config: TodoLaunchConfig, key: string): { run: TodoRun; fresh: boolean } {
    if (!key || key.length > 200) throw new TodoError('缺少有效的请求标识');
    const hash = this.hash({ kind, id, config });
    const previous = this.doc.requests[`run:${key}`];
    if (previous) { if (previous.hash !== hash) throw new TodoError('同一请求标识的内容不一致', 409); return { run: this.run(previous.id), fresh: false }; }
    const item = kind === 'execute' ? this.get(id) : this.collector(id);
    if (kind === 'execute' && (item as TodoItem).status !== 'open') throw new TodoError('请先重新打开这条待办', 409);
    if (this.doc.runs.some(r => r.status === 'launching' && (kind === 'execute' ? r.todoId === id : r.collectorId === id))) throw new TodoError('此项正在启动，请稍候', 409);
    return this.transaction(doc => {
      const now = Date.now(); const run: TodoRun = { id: randomUUID(), kind, todoId: kind === 'execute' ? id : null, collectorId: kind === 'collect' ? id : null,
        name: kind === 'execute' ? (item as TodoItem).title : (item as TodoCollector).name, config, status: 'launching', createdAt: now, updatedAt: now, sessionId: null, result: '', error: '' };
      doc.runs.push(run); doc.requests[`run:${key}`] = { hash, id: run.id };
      if (kind === 'collect') { const c = doc.collectors.find(c => c.id === id)!; c.nextRunAt = c.schedule && c.enabled ? nextAutomationRunAt(c.schedule, now + 1, c.createdAt) : null; c.updatedAt = now; c.revision++; }
      return { run, fresh: true };
    });
  }
  mark(id: string, update: { sessionId?: string; status?: 'delivered' | 'failed'; error?: string }): TodoRun {
    return this.transaction(doc => {
      const run = doc.runs.find(r => r.id === id); if (!run) throw new TodoError('执行记录不存在', 404);
      if (update.sessionId) run.sessionId = update.sessionId;
      // An Agent can submit its report before launch delivery acknowledgement returns.
      if (run.status === 'launching') { if (update.status) run.status = update.status; if (update.error) run.error = update.error; }
      run.updatedAt = Date.now(); return run;
    });
  }
  report(id: string, status: 'complete' | 'blocked' | 'failed', content: string): TodoRun {
    if (!['complete', 'blocked', 'failed'].includes(status)) throw new TodoError('结果状态无效');
    const result = string(content, 40000); if (!result) throw new TodoError('请填写结果');
    return this.transaction(doc => { const run = doc.runs.find(r => r.id === id); if (!run) throw new TodoError('执行记录不存在', 404);
      if (run.result && (run.status !== status || run.result !== result)) throw new TodoError('此轮已有结果，请发起新一轮执行', 409);
      run.status = status; run.result = result; run.updatedAt = Date.now(); return run; });
  }
  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
