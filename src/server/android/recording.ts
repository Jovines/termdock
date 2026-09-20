import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { adbSearchPath, resolveAdbBinary } from './adb.js';
import { resolveScrcpyBinaries } from './scrcpy.js';

export interface AndroidRecording {
  id: string; serial: string; name: string; size: number; startedAt: number;
  status: 'starting' | 'recording' | 'stopping' | 'ready' | 'error';
  error?: string; savedPath?: string;
}
interface Job { info: AndroidRecording; child?: ChildProcess; done?: Promise<void>; timer?: ReturnType<typeof setTimeout>; writing?: Promise<void> }

/** Independent encoder and MP4 muxer; never coupled to browser video/ACK flow. */
export class AndroidRecordings {
  private jobs = new Map<string, Job>();
  private loading: Promise<void> | undefined;
  private starts = new Map<string, Promise<AndroidRecording>>();
  constructor(private readonly directory = join(homedir(), '.termdock', 'recordings')) {}
  private file(job: Job) { return join(this.directory, job.info.name); }
  private persist(job: Job): Promise<void> {
    job.writing = (job.writing ?? Promise.resolve()).catch(() => {}).then(async () => {
      const path = join(this.directory, `${job.info.id}.json`);
      await fs.writeFile(`${path}.tmp`, JSON.stringify(job.info), { mode: 0o600 });
      await fs.rename(`${path}.tmp`, path);
    });
    return job.writing;
  }
  private load(): Promise<void> {
    return this.loading ??= (async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const name of await fs.readdir(this.directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        try {
          const info = JSON.parse(await fs.readFile(join(this.directory, name), 'utf8')) as AndroidRecording;
          if (name !== `${info.id}.json` || info.name !== `termdock-recording-${info.id}.mp4`) continue;
          if (info.status !== 'ready' && info.status !== 'error') {
            info.status = 'error'; info.error = '录制因服务重启中断，文件可能不完整。';
          }
          this.jobs.set(info.id, { info });
        } catch { /* ignore unrelated/corrupt metadata */ }
      }
    })();
  }
  async list(serial: string): Promise<AndroidRecording[]> {
    await this.load();
    return [...this.jobs.values()].filter(job => job.info.serial === serial && !job.info.savedPath).map(job => ({ ...job.info }));
  }
  start(serial: string): Promise<AndroidRecording> {
    const pending = this.starts.get(serial);
    if (pending) return pending;
    const promise = this.startNew(serial).finally(() => this.starts.delete(serial));
    this.starts.set(serial, promise);
    return promise;
  }
  private async startNew(serial: string): Promise<AndroidRecording> {
    await this.load();
    const active = [...this.jobs.values()].find(job => job.info.serial === serial && job.child);
    if (active) return { ...active.info };
    const { bin, serverJar } = await resolveScrcpyBinaries();
    if ([...this.jobs.values()].filter(job => ['starting', 'recording', 'stopping'].includes(job.info.status)).length >= 3) throw new Error('同时最多录制三个设备');
    const id = randomUUID();
    const job: Job = { info: { id, serial, name: `termdock-recording-${id}.mp4`, size: 0, startedAt: Date.now(), status: 'starting' } };
    this.jobs.set(id, job);
    await this.persist(job);
    const child = spawn(bin, [
      '--serial', serial, '--no-playback', '--no-window', '--no-control', '--no-audio', '--no-power-on',
      '--max-size=1600', '--video-bit-rate=8000000', '--max-fps=30', '--video-codec=h264',
      '--time-limit=300', '--record-format=mp4', `--record=${this.file(job)}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: adbSearchPath(), ADB: resolveAdbBinary() ?? 'adb', SCRCPY_SERVER_PATH: serverJar } });
    job.child = child;
    let log = '';
    let spawnError = '';
    let forced = false;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const read = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-8000);
      if (job.info.status === 'starting' && /Recording started/i.test(log)) {
        job.info.status = 'recording';
        job.info.startedAt = Date.now();
        ready();
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', error => { spawnError = error.message; });
    job.done = new Promise<void>(resolve => {
      child.once('close', async code => {
        clearTimeout(job.timer);
        job.child = undefined;
        job.info.size = await fs.stat(this.file(job)).then(stat => stat.size).catch(() => 0);
        const complete = !forced && !spawnError && code === 0 && job.info.size > 0;
        job.info.status = complete ? 'ready' : 'error';
        if (!complete) job.info.error = spawnError || log.trim().slice(-1200) || '录制未完成';
        await this.persist(job).catch(() => {});
        ready(); resolve();
      });
    });
    const startupProbe = setInterval(() => {
      void fs.stat(this.file(job)).then(stat => {
        if (stat.size > 0 && job.info.status === 'starting') {
          job.info.status = 'recording'; job.info.startedAt = Date.now(); ready();
        }
      }).catch(() => {});
    }, 200);
    const startupTimeout = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 20000);
    job.timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 320000);
    await started;
    clearTimeout(startupTimeout);
    clearInterval(startupProbe);
    await this.persist(job);
    return { ...job.info };
  }
  private async get(id: string): Promise<Job> {
    await this.load();
    const job = this.jobs.get(id);
    if (!job) throw new Error('录像不存在');
    return job;
  }
  async stop(id: string): Promise<AndroidRecording> {
    const job = await this.get(id);
    if (job.child && job.info.status !== 'stopping') {
      job.info.status = 'stopping';
      job.child.kill('SIGINT');
      clearTimeout(job.timer);
      // Finish before the supervisor's five-second shutdown deadline.
      job.timer = setTimeout(() => job.child?.kill('SIGKILL'), 3000);
    }
    await job.done;
    return { ...job.info };
  }
  async save(id: string, directory?: string): Promise<string> {
    const job = await this.get(id);
    if (job.info.savedPath) {
      if (directory && join(directory, job.info.name) !== job.info.savedPath) throw new Error(`录像已保存到 ${job.info.savedPath}`);
      return job.info.savedPath;
    }
    if (job.info.status !== 'ready') throw new Error('录像尚未完成');
    const source = this.file(job);
    const destination = directory ? join(directory, job.info.name) : source;
    if (destination !== source) await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    job.info.savedPath = destination;
    await this.persist(job);
    if (destination !== source) await fs.rm(source, { force: true }).catch(() => {});
    return destination;
  }
  async discard(id: string): Promise<void> {
    await this.load();
    if (!this.jobs.has(id)) return;
    const job = await this.get(id);
    if (job.info.savedPath) {
      await fs.rm(join(this.directory, `${id}.json`), { force: true });
      this.jobs.delete(id);
      return;
    }
    await this.stop(id);
    await fs.rm(this.file(job), { force: true });
    await fs.rm(join(this.directory, `${id}.json`), { force: true });
    this.jobs.delete(id);
  }
  async stopAll(): Promise<void> { await Promise.all([...this.jobs.keys()].map(id => this.stop(id))); }
}
export const androidRecordings = new AndroidRecordings();
