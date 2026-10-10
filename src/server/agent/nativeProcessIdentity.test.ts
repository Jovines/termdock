// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { nativeIdentityDirectory, readNativeProcessIdentity } from './nativeProcessIdentity.js';

const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
const script = `import os,sys,json,fcntl,time
root=sys.argv[1]
handles=[]
for native in sys.argv[2:]:
 f=open(os.path.join(root,native+'.lock'),'w')
 os.chmod(os.path.join(root,native+'.lock'),0o644)
 fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
 handles.append(f)
 start=open('/proc/'+str(os.getpid())+'/stat').read().rsplit(')',1)[1].split()[19]
 with open(os.path.join(root,native+'.owner.json'),'w') as out:
  json.dump({'pid':os.getpid(),'process_name':'fixture','process_start_id':'linux:'+start},out)
 os.chmod(os.path.join(root,native+'.owner.json'),0o644)
with open(os.path.join(root,'ready'),'w') as out: out.write(str(os.getpid()))
while True: time.sleep(1)
`;
async function fixture(ids = ['original-native']) {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.td-native-identity-test-'));
  const file = path.join(root, 'fixture.py'), socket = `td-identity-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(file, script); const exec = promisify(execFile);
  const tmux = async (args: string[]) => (await exec('tmux', ['-L', socket, ...args], { timeout: 5000 })).stdout;
  resources.push(async () => { await tmux(['kill-server']).catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  await tmux(['new-session', '-d', '-s', 'native', `exec python3 '${file}' '${root}' ${ids.join(' ')}`]);
  const ready = path.join(root, 'ready');
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const pid = Number(fs.readFileSync(ready, 'utf8'));
  const config = { kind: 'linux-flock-owner' as const, directory: root };
  return { root, pid, config, tmux };
}
it('validates only a declarative ownership directory confined to home', () => {
  expect(nativeIdentityDirectory({ kind: 'linux-flock-owner', directory: '~/.agent/locks' })).toBe(path.join(os.homedir(), '.agent/locks'));
  for (const directory of ['/tmp/locks', '~', '~/../escape', 'relative', `${os.homedir()}/bad\npath`])
    expect(nativeIdentityDirectory({ kind: 'linux-flock-owner', directory })).toBeNull();
  expect(nativeIdentityDirectory({ kind: 'linux-flock-owner', directory: '~/.agent', command: 'arbitrary' })).toBeNull();
});
it.skipIf(process.platform !== 'linux')('proves native identity with real kernel flock, live foreground PID, FD inode and process starttime', async () => {
  const f = await fixture();
  expect(await readNativeProcessIdentity(f.pid, f.config)).toEqual({ nativeId: 'original-native', outcome: 'verified' });
  expect(await readNativeProcessIdentity(f.pid, f.config, 'different-process')).toMatchObject({ nativeId: null });
  expect(await readNativeProcessIdentity(f.pid, f.config, undefined, 'different argv')).toMatchObject({ nativeId: null, outcome: 'process_changed' });
  // Owner metadata remains on disk after abrupt exit; it proves nothing alone.
  await f.tmux(['kill-server']);
  expect(fs.existsSync(path.join(f.root, 'original-native.owner.json'))).toBe(true);
  expect(await readNativeProcessIdentity(f.pid, f.config)).toMatchObject({ nativeId: null });
});
it.skipIf(process.platform !== 'linux')('rejects stale process_start_id and a different owner PID despite a real held lock', async () => {
  const f = await fixture(), owner = path.join(f.root, 'original-native.owner.json');
  const valid = JSON.parse(fs.readFileSync(owner, 'utf8'));
  fs.writeFileSync(owner, JSON.stringify({ ...valid, process_start_id: 'linux:1' }));
  expect(await readNativeProcessIdentity(f.pid, f.config)).toMatchObject({ nativeId: null });
  fs.writeFileSync(owner, JSON.stringify({ ...valid, pid: f.pid + 1 }));
  expect(await readNativeProcessIdentity(f.pid, f.config)).toMatchObject({ nativeId: null });
});
it.skipIf(process.platform !== 'linux')('rejects a replaced lock inode, symlink owner and writable ownership metadata', async () => {
  const f = await fixture(), lock = path.join(f.root, 'original-native.lock');
  const owner = path.join(f.root, 'original-native.owner.json'), backup = path.join(f.root, 'owner-backup.json');
  fs.renameSync(owner, backup); fs.symlinkSync(backup, owner);
  expect(await readNativeProcessIdentity(f.pid, f.config)).toMatchObject({ nativeId: null });
  fs.unlinkSync(owner); fs.renameSync(backup, owner); fs.chmodSync(owner, 0o666);
  expect(await readNativeProcessIdentity(f.pid, f.config)).toMatchObject({ nativeId: null });
  fs.chmodSync(owner, 0o644); fs.unlinkSync(lock); fs.writeFileSync(lock, '');
  expect(await readNativeProcessIdentity(f.pid, f.config)).toMatchObject({ nativeId: null });
});
it.skipIf(process.platform !== 'linux')('rejects multiple current native writer locks instead of picking one UUID', async () => {
  const f = await fixture(['first-native', 'second-native']);
  expect(await readNativeProcessIdentity(f.pid, f.config)).toEqual({ nativeId: null, outcome: 'ambiguous' });
});
it.skipIf(process.platform !== 'linux')('requires an actual kernel lock, not only an open FD and owner JSON', async () => {
  const f = await fixture();
  // A process opens a lock-shaped file and writes matching metadata but does
  // not flock it. Keep the first process as unrelated real locked evidence.
  const otherScript = path.join(f.root, 'unlocked.py');
  fs.writeFileSync(otherScript, script.replace('fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', 'pass'));
  fs.unlinkSync(path.join(f.root, 'ready'));
  await f.tmux(['new-session', '-d', '-s', 'unlocked', `exec python3 '${otherScript}' '${f.root}' fake-native`]);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(f.root, 'ready')); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const pid = Number(fs.readFileSync(path.join(f.root, 'ready'), 'utf8'));
  expect(await readNativeProcessIdentity(pid, f.config)).toMatchObject({ nativeId: null });
});
