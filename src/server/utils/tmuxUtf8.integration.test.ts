import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { describe, expect, it } from 'vitest';
import { buildTmuxAttachArgs } from './tmuxClientCapabilities.js';

const execute = promisify(execFile);
const supported = process.platform === 'linux' || process.platform === 'darwin';
const expected = 'KNOWN中文←→';

// Exercise real tmux client output, rather than capture-pane (which bypasses
// the client's locale-dependent terminal encoding).
describe.skipIf(!supported)('tmux UTF-8 client output', () => {
  it.each(['C', 'utf8'])('preserves non-ASCII output with %s launcher locale', async (locale) => {
    const socket = `td-utf8-${process.pid}-${Date.now()}-${locale}`;
    const environment = { ...process.env, TERM: 'xterm-256color' };
    delete environment.TMUX; delete environment.TMUX_PANE;
    const utf8 = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
    const serverEnvironment = { ...environment, LC_ALL: utf8, LANG: utf8 };
    const tmux = (args: string[]) => execute('tmux', ['-L', socket, '-f', '/dev/null', ...args], { env: serverEnvironment, timeout: 5_000 });
    let client: ReturnType<typeof spawn> | undefined;
    let nativeClient: import('node-pty').IPty | undefined;
    try {
      await tmux(['new-session', '-d', '-s', 'glyph', "printf 'KNOWN\\344\\270\\255\\346\\226\\207\\342\\206\\220\\342\\206\\222\\n'; sleep 20"]);
      const args = ['-L', socket, ...buildTmuxAttachArgs('glyph', false)];
      // The socket is generated here; no user-controlled shell arguments.
      const clientLocale = locale === 'C' ? 'C' : utf8;
      const clientEnvironment = { ...environment, LC_ALL: clientLocale, LC_CTYPE: clientLocale, LANG: clientLocale };
      const output = await new Promise<string>((resolve, reject) => {
        let text = '', receivedBytes = 0, chunks = 0;
        const decoder = new StringDecoder('utf8');
        const diagnosis = () => JSON.stringify({ receivedBytes, chunks, exitCode: client?.exitCode, signal: client?.signalCode, tail: text.slice(-1024) });
        const timer = setTimeout(() => reject(new Error('UTF-8 marker absent: ' + diagnosis())), 5_000);
        const appendText = (value: string) => {
          text += value; chunks += 1;
          if (text.includes(expected)) { clearTimeout(timer); resolve(text); }
        };
        if (process.platform === 'darwin') {
          // BSD script requires its own stdin to be a terminal. Node's piped
          // stdio is a socket, so use the production native PTY dependency.
          import('node-pty').then(pty => {
            nativeClient = pty.spawn('tmux', args, { name: 'xterm-256color', cols: 80, rows: 24,
              env: Object.fromEntries(Object.entries(clientEnvironment).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
            nativeClient.onData(data => { receivedBytes += Buffer.byteLength(data); appendText(data); });
            nativeClient.onExit(event => { if (!text.includes(expected)) { clearTimeout(timer); reject(new Error('PTY client exited before marker: ' + JSON.stringify({ ...event, receivedBytes, chunks, tail: text.slice(-1024) }))); } });
          }).catch(error => { clearTimeout(timer); reject(error); });
        } else {
          client = spawn('script', ['-qefc', ['tmux', ...args].join(' '), '/dev/null'], { env: clientEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
          const append = (data: Buffer) => { receivedBytes += data.length; appendText(decoder.write(data)); };
          client.stdout!.on('data', append); client.stderr!.on('data', append);
          client.once('error', error => { clearTimeout(timer); reject(error); });
          client.once('exit', () => { if (!text.includes(expected)) { clearTimeout(timer); reject(new Error('PTY wrapper exited before marker: ' + diagnosis())); } });
        }
      });
      expect(output).toContain(expected);
      expect(output).not.toContain('KNOWN______');
    } finally {
      await tmux(['detach-client', '-s', 'glyph']).catch(() => undefined);
      client?.stdin?.end();
      try { nativeClient?.kill(); } catch { /* Already detached. */ }
      await tmux(['kill-server']).catch(() => undefined);
      if (client && client.exitCode === null) client.kill();
    }
  }, 12_000);
});
