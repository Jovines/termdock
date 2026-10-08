import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CollaborationTask } from './collaborationTaskTypes.js';
import type { CollaborationService } from './collaborationService.js';

const exec = promisify(execFile), chunkSize = 256 * 1024, maxBytes = 128 * 1024 * 1024;
const directory = path.join(os.homedir(), '.termdock', 'task-bundles');
const preparing = new Map<string, Promise<BundleMetadata>>();
interface BundleMetadata { bytes: number; digest: string; commit: string; base: string; ref: string }
const git = async (cwd: string, args: string[]) => (await exec('git', ['-C', cwd, ...args], { timeout: 60_000, maxBuffer: 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
async function digestFile(file: string): Promise<string> {
  const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex');
}
function acceptedCommit(task: CollaborationTask) {
  const artifact = task.artifacts.find(a => a.id === task.acceptedArtifactId && a.kind === 'result');
  const commit = (artifact?.evidence as { commit?: string } | undefined)?.commit;
  if (task.status !== 'accepted' || !artifact || !task.workspace || !commit || !/^[a-f0-9]{40,64}$/.test(commit)
    || !/^[a-f0-9]{40,64}$/.test(task.workspace.base) || !/^[a-f0-9]{32}$/.test(artifact.id)) throw new Error('依赖没有已评审的代码提交');
  return { artifact, commit, base: task.workspace.base, workspace: task.workspace };
}
async function prepareBundle(task: CollaborationTask): Promise<BundleMetadata> {
  const { artifact, commit, base, workspace } = acceptedCommit(task);
  const existing = preparing.get(artifact.id); if (existing) return existing;
  const operation = (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${artifact.id}.bundle`), metadataFile = `${file}.json`;
    try {
      const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as BundleMetadata;
      if (metadata.commit === commit && metadata.base === base && metadata.bytes === (await stat(file)).size) return metadata;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Export the reviewed commit, even if the task branch has since moved.
    const ref = `refs/termdock/exports/${artifact.id}`;
    await git(workspace.cwd, ['update-ref', ref, commit]);
    const temporary = `${file}.${process.pid}.tmp`;
    if (commit === base) throw new Error('依赖未产生代码提交，无需传输；请检查项目基线是否一致');
    try {
      await git(workspace.cwd, ['bundle', 'create', temporary, ref, `^${base}`]);
      const bytes = (await stat(temporary)).size;
      if (bytes > maxBytes) throw new Error('依赖提交包超过 128 MiB，请通过仓库远端同步后继续');
      const metadata = { bytes, digest: await digestFile(temporary), commit, base, ref };
      await rename(temporary, file);
      await writeFile(`${metadataFile}.${process.pid}.tmp`, JSON.stringify(metadata), { mode: 0o600 });
      await rename(`${metadataFile}.${process.pid}.tmp`, metadataFile);
      return metadata;
    } finally { await unlink(temporary).catch(() => {}); }
  })().finally(() => preparing.delete(artifact.id));
  preparing.set(artifact.id, operation); return operation;
}
/** Chunks travel on the existing Noise RPC. No HTTP upload or repository credentials are introduced. */
export async function taskBundleChunk(task: CollaborationTask, offset: unknown) {
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) % chunkSize !== 0) throw new Error('提交包偏移无效');
  const metadata = await prepareBundle(task);
  if (Number(offset) >= metadata.bytes) throw new Error('提交包偏移超出范围');
  const artifact = acceptedCommit(task).artifact;
  const file = await open(path.join(directory, `${artifact.id}.bundle`), 'r');
  try {
    const buffer = Buffer.alloc(Math.min(chunkSize, metadata.bytes - Number(offset)));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Number(offset));
    return { ...metadata, offset, data: buffer.subarray(0, bytesRead).toString('base64') };
  } finally { await file.close(); }
}
export async function importTaskDependency(current: CollaborationTask, dependency: CollaborationTask, repository: string, peers: CollaborationService,
  localRead: (taskId: string, dependencyId: string, offset: number) => Promise<Record<string, any>>): Promise<void> {
  const expected = acceptedCommit(dependency);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `${expected.artifact.id}.incoming.${current.id}.${process.pid}.tmp`);
  const file = await open(temporary, 'w', 0o600);
  let offset = 0, digest = '', total = Infinity, ref = '';
  try {
    do {
      const response = current.ownerServiceId === peers.descriptor().serviceId ? await localRead(current.id, dependency.id, offset)
        : await peers.requestTasks(current.ownerServiceId, { op: 'dependency-bundle', taskId: current.id, dependencyId: dependency.id, offset });
      const chunk = response.chunk as BundleMetadata & { offset: number; data: string };
      if (!chunk || chunk.offset !== offset || chunk.commit !== expected.commit || chunk.base !== expected.base
        || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > maxBytes || typeof chunk.digest !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.digest)
        || chunk.ref !== `refs/termdock/exports/${expected.artifact.id}` || typeof chunk.data !== 'string' || chunk.data.length > 350_000
        || digest && digest !== chunk.digest || offset && total !== chunk.bytes) throw new Error('依赖提交包校验信息无效');
      digest = chunk.digest; total = chunk.bytes; ref = chunk.ref;
      const bytes = Buffer.from(chunk.data, 'base64');
      if (!bytes.length || bytes.length > chunkSize || offset + bytes.length > total) throw new Error('依赖提交包分片无效');
      await file.write(bytes, 0, bytes.length, offset); offset += bytes.length;
    } while (offset < total);
    await file.close();
    if (await digestFile(temporary) !== digest) throw new Error('依赖提交包摘要不匹配，保留任务等待重试');
    await git(repository, ['bundle', 'verify', temporary]);
    await git(repository, ['fetch', '--no-tags', temporary, ref]);
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
