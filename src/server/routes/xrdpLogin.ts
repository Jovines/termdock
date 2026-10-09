import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

type LoginResult = 'authenticated' | 'failed' | 'unavailable' | 'timeout';

/** XRDP can accept the RDP transport even after PAM rejects auto-login. Match
 * our unique client name to journald's trusted process metadata, never to a
 * neighbouring connection or to screen contents. No password enters the log. */
export class XrdpLoginJournal {
  private buffer = '';
  private pid: string | undefined;
  private finished = false;
  constructor(private clientName: string, private result: (result: LoginResult) => void) {}
  receive(text: string): void {
    if (this.finished) return;
    this.buffer += text;
    if (this.buffer.length > 256 * 1024) { this.finish('unavailable'); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      let record: { _SYSTEMD_UNIT?: string; _PID?: string; MESSAGE?: string };
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      if (record._SYSTEMD_UNIT !== 'xrdp.service' || !/^\d+$/.test(record._PID || '') || typeof record.MESSAGE !== 'string') continue;
      if (record.MESSAGE.trim() === `[INFO ] Connected client computer name: ${this.clientName}`) this.pid = record._PID;
      if (!this.pid || record._PID !== this.pid) continue;
      if (/\blogin failed for user\b/i.test(record.MESSAGE)) this.finish('failed');
      else if (/\blogin successful for user\b/i.test(record.MESSAGE)) this.finish('authenticated');
    }
  }
  get matched(): boolean { return Boolean(this.pid); }
  finish(result: LoginResult): void {
    if (this.finished) return;
    this.finished = true; this.result(result);
  }
  cancel(): void { this.finished = true; this.buffer = ''; }
}

const output = (command: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(command, args, { timeout: 1000, maxBuffer: 256 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Optional host integration, only for the running local systemd XRDP listener.
 * Other hosts/backends continue using their normal RDP authentication signals. */
export async function observeLocalXrdpLogin(address: string, port: number, result: (result: LoginResult) => void): Promise<{ clientName: string; close(): void } | null> {
  if (process.platform !== 'linux' || !(address === '::1' || address.startsWith('127.')
    || Object.values(networkInterfaces()).flat().some(entry => entry?.address === address))) return null;
  try {
    const configuration = await readFile('/etc/xrdp/xrdp.ini', 'utf8');
    const globals = configuration.split(/^\[Globals\]\s*$/m)[1]?.split(/^\[/m)[0];
    if (!globals || Number(globals.match(/^port\s*=\s*(\d+)\s*$/m)?.[1]) !== port) return null;
    const [active, recent] = await Promise.all([
      output('systemctl', ['show', 'xrdp.service', '--property=ActiveState', '--value']),
      output('journalctl', ['--unit=xrdp.service', '--lines=1', '--output=json', '--no-pager']),
    ]);
    if (active.trim() !== 'active' || !recent.trim().split('\n').some(line => {
      try { return JSON.parse(line)._SYSTEMD_UNIT === 'xrdp.service'; } catch { return false; }
    })) return null;
  } catch { return null; }
  // NetBIOS client names are limited to 15 characters.
  const clientName = `td-${randomBytes(6).toString('hex')}`;
  const child = spawn('journalctl', ['--unit=xrdp.service', '--output=json', '--follow', '--no-tail',
    `--since=@${Math.floor(Date.now() / 1000) - 1}`, '--no-pager'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const decoder = new StringDecoder('utf8');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observerClosed = false;
  const close = () => { observerClosed = true; clearTimeout(timer); journal.cancel(); child.kill(); };
  const journal = new XrdpLoginJournal(clientName, state => { close(); result(state); });
  child.stdout.on('data', bytes => journal.receive(decoder.write(bytes)));
  child.once('error', () => journal.finish('unavailable'));
  child.once('exit', () => journal.finish('unavailable'));
  timer = setTimeout(() => journal.finish(journal.matched ? 'timeout' : 'unavailable'), 15_000);
  try { await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
  catch { close(); return null; }
  if (observerClosed) return null;
  return { clientName, close };
}
