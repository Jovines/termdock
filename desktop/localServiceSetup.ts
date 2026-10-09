import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LocalServiceSetup, LocalServiceStatus } from './types.js';

const execute = promisify(execFile);
const installPrefix = path.join(os.homedir(), '.termdock', 'cli');

function versionBins(root: string, suffix = 'bin'): string[] {
  try {
    return fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(version => path.join(root, version, suffix));
  } catch { return []; }
}

async function environmentPaths(): Promise<string[]> {
  let loginPath = '';
  // Finder does not inherit the user's interactive shell PATH (notably nvm).
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const result = await execute(shell, ['-ilc', 'printf "\\nTERMDOCK_SETUP_PATH=%s\\n" "$PATH"'], {
      timeout: 5_000, maxBuffer: 256 * 1024,
    });
    loginPath = result.stdout.match(/^TERMDOCK_SETUP_PATH=(.*)$/m)?.[1] || '';
  } catch { /* Fall back to standard installation locations. */ }
  const home = os.homedir();
  return [...new Set([
    path.join(installPrefix, 'bin'),
    ...loginPath.split(path.delimiter), ...(process.env.PATH || '').split(path.delimiter),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    '/opt/homebrew/opt/node@22/bin', '/usr/local/opt/node@22/bin',
    '/opt/homebrew/opt/node@24/bin', '/usr/local/opt/node@24/bin',
    path.join(home, '.local', 'bin'), path.join(home, '.volta', 'bin'),
    ...versionBins(path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node')),
    ...versionBins(path.join(home, '.local', 'share', 'fnm', 'node-versions'), 'installation/bin'),
    ...versionBins(path.join(home, '.fnm', 'node-versions'), 'installation/bin'),
    ...versionBins(path.join(home, '.asdf', 'installs', 'nodejs')),
    ...versionBins(path.join(home, '.volta', 'tools', 'image', 'node')),
  ].filter(dir => dir && path.isAbsolute(dir)))];
}

function realFile(file: string): string | null {
  try { return fs.statSync(file).isFile() ? fs.realpathSync(file) : null; } catch { return null; }
}

function findCli(dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const entry = realFile(path.join(dir, 'termdock'));
    if (!entry || entry.includes('.app/Contents/')) continue;
    // Ignore unrelated commands and legacy app-bundle symlinks.
    try {
      const root = path.resolve(path.dirname(entry), '../..');
      const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (metadata.name === 'termdock' && typeof metadata.bin?.termdock === 'string'
        && realFile(path.resolve(root, metadata.bin.termdock)) === entry) return entry;
    } catch { /* Try the next installation. */ }
  }
  return undefined;
}

async function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (used: boolean) => { socket.destroy(); resolve(used); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(true));
  });
}

function errorDetails(error: unknown): string {
  const failure = error as { stderr?: string; stdout?: string; message?: string };
  return [failure.stderr, failure.stdout, failure.message].filter(Boolean).join('\n')
    .replace(/\u001b\[[0-9;]*m/g, '').slice(-8_000) || String(error);
}

/** Launches the standalone daemon; the desktop app never owns its lifetime. */
export class LocalServiceSetupController {
  status: LocalServiceSetup = { phase: 'checking', message: '正在检测本机服务和运行环境…' };
  private pending: Promise<void> | null = null;

  constructor(
    private readonly getService: () => Promise<LocalServiceStatus>,
    private readonly publish: (status: LocalServiceSetup) => void,
  ) {}

  private update(phase: LocalServiceSetup['phase'], message: string, extra: Partial<LocalServiceSetup> = {}): void {
    this.status = { ...this.status, phase, message, ...extra };
    this.publish(this.status);
  }

  prepare(install = false): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.run(install).catch(error => {
      this.update('error', '本机服务准备失败，请查看详情后重试。', { details: errorDetails(error) });
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async run(install: boolean): Promise<void> {
    this.update('checking', '正在检测本机服务和运行环境…', { details: undefined });
    let service = await this.getService();
    if (service.running) {
      this.update('ready', '本机服务已就绪，可以打开工作空间。');
      return;
    }
    if (service.probe || await portInUse(service.state?.port || 9834)) {
      this.update('error', '已有本机进程正在运行，但服务尚不可用。请稍后重试。', {
        details: service.probe?.error || '端口已被占用；请检查 ~/.termdock/server.log。',
      });
      return;
    }
    const dirs = await environmentPaths();
    let node: string | undefined;
    let nodeVersion: string | undefined;
    let oldVersion: string | undefined;
    const seen = new Set<string>();
    for (const dir of dirs) {
      const candidate = realFile(path.join(dir, 'node'));
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const { stdout } = await execute(candidate, ['--version'], { timeout: 3_000 });
        const version = stdout.trim();
        if (Number(version.match(/^v(\d+)\./)?.[1]) >= 22) {
          node = candidate; nodeVersion = version; break;
        }
        oldVersion ||= version;
      } catch { /* Broken or inaccessible runtime. */ }
    }
    this.status = { ...this.status, nodeVersion, cliPath: findCli(dirs) };
    if (!node) {
      this.update('needs-node', oldVersion
        ? `检测到 Node.js ${oldVersion}，请安装 Node.js 22 或更新版本。`
        : '需要先安装 Node.js 22 或更新版本，安装后会继续检测并启动。');
      return;
    }
    const env = { ...process.env, PATH: [path.dirname(node), ...dirs].join(path.delimiter), NO_COLOR: '1' };
    let cli = this.status.cliPath;
    if (!cli) {
      const npm = [path.dirname(node), ...dirs].map(dir => realFile(path.join(dir, 'npm')))
        .find((file): file is string => Boolean(file?.endsWith('/npm-cli.js')));
      if (!npm) {
        this.update('needs-node', '未找到 npm，请从 Node.js 官网重新安装包含 npm 的版本。');
        return;
      }
      if (!install) {
        this.update('needs-install', `Node.js ${nodeVersion} 已就绪，点击下方安装本机服务。`);
        return;
      }
      this.update('installing', '正在下载并安装 Termdock，首次安装可能需要几分钟…');
      fs.mkdirSync(installPrefix, { recursive: true, mode: 0o700 });
      // A user-owned prefix avoids sudo and leaves other global packages alone.
      try {
        await execute(node, [npm, 'install', '--global', '--prefix', installPrefix, 'termdock', '--no-audit', '--no-fund'], {
          env, cwd: os.homedir(), timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024,
        });
      } catch (error) {
        this.update('error', '安装未完成，请检查网络或安装详情后重试。', { details: errorDetails(error) });
        return;
      }
      cli = findCli([path.join(installPrefix, 'bin')]);
      if (!cli) throw new Error('安装结束后未找到 Termdock CLI，请检查安装详情。');
      this.status = { ...this.status, cliPath: cli };
    }
    // Check again after detection/install: another client may have started it.
    service = await this.getService();
    if (!service.running) {
      if (service.probe || await portInUse(service.state?.port || 9834)) {
        this.update('error', '本机服务正在启动或端口已占用，请稍后重试。', { details: service.probe?.error });
        return;
      }
      this.update('starting', '正在启动本机服务，完成后即可打开工作空间…');
      let launchError: unknown;
      try {
        await execute(node, [cli], { env, cwd: os.homedir(), timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      } catch (error) { launchError = error; }
      const deadline = Date.now() + 15_000;
      do {
        service = await this.getService();
        if (service.running) break;
        await new Promise(resolve => setTimeout(resolve, 1_000));
      } while (Date.now() < deadline);
      if (!service.running) {
        this.update('error', '尚未确认服务启动成功，请查看启动详情后重试。', {
          details: launchError ? errorDetails(launchError)
            : service.probe?.error || '请检查 ~/.termdock/server.log；已有后台服务会继续自行恢复。',
        });
        return;
      }
    }
    this.update('ready', '本机服务已就绪，可以打开工作空间。');
  }
}
