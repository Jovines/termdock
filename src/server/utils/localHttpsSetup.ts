import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPrivateKey, X509Certificate, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';

const require = createRequire(import.meta.url);
const { findExecutable } = require('../../../scripts/install-utils.cjs') as { findExecutable(name: string): string | null };
export const MKCERT_VERSION = '1.4.4';
// Pinned official release assets: https://github.com/FiloSottile/mkcert/releases/tag/v1.4.4
export const MKCERT_SHA256: Record<string, string> = {
  'linux-amd64': '6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52',
  'linux-arm64': 'b98f2cc69fd9147fe4d405d859c57504571adec0d3611c3eefd04107c7ac00d0',
  'linux-arm': '2f22ff62dfc13357e147e027117724e7ce1ff810e30d2b061b05b668ecb4f1d7',
  'darwin-amd64': 'a32dfab51f1845d51e810db8e47dcf0e6b51ae3422426514bf5a2b8302e97d4e',
  'darwin-arm64': 'c8af0df44bce04359794dad8ea28d750437411d632748049d08644ffb66a60c6',
};
export type RunTool = (file: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
const runTool: RunTool = async (file, args, options) => {
  try { return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options },
      (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    // A nested sudo must receive EOF, never wait on an unused stdin pipe.
    child.stdin?.end();
  }); }
  catch (error) {
    const failure = error as Error & { stderr?: string; code?: string | number; signal?: string };
    throw new Error(`${path.basename(file)} ${args.join(' ')} failed (${failure.code ?? failure.signal ?? 'spawn error'}): ${failure.stderr?.trim() || failure.message}`, { cause: error });
  }
};

export async function downloadVerifiedExecutable(url: string, sha256: string, target: string, fetcher = fetch): Promise<void> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`mkcert download returned HTTP ${response.status}. Install mkcert manually and retry td --setup-local-https.`);
  if (Number(response.headers.get('content-length')) > 20 * 1024 * 1024) throw new Error('mkcert download is unexpectedly large');
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw new Error('Empty mkcert download');
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 20 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('mkcert download is unexpectedly large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('mkcert download SHA-256 mismatch; the executable was not installed');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, bytes, { mode: 0o700, flag: 'wx' }); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}

export async function ensureMkcert(options: {
  platform?: string; arch?: string; home?: string;
  find?: typeof findExecutable; run?: RunTool; download?: typeof downloadVerifiedExecutable;
  log?: (message: string) => void;
} = {}): Promise<string> {
  const find = options.find ?? findExecutable, run = options.run ?? runTool;
  const home = options.home ?? os.homedir();
  const target = path.join(home, '.termdock/bin/mkcert');
  // Check our own location explicitly, including when HOME/PATH is restricted.
  const existing = find('mkcert') || (fs.existsSync(target) ? target : null);
  if (existing) {
    try { await run(existing, ['--version'], { timeout: 5000 }); return existing; }
    catch (error) { throw new Error(`The installed mkcert is unusable: ${String(error)}. Repair or remove ${existing} and retry.`); }
  }
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const asset = `${platform}-${arch === 'x64' ? 'amd64' : arch}`;
  const checksum = MKCERT_SHA256[asset];
  if (!checksum) throw new Error(`Automatic mkcert installation is unavailable for ${platform}/${arch}. Install mkcert manually (Windows: use WSL).`);
  options.log?.(`Downloading verified mkcert ${MKCERT_VERSION} to ${target} (no administrator permission required)...`);
  const url = `https://github.com/FiloSottile/mkcert/releases/download/v${MKCERT_VERSION}/mkcert-v${MKCERT_VERSION}-${asset}`;
  try {
    await (options.download ?? downloadVerifiedExecutable)(url, checksum, target);
    await run(target, ['--version'], { timeout: 5000 });
  } catch (error) { throw new Error(`Could not prepare mkcert: ${String(error)}. Install mkcert manually and retry td --setup-local-https.`, { cause: error }); }
  return target;
}

export function localHttpsPaths(directory: string) {
  return { cert: path.join(directory, 'termdock-local.pem'), key: path.join(directory, 'termdock-local-key.pem'), ca: path.join(directory, 'rootCA.pem') };
}

export function inspectLocalCertificate(files: ReturnType<typeof localHttpsPaths>, names: string[], now = Date.now()) {
  const cert = new X509Certificate(fs.readFileSync(files.cert)), ca = new X509Certificate(fs.readFileSync(files.ca));
  if (!ca.ca || cert.ca || !cert.checkIssued(ca) || !cert.verify(ca.publicKey)
    || !cert.checkPrivateKey(createPrivateKey(fs.readFileSync(files.key)))) throw new Error('Certificate, private key and local CA do not match');
  if (cert.keyUsage && !cert.keyUsage.includes('1.3.6.1.5.5.7.3.1')) throw new Error('Local certificate does not allow TLS server authentication');
  for (const item of [cert, ca]) {
    if (Date.parse(item.validFrom) > now || Date.parse(item.validTo) <= now) throw new Error('Local HTTPS certificate or CA is not currently valid');
  }
  const missing = names.filter(name => isIP(name) ? cert.checkIP(name) === undefined : cert.checkHost(name, { subject: 'never', wildcards: false }) === undefined);
  if (missing.length) throw new Error(`Certificate is missing names: ${missing.join(', ')}`);
  return { cert, ca };
}

export function localCertificateNeedsRefresh(directory: string, names: string[], now = Date.now()): boolean {
  try {
    const { cert, ca } = inspectLocalCertificate(localHttpsPaths(directory), names, now);
    return Math.min(Date.parse(cert.validTo), Date.parse(ca.validTo)) < now + 30 * 86400_000;
  } catch { return true; }
}

function runInteractive(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', timeout: 120_000 });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`mkcert -install failed (${signal ?? code})`)));
  });
}

export async function setupLocalHttps(options: {
  directory: string; names: string[]; installCa?: boolean; allowCaChange?: boolean;
  mkcert?: string; run?: RunTool; interactive?: boolean; platform?: string;
  uid?: number; find?: typeof findExecutable; log?: (message: string) => void;
}): Promise<{ files: ReturnType<typeof localHttpsPaths>; warnings: string[]; trust: 'requested' | 'skipped' | 'failed'; caChanged: boolean }> {
  const run = options.run ?? runTool, find = options.find ?? findExecutable;
  const mkcert = options.mkcert ?? await ensureMkcert({ log: options.log });
  const names = [...new Set(options.names)];
  if (!names.length) throw new Error('At least one HTTPS certificate name is required');
  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const lock = path.join(options.directory, '.setup.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Invalid HTTPS setup lock; inspect ' + lock);
    try { process.kill(owner, 0); }
    catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ESRCH') {
        fs.rmSync(lock); return setupLocalHttps({ ...options, mkcert });
      }
    }
    throw new Error('Local HTTPS setup is already running; retry after it completes');
  }
  let stage: string | undefined;
  try {
    stage = fs.mkdtempSync(path.join(options.directory, '.setup-'));
    const candidate = localHttpsPaths(stage), files = localHttpsPaths(options.directory);
    await run(mkcert, ['-cert-file', candidate.cert, '-key-file', candidate.key, ...names], { cwd: stage });
    const caroot = (await run(mkcert, ['-CAROOT'], { timeout: 5000 })).stdout.trim();
    if (!path.isAbsolute(caroot)) throw new Error('mkcert returned an invalid CA directory');
    fs.copyFileSync(path.join(caroot, 'rootCA.pem'), candidate.ca);
    const verified = inspectLocalCertificate(candidate, names);
    let oldFingerprint: string | undefined;
    const hadCa = fs.existsSync(files.ca);
    if (hadCa) {
      try { oldFingerprint = new X509Certificate(fs.readFileSync(files.ca)).fingerprint256; }
      catch { /* An explicit setup may repair a damaged CA; automatic renewal may not replace it. */ }
    }
    const caChanged = hadCa && oldFingerprint !== verified.ca.fingerprint256;
    if (caChanged && options.allowCaChange === false) throw new Error('Automatic renewal would replace the trusted CA. Restore its mkcert CAROOT/private key, or explicitly run td --setup-local-https to replace it and trust it again.');
    const keys = ['cert', 'key', 'ca'] as const;
    const backups = new Map(keys.map(key => [key, fs.existsSync(files[key]) ? fs.readFileSync(files[key]) : undefined]));
    for (const key of keys) fs.chmodSync(candidate[key], 0o600);
    try {
      // No await between renames: filesystem watchers observe the complete set.
      for (const key of keys) fs.renameSync(candidate[key], files[key]);
    } catch (error) {
      for (const key of keys) {
        const backup = backups.get(key);
        if (backup) fs.writeFileSync(files[key], backup, { mode: 0o600 }); else fs.rmSync(files[key], { force: true });
      }
      throw error;
    }
    const warnings: string[] = [];
    if (caChanged) warnings.push('The local CA changed. Install and trust the new rootCA.pem on every device again.');
    let trust: 'requested' | 'skipped' | 'failed' = 'skipped';
    if (options.installCa !== false) {
      const platform = options.platform ?? process.platform;
      const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
      let canInstallSystem = interactive || (options.uid ?? process.getuid?.()) === 0;
      if (!canInstallSystem) {
        const sudo = find('sudo');
        if (sudo) { try { await run(sudo, ['-n', 'true'], { timeout: 5000 }); canInstallSystem = true; } catch { /* No password prompts in a pipe/daemon. */ } }
      }
      if (platform === 'linux' && !find('certutil')) warnings.push('Browser CA trust needs certutil: Debian/Ubuntu: apt install libnss3-tools; Fedora/RHEL: dnf install nss-tools; Arch: pacman -S nss; openSUSE: zypper install mozilla-nss-tools.');
      if (platform === 'linux' && !['update-ca-certificates', 'update-ca-trust', 'trust'].some(tool => find(tool))) warnings.push('No Linux system CA trust updater was found. Install the ca-certificates package or configure this server\'s trust store manually.');
      if (canInstallSystem) {
        try {
          if (interactive && !options.run) await runInteractive(mkcert, ['-install']);
          else {
            const result = await run(mkcert, ['-install']);
            if (result.stderr.trim()) warnings.push(result.stderr.trim());
          }
          trust = 'requested';
        } catch (error) { trust = 'failed'; warnings.push(`Certificate generation succeeded, but local CA trust installation failed: ${String(error)}`); }
      } else warnings.push('Local CA trust was skipped because this non-interactive process cannot elevate privileges.');
      const quotedMkcert = "'" + mkcert.replaceAll("'", "'\\''") + "'";
      if (trust !== 'requested') warnings.push(`To trust this CA on the server, run ${quotedMkcert} -install from an interactive terminal under the same user/CAROOT.`);
    }
    return { files, warnings, trust, caChanged };
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(lock, { force: true });
  }
}
