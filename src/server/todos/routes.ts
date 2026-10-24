import { Router, type Request, type Response } from 'express';
import { collectionSessionPolicy, processingPolicy, launchConfig, TodoError, TodoStore } from './store.js';
import { CollectionSessionLifecycle, type CollectionSessionRuntime } from './sessionLifecycle.js';
import type { TodoHandoffInput, TodoLaunchConfig, TodoRun } from './types.js';

export interface TodoRuntime {
  collectionSessions?: CollectionSessionRuntime;
  validate(config: TodoLaunchConfig, req?: Request): Promise<TodoLaunchConfig>;
  launch(run: TodoRun, prompt: string, onSession: (id: string) => void, req?: Request): Promise<void>;
  claimTarget?(input: { sessionId?: string; backendSessionId?: string }): Promise<{ sessionId: string; name: string; config: TodoLaunchConfig }>;
  target?(id: string, req?: Request): Promise<{ config: TodoLaunchConfig; name: string; mode?: 'shell' | 'tmux' }>;
  deliver?(run: TodoRun, prompt: string, req?: Request): Promise<void>;
}
export function handoffPrompt(store: TodoStore, run: TodoRun): string {
  return [run.handoff!.todoIds.length === 1 ? '请处理这条待办：' : '请一起处理这些待办：',
    ...run.handoff!.todoIds.map((id, index) => { const todo = store.get(id); return `${index + 1}. ${todo.title}\n${todo.description}\n来源：${todo.source}${todo.sourceUrl ? `\n参考来源：${todo.sourceUrl}` : ''}`; }),
    run.handoff!.note ? `我的补充要求：\n${run.handoff!.note}` : '',
  ].filter(Boolean).join('\n\n');
}
function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\"'\"'") + "'"; }
export function todoPrompt(store: TodoStore, run: TodoRun): string {
  const report = `完成或受阻时，请将结果写入一个 UTF-8 文件，并调用 td todo report ${run.id} --status complete --file <文件路径>；受阻时将 complete 换为 blocked，失败时换为 failed。报告只记录本次结果，由用户决定待办是否完成。`;
  if (run.kind === 'collect') return `${run.config.prompt}\n\n请将收集到的每条可执行待办通过本机 CLI 写入 Termdock，避免只输出列表。使用：\ntd todo add --title <标题> --description <描述> --source ${shellQuote(run.name)} --collector ${run.collectorId} --external-id <在此方向中稳定且唯一的标识>\n请附带必要上下文和可选的 --url https://... 。先用 td todo list 查看已有待办，避免重复。只收集待办，本轮不执行这些待办。\n${report}`;
  const todo = store.get(run.todoId!);
  return `${run.config.prompt || '请处理下面这条待办，完成后说明结果和验证情况。'}\n\n待办：${todo.title}\n${todo.description}\n来源：${todo.source}\n${todo.sourceUrl ? `来源链接：${todo.sourceUrl}\n` : ''}\n待办 ID：${todo.id}\n执行记录 ID：${run.id}\n${report}`;
}
export class TodoRunner {
  private readonly sessions?: CollectionSessionLifecycle;
  constructor(readonly store: TodoStore, private readonly runtime: TodoRuntime) {
    if (runtime.collectionSessions) this.sessions = new CollectionSessionLifecycle(store, runtime.collectionSessions);
  }
  async start(kind: TodoRun['kind'], id: string, input: Partial<TodoLaunchConfig> | undefined, key: string, req?: Request): Promise<TodoRun> {
    // Read-only validation happens before reserving a run; launch is always recorded before any side effect.
    const base = kind === 'collect' ? this.store.collector(id).config : this.store.snapshot().defaults;
    const config = await this.runtime.validate(launchConfig(input ?? {}, base), req);
    const { run, fresh } = this.store.begin(kind, id, config, key);
    const created = (sessionId: string) => { this.store.mark(run.id, { sessionId }); };
    const prompt = fresh ? todoPrompt(this.store, run) : '';
    const launch = () => this.runtime.launch(run, prompt, created, req);
    if (fresh) void (kind === 'collect' && this.sessions ? this.sessions.collect(run, prompt, created, launch) : launch())
      .then(() => this.store.mark(run.id, { status: 'delivered' }))
      .catch(error => { this.store.mark(run.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }); });
    return run;
  }
  async handoff(body: TodoHandoffInput, req?: Request): Promise<TodoRun> {
    if (!body || !Array.isArray(body.todoIds) || !body.todoIds.length || body.todoIds.length > 50 || body.todoIds.some(id => typeof id !== 'string')
      || typeof body.note !== 'string' || body.note.length > 4000 || body.note.includes('\0') || typeof body.idempotencyKey !== 'string'
      || (body.sessionId !== undefined && (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 200))
      || (body.sessionId && body.config)) throw new TodoError('请选择待办和目标会话，补充要求最多 4000 字');
    const input: TodoHandoffInput = { todoIds: [...new Set(body.todoIds)], note: body.note.trim(), idempotencyKey: body.idempotencyKey,
      ...(body.sessionId ? { sessionId: body.sessionId } : { config: launchConfig(body.config ?? {}, this.store.snapshot().defaults) }) };
    const previous = this.store.previousHandoff(input); if (previous) return previous;
    if (input.todoIds.some(id => this.store.get(id).status !== 'open')) throw new TodoError('请先重新打开这条待办', 409);
    const target = input.sessionId ? await this.runtime.target?.(input.sessionId, req) : undefined;
    if (input.sessionId && (!target || !this.runtime.deliver)) throw new TodoError('目标会话不可用，请重新选择', 409);
    const config = target?.config ?? await this.runtime.validate(input.config!, req);
    // Target validation can await; recheck the durable request before reserving any side effect.
    const concurrent = this.store.previousHandoff(input); if (concurrent) return concurrent;
    const run = this.store.beginHandoff(input, config, target?.name ?? `待办 · ${this.store.get(input.todoIds[0]).title}`.slice(0, 120));
    const prompt = handoffPrompt(this.store, run);
    void (input.sessionId ? this.runtime.deliver!(run, prompt, req)
      : this.runtime.launch(run, prompt, sessionId => this.store.mark(run.id, { sessionId }), req))
      .then(() => this.store.mark(run.id, { status: 'delivered' }))
      .catch(error => this.store.mark(run.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }));
    return this.store.run(run.id);
  }
  async dispatchAutomatic(): Promise<void> {
    for (const todo of this.store.snapshot().todos) {
      const automatic = todo.autoProcessing;
      if (todo.status !== 'open' || automatic?.state !== 'pending') continue;
      if (todo.collectorId && !this.store.snapshot().collectors.some(c => c.id === todo.collectorId && c.enabled)) continue;
      const policy = automatic.policy;
      try {
        await this.handoff({ todoIds: [todo.id], note: policy.note, idempotencyKey: `automatic:${todo.id}`,
          ...(policy.mode === 'existing' ? { sessionId: policy.sessionId! } : { config: policy.config! }) });
      } catch (error) { this.store.automaticFailed(todo.id, error instanceof Error ? error.message : String(error)); }
    }
  }
  async tick(): Promise<void> {
    await this.sessions?.recycle();
    await this.dispatchAutomatic();
    for (const collector of this.store.due()) {
      try { await this.start('collect', collector.id, undefined, `schedule:${collector.id}:${collector.nextRunAt}`); }
      catch (error) {
        // Scheduled configuration failures also need a visible record and a new due time.
        try {
          const { run, fresh } = this.store.begin('collect', collector.id, collector.config, `schedule:${collector.id}:${collector.nextRunAt}`);
          if (fresh) this.store.mark(run.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
        } catch (recordError) { console.warn('[todo-collector]', collector.name, recordError instanceof Error ? recordError.message : recordError); }
      }
    }
  }
}
export function todoRoutes(store: TodoStore, runner: TodoRunner, runtime: TodoRuntime): Router {
  const router = Router();
  const route = (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (error) { res.status(error instanceof TodoError ? error.status : 400).json({ error: error instanceof Error ? error.message : String(error) }); }
  };
  router.get('/summary', route((_req, res) => res.json({ count: store.openCount() })));
  router.get('/', route((_req, res) => res.json(store.snapshot())));
  router.post('/', route((req, res) => { const todo = store.create(req.body ?? {}); res.json({ todo }); void runner.dispatchAutomatic(); }));
  router.post('/claim', route(async (req, res) => {
    const input = req.body ?? {};
    if (!['source', 'collectorId', 'todoId'].some(key => typeof input[key] === 'string' && input[key].trim())) throw new TodoError('请先向用户确认来源，再指定 --source、--collector 或 --todo');
    for (const key of ['source', 'collectorId', 'todoId', 'sessionId', 'backendSessionId']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 500 || input[key].includes('\0'))) throw new TodoError('领取参数无效');
    const target = await runtime.claimTarget?.(input); if (!target) throw new TodoError('请在 Termdock Agent 中领取，或用 --session 指定会话', 409);
    res.json(store.claim({ source: input.source, collectorId: input.collectorId, todoId: input.todoId, sessionId: target.sessionId, sessionName: target.name, config: target.config, leaseMinutes: input.leaseMinutes ?? 30, requestId: input.requestId }));
  }));
  router.post('/:id/release', route((req, res) => res.json({ todo: store.releaseClaim(req.params.id, req.body?.revision, req.body?.claimId) })));
  router.post('/:id/renew', route((req, res) => res.json({ todo: store.renewClaim(req.params.id, req.body?.claimId, req.body?.minutes ?? 30) })));
  router.post('/defaults', route(async (req, res) => res.json({ defaults: store.defaults(await runtime.validate(launchConfig(req.body ?? {}), req)) })));
  router.post('/handoff', route(async (req, res) => res.json({ run: await runner.handoff(req.body, req) })));
  router.post('/collectors', route(async (req, res) => {
    const input = req.body ?? {};
    const session = collectionSessionPolicy(input.session);
    if (session.targetSessionId) {
      const target = await runtime.target?.(session.targetSessionId, req);
      if (!target || target.mode !== 'tmux') throw new TodoError('请选择可用的 tmux Agent 会话', 409);
      if (input.config?.agentSlug !== target.config.agentSlug) throw new TodoError('请选择与复用会话一致的 Agent', 409);
    }
    const config = await runtime.validate(launchConfig(input.config ?? {}), req);
    const processing = processingPolicy(input.processing, config);
    if (input.processing !== undefined && processing.mode === 'new') processing.config = await runtime.validate(processing.config!, req);
    if (input.processing !== undefined && processing.mode === 'existing' && !await runtime.target?.(processing.sessionId!, req)) throw new TodoError('自动处理会话不可用', 409);
    res.json({ collector: store.saveCollector({ ...input, config, ...(input.processing !== undefined ? { processing } : {}), ...(input.session !== undefined ? { session } : {}) }) });
  }));
  router.post('/collectors/:id/remove', route((req, res) => { store.removeCollector(req.params.id, req.body?.revision); res.json({ ok: true }); }));
  router.post('/collectors/:id/run', route(async (req, res) => res.json({ run: await runner.start('collect', req.params.id, undefined, req.body?.idempotencyKey, req) })));
  router.post('/runs/:id/report', route((req, res) => res.json({ run: store.report(req.params.id, req.body?.status, req.body?.content) })));
  router.post('/:id', route((req, res) => res.json({ todo: store.update(req.params.id, req.body ?? {}) })));
  router.post('/:id/run', route(async (req, res) => res.json({ run: await runner.start('execute', req.params.id, req.body?.config, req.body?.idempotencyKey, req) })));
  return router;
}
