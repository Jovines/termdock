import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CollaborationTask, TaskWorkspace } from './collaborationTaskTypes.js';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await exec('git', ['-C', cwd, ...args], {
  timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' },
})).stdout.trim();
const home = path.join(os.homedir(), '.termdock', 'task-workspaces');

/** Only committed code enters task worktrees; the user's checkout is never reset, cleaned or merged. */
export async function prepareTaskWorkspace(task: CollaborationTask, sourceCwd: string, dependencies: CollaborationTask[], importCommit?: (dependency: CollaborationTask, repository: string) => Promise<void>): Promise<TaskWorkspace> {
  if (!/^[a-f0-9]{32}$/.test(task.id)) throw new Error('任务标识无效');
  const generation = task.events.filter(e => e.kind === 'scheduled').at(-1)?.id;
  if (!generation || !/^[a-f0-9]{32}$/.test(generation)) throw new Error('缺少执行目录准备记录');
  const repository = await git(sourceCwd, ['rev-parse', '--show-toplevel']);
  const rootId = task.workflow?.rootTaskId ?? task.id;
  const goalDir = path.join(home, rootId);
  await mkdir(goalDir, { recursive: true, mode: 0o700 });
  // Pin a base per repository and goal. A moved user HEAD cannot change later tasks' starting point.
  const { createHash } = await import('node:crypto');
  const common = await realpath(path.resolve(repository, await git(repository, ['rev-parse', '--git-common-dir'])));
  const baseFile = path.join(goalDir, `${createHash('sha256').update(common).digest('hex').slice(0, 16)}.base`);
  let base: string;
  try { base = (await readFile(baseFile, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    base = await git(repository, ['rev-parse', 'HEAD']);
    try { await writeFile(baseFile, base, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; base = (await readFile(baseFile, 'utf8')).trim(); }
  }
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('目标基线无效');
  const cwd = path.join(goalDir, `${task.id}-${generation.slice(0, 8)}`);
  const branch = `termdock/task/${task.id}-${generation.slice(0, 8)}`;
  try { await readFile(path.join(cwd, '.git'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await git(repository, ['worktree', 'add', '-b', branch, cwd, base]);
  }
  if (await git(cwd, ['rev-parse', '--show-toplevel']) !== cwd || await git(cwd, ['branch', '--show-current']) !== branch) throw new Error('独立目录与任务分支不匹配，保留现场等待处理');
  const readyFile = path.join(goalDir, `${task.id}-${generation.slice(0, 8)}.ready`);
  let ready = false;
  try { ready = (await readFile(readyFile, 'utf8')) === generation; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!ready) {
    // A failed merge is deliberately left in this task's worktree for a member to resolve.
    if (await git(cwd, ['status', '--porcelain'])) throw new Error(`依赖集成需要处理，现场保留在 ${cwd}；请协调者安排解决冲突后继续`);
    for (const dependency of dependencies) {
      const artifact = dependency.artifacts.find(a => a.id === dependency.acceptedArtifactId);
      const commit = (artifact?.evidence as { commit?: string } | undefined)?.commit;
      if (!commit || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error(`依赖「${dependency.title}」缺少已评审提交，请补充交付`);
      try { await git(cwd, ['cat-file', '-e', `${commit}^{commit}`]); }
      catch {
        if (!importCommit) throw new Error(`依赖「${dependency.title}」的提交在此仓库不可用，请协调者先同步提交`);
        await importCommit(dependency, cwd);
        await git(cwd, ['cat-file', '-e', `${commit}^{commit}`]);
      }
      await git(cwd, ['-c', 'user.name=Termdock', '-c', 'user.email=tasks@termdock.local', 'merge', '--no-edit', commit]);
    }
    const temp = `${readyFile}.${process.pid}.tmp`;
    await writeFile(temp, generation, { mode: 0o600 }); await rename(temp, readyFile);
  }
  return { cwd, repository, branch, base };
}

export async function captureTaskCommit(workspace: TaskWorkspace): Promise<{ commit: string; branch: string; cwd: string; base: string }> {
  if (!(await realpath(workspace.cwd)).startsWith(`${await realpath(home)}${path.sep}`) || await git(workspace.cwd, ['branch', '--show-current']) !== workspace.branch) throw new Error('交付目录与任务分支不匹配');
  if (await git(workspace.cwd, ['status', '--porcelain'])) throw new Error('独立目录还有未提交改动，请先提交再报告完成；不会自动暂存或提交');
  const commit = await git(workspace.cwd, ['rev-parse', 'HEAD']);
  return { commit, branch: workspace.branch, cwd: workspace.cwd, base: workspace.base };
}
