import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { AndroidRecordings } from './recording';
vi.mock('./scrcpy', () => ({ resolveScrcpyBinaries: vi.fn(async () => ({ bin: 'scrcpy', serverJar: '/server.jar' })) }));
vi.mock('./adb', () => ({ adbSearchPath: () => '/bin', resolveAdbBinary: () => 'adb' }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); vi.resetAllMocks(); });
async function setup(failure = false) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'td-recording-unit-'));
  const manager = new AndroidRecordings(dir);
  cleanup.push(async () => { await manager.stopAll(); await fs.rm(dir, { recursive: true, force: true }); });
  vi.mocked(spawn).mockImplementation(((_bin: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const path = args.find(arg => arg.startsWith('--record='))!.slice(9);
    child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
    queueMicrotask(() => {
      if (failure) { child.stderr.write('Encoder unavailable'); child.emit('close', 1); }
      else { writeFileSync(path, 'fake-mp4'); child.stdout.write('INFO: Recording started to mp4 file\n'); }
    });
    return child;
  }) as unknown as typeof spawn);
  return { manager, dir };
}
describe('server recording lifecycle', () => {
  it('uses an independent headless stream with fixed quality and coalesces start retries', async () => {
    const { manager } = await setup();
    const [a,b] = await Promise.all([manager.start('phone'), manager.start('phone')]);
    expect(a.id).toBe(b.id);
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--no-playback', '--no-control', '--no-audio', '--max-size=1600', '--video-bit-rate=8000000', '--max-fps=30', '--time-limit=300',
    ]));
    expect(a.status).toBe('recording');
    expect((await manager.stop(a.id)).status).toBe('ready');
  });
  it('recovers finished files after restart and saving is retryable without overwriting files', async () => {
    const { manager, dir } = await setup();
    const job = await manager.start('phone');
    await manager.stop(job.id);
    const restored = new AndroidRecordings(dir);
    expect((await restored.list('phone'))[0].status).toBe('ready');
    const path = await restored.save(job.id);
    expect(await restored.save(job.id)).toBe(path);
    expect(await restored.list('phone')).toEqual([]);
    expect(await fs.readFile(path, 'utf8')).toBe('fake-mp4');
    await restored.discard(job.id);
    expect(await fs.readFile(path, 'utf8')).toBe('fake-mp4');
  });
  it('keeps an encoder failure visible and never advertises an empty file as ready', async () => {
    const { manager } = await setup(true);
    const job = await manager.start('phone');
    expect(job.status).toBe('error');
    expect(job.error).toContain('Encoder unavailable');
    await expect(manager.save(job.id)).rejects.toThrow('尚未完成');
    await manager.discard(job.id);
    await manager.discard(job.id);
    expect(await manager.list('phone')).toEqual([]);
  });
  it('refuses to overwrite a destination and preserves the source for retry', async () => {
    const { manager, dir } = await setup();
    const job = await manager.start('phone');
    await manager.stop(job.id);
    const target = join(dir, 'saved');
    await fs.mkdir(target);
    await fs.writeFile(join(target, job.name), 'existing');
    await expect(manager.save(job.id, target)).rejects.toThrow();
    expect(await fs.readFile(join(target, job.name), 'utf8')).toBe('existing');
    expect((await manager.list('phone'))[0].status).toBe('ready');
  });
});
