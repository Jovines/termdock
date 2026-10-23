import { Router, type Request, type Response } from 'express';
import { launchConfig, TodoError, TodoStore } from './store.js';
import type { TodoLaunchConfig, TodoRun } from './types.js';

export interface TodoRuntime {
  validate(config: TodoLaunchConfig, req?: Request): Promise<TodoLaunchConfig>;
  launch(run: TodoRun, prompt: string, onSession: (id: string) => void, req?: Request): Promise<void>;
}
function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\"'\"'") + "'"; }
export function todoPrompt(store: TodoStore, run: TodoRun): string {
  const report = `完成或受阻时，请将结果写入一个 UTF-8 文件，并调用 td todo report ${run.id} --status complete --file <文件路径>；受阻时将 complete 换为 blocked，失败时换为 failed。报告只记录本次结果，由用户决定待办是否完成。`;
  if (run.kind === 'collect') return `${run.config.prompt}\n\n请将收集到的每条可执行待办通过本机 CLI 写入 Termdock，避免只输出列表。使用：\ntd todo add --title <标题> --description <描述> --source ${shellQuote(run.name)} --collector ${run.collectorId} --external-id <在此方向中稳定且唯一的标识>\n请附带必要上下文和可选的 --url https://... 。先用 td todo list 查看已有待办，避免重复。只收集待办，本轮不执行这些待办。\n${report}`;
  const todo = store.get(run.todoId!);
  return `${run.config.prompt || '请处理下面这条待办，完成后说明结果和验证情况。'}\n\n待办：${todo.title}\n${todo.description}\n来源：${todo.source}\n${todo.sourceUrl ? `来源链接：${todo.sourceUrl}\n` : ''}\n待办 ID：${todo.id}\n执行记录 ID：${run.id}\n${report}`;
}
export class TodoRunner {
  constructor(readonly store: TodoStore, private readonly runtime: TodoRuntime) {}
  async start(kind: TodoRun['kind'], id: string, input: Partial<TodoLaunchConfig> | undefined, key: string, req?: Request): Promise<TodoRun> {
    // Read-only validation happens before reserving a run; launch is always recorded before any side effect.
    const base = kind === 'collect' ? this.store.collector(id).config : this.store.snapshot().defaults;
    const config = await this.runtime.validate(launchConfig(input ?? {}, base), req);
    const { run, fresh } = this.store.begin(kind, id, config, key);
    if (fresh) void this.runtime.launch(run, todoPrompt(this.store, run), sessionId => this.store.mark(run.id, { sessionId }), req)
      .then(() => this.store.mark(run.id, { status: 'delivered' }))
      .catch(error => { this.store.mark(run.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }); });
    return run;
  }
  async tick(): Promise<void> {
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
  router.post('/', route((req, res) => res.json({ todo: store.create(req.body ?? {}) })));
  router.post('/defaults', route(async (req, res) => res.json({ defaults: store.defaults(await runtime.validate(launchConfig(req.body ?? {}), req)) })));
  router.post('/collectors', route(async (req, res) => {
    const input = req.body ?? {};
    const config = await runtime.validate(launchConfig(input.config ?? {}), req);
    res.json({ collector: store.saveCollector({ ...input, config }) });
  }));
  router.post('/collectors/:id/remove', route((req, res) => { store.removeCollector(req.params.id, req.body?.revision); res.json({ ok: true }); }));
  router.post('/collectors/:id/run', route(async (req, res) => res.json({ run: await runner.start('collect', req.params.id, undefined, req.body?.idempotencyKey, req) })));
  router.post('/runs/:id/report', route((req, res) => res.json({ run: store.report(req.params.id, req.body?.status, req.body?.content) })));
  router.post('/:id', route((req, res) => res.json({ todo: store.update(req.params.id, req.body ?? {}) })));
  router.post('/:id/run', route(async (req, res) => res.json({ run: await runner.start('execute', req.params.id, req.body?.config, req.body?.idempotencyKey, req) })));
  return router;
}
