import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A declarative, read-only native writer-ownership protocol. No Agent hook,
 * executable probe, transcript, environment, or cached binding is consulted. */
export interface NativeProcessIdentityConfig {
  kind: 'linux-flock-owner';
  directory: string;
}
export function nativeIdentityDirectory(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const c = config as Record<string, unknown>;
  if (c.kind !== 'linux-flock-owner' || Object.keys(c).some(k => !['kind', 'directory'].includes(k))
    || typeof c.directory !== 'string' || c.directory.length > 1024 || /[\x00-\x1f\x7f]/.test(c.directory)) return null;
  const expanded = c.directory.startsWith('~/') ? path.join(os.homedir(), c.directory.slice(2)) : c.directory;
  if (!path.isAbsolute(expanded)) return null;
  const directory = path.resolve(expanded), relative = path.relative(os.homedir(), directory);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? directory : null;
}
export interface NativeProcessIdentity {
  nativeId: string | null;
  outcome: 'verified' | 'unavailable' | 'unconfirmed' | 'ambiguous' | 'process_changed';
}
const unavailable: NativeProcessIdentity = { nativeId: null, outcome: 'unavailable' };
function processStat(text: string, pid: number) {
  const close = text.lastIndexOf(')'), open = text.indexOf('(');
  if (open < 0 || close <= open || Number(text.slice(0, open).trim()) !== pid) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const pgid = Number(fields[2]), tpgid = Number(fields[5]), start = fields[19];
  return fields[0] !== 'Z' && pgid > 0 && pgid === tpgid && /^\d+$/.test(start ?? '') ? { pgid, tpgid, start, comm: text.slice(open + 1, close) } : null;
}
function safeFile(stat: fs.BigIntStats, uid: number) {
  return stat.isFile() && stat.uid === BigInt(uid) && (stat.mode & 0o022n) === 0n;
}
function sameFile(a: fs.BigIntStats, b: fs.BigIntStats) { return a.dev === b.dev && a.ino === b.ino; }
function kernelWriter(locks: string, pid: number, stat: fs.BigIntStats) {
  // Linux dev_t encoding, matched against /proc/locks major:minor:inode.
  const major = (stat.dev >> 8n & 0xfffn) | (stat.dev >> 32n & 0xfffff000n);
  const minor = (stat.dev & 0xffn) | (stat.dev >> 12n & 0xffffff00n);
  return locks.split('\n').some(line => {
    const m = line.match(/^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF\s*$/i);
    return !!m && Number(m[1]) === pid && BigInt(`0x${m[2]}`) === major && BigInt(`0x${m[3]}`) === minor && BigInt(m[4]) === stat.ino;
  });
}
async function readOwner(file: string, uid: number) {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!safeFile(stat, uid) || stat.size > 4096n) return null;
    const buffer = Buffer.alloc(4097), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return null;
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } finally { await handle.close(); }
}

/** Confirm exactly one UUID using a current foreground PID, owner starttime,
 * its real open FD/inode, and the kernel's exclusive whole-file flock. */
export async function readNativeProcessIdentity(pid: number, config: NativeProcessIdentityConfig, expectedComm?: string, expectedArgs?: string): Promise<NativeProcessIdentity> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 1 || !process.getuid) return unavailable;
  const directory = nativeIdentityDirectory(config), uid = process.getuid();
  if (!directory) return unavailable;
  let hadNativeDescriptor = false;
  try {
    const root = await fs.promises.lstat(directory, { bigint: true });
    if (!root.isDirectory() || root.uid !== BigInt(uid) || (root.mode & 0o022n) !== 0n) return unavailable;
    const canonical = await fs.promises.realpath(directory), canonicalHome = await fs.promises.realpath(os.homedir());
    if (!canonical.startsWith(`${canonicalHome}${path.sep}`)) return unavailable;
    const proc = `/proc/${pid}`, initial = processStat(await fs.promises.readFile(`${proc}/stat`, 'utf8'), pid);
    if (!initial || expectedComm && initial.comm !== expectedComm || (await fs.promises.stat(proc)).uid !== uid)
      return { nativeId: null, outcome: 'process_changed' };
    const argsMatch = async () => {
      if (expectedArgs === undefined) return true;
      const handle = await fs.promises.open(`${proc}/cmdline`, fs.constants.O_RDONLY);
      try {
        const buffer = Buffer.alloc(16385), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return bytesRead < buffer.length && buffer.subarray(0, bytesRead).toString('utf8').replace(/\0$/, '').split('\0').join(' ').trim() === expectedArgs.trim();
      } finally { await handle.close(); }
    };
    if (!await argsMatch()) return { nativeId: null, outcome: 'process_changed' };
    const lockDescriptors = async () => {
      const descriptors = await fs.promises.readdir(`${proc}/fd`);
      if (descriptors.length > 4096) throw new Error('descriptor bound');
      const files: { fd: string; target: string }[] = [];
      for (const descriptor of descriptors) {
        if (!/^\d+$/.test(descriptor)) continue;
        const fd = `${proc}/fd/${descriptor}`;
        let target: string;
        try { target = await fs.promises.readlink(fd); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if (path.dirname(target) === canonical && /\.lock(?: \(deleted\))?$/.test(target)) files.push({ fd, target });
      }
      return files.sort((a, b) => a.fd.localeCompare(b.fd));
    };
    const descriptors = await lockDescriptors();
    hadNativeDescriptor = descriptors.length > 0;
    const locks = await fs.promises.readFile('/proc/locks', 'utf8');
    const verified = new Map<string, { fd: string; stat: fs.BigIntStats; owner: string }>();
    let unproved = false;
    for (const { fd, target } of descriptors) {
      if (!target.endsWith('.lock')) { unproved = true; continue; }
      const nativeId = path.basename(target).slice(0, -5);
      if (!/^[A-Za-z0-9._-]{1,256}$/.test(nativeId) || nativeId === '.' || nativeId === '..') { unproved = true; continue; }
      try {
        const lock = await fs.promises.lstat(target, { bigint: true }), held = await fs.promises.stat(fd, { bigint: true });
        const ownerFile = path.join(canonical, `${nativeId}.owner.json`), owner = await readOwner(ownerFile, uid);
        if (!safeFile(lock, uid) || !sameFile(lock, held) || !kernelWriter(locks, pid, lock)
          || owner?.pid !== pid || owner.process_start_id !== `linux:${initial.start}`) { unproved = true; continue; }
        verified.set(nativeId, { fd, stat: lock, owner: ownerFile });
      } catch { unproved = true; }
    }
    if (verified.size > 1) return { nativeId: null, outcome: 'ambiguous' };
    if (unproved) return { nativeId: null, outcome: 'unconfirmed' };
    if (verified.size !== 1) return unavailable;
    const final = processStat(await fs.promises.readFile(`${proc}/stat`, 'utf8'), pid);
    const currentLocks = await fs.promises.readFile('/proc/locks', 'utf8');
    const [nativeId, evidence] = [...verified][0];
    const current = await fs.promises.lstat(path.join(canonical, `${nativeId}.lock`), { bigint: true });
    const held = await fs.promises.stat(evidence.fd, { bigint: true }), owner = await readOwner(evidence.owner, uid);
    if (!final || final.start !== initial.start || final.comm !== initial.comm || final.pgid !== initial.pgid || final.tpgid !== initial.tpgid
      || !await argsMatch()
      || JSON.stringify(await lockDescriptors()) !== JSON.stringify(descriptors)
      || !safeFile(current, uid) || !sameFile(current, evidence.stat) || !sameFile(current, held)
      || !kernelWriter(currentLocks, pid, current) || owner?.pid !== pid || owner.process_start_id !== `linux:${final.start}`)
      return { nativeId: null, outcome: 'process_changed' };
    return { nativeId, outcome: 'verified' };
  } catch { return hadNativeDescriptor ? { nativeId: null, outcome: 'unconfirmed' } : unavailable; }
}
