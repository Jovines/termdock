import fs from 'node:fs/promises';
import { createWriteStream, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const execute = promisify(execFile);
export interface RustMigrationAsset {
    version: string;
    url: string;
    sha256: string;
    size: number;
}
export interface PreparedRustMigration {
    root: string;
    staged: string;
    target: string;
}
export function validateMigrationAsset(asset: RustMigrationAsset): void {
    if (!/^\d+\.\d+\.\d+$/.test(asset.version) || asset.url !== `https://github.com/Jovines/termdock/releases/download/v${asset.version}/Termdock_${asset.version}_aarch64.dmg` || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3)
        throw Error('Invalid Rust migration release asset');
}
export async function downloadVerifiedMigration(asset: RustMigrationAsset, destination: string, fetchImpl: typeof fetch = fetch): Promise<void> {
    validateMigrationAsset(asset);
    const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body)
        throw Error(`Rust 下载失败（HTTP ${response.status}）`);
    const hash = createHash('sha256');
    let size = 0;
    const check = new Transform({ transform(chunk: Buffer, _encoding, done) { size += chunk.length; if (size > asset.size) {
            done(Error('Rust 更新包大小不匹配'));
            return;
        } hash.update(chunk); done(null, chunk); } });
    let created = false;
    try {
        const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
        output.once('open', () => { created = true; });
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), check, output);
        if (size !== asset.size || hash.digest('hex') !== asset.sha256)
            throw Error('Rust 更新包摘要不匹配');
    }
    catch (error) {
        if (created)
            await fs.rm(destination, { force: true });
        throw error;
    }
}
async function identity(file: string): Promise<string> {
    const result = await execute('/usr/bin/codesign', ['-dv', '--verbose=4', file]);
    const team = result.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1];
    if (!team || team === 'not set' || !result.stderr.includes('Authority=Developer ID Application:'))
        throw Error('更新必须由 Developer ID 签名');
    return team;
}
export async function prepareRustMigration(asset: RustMigrationAsset, currentApp: string): Promise<PreparedRustMigration> {
    validateMigrationAsset(asset);
    if (process.platform !== 'darwin' || !path.isAbsolute(currentApp) || path.basename(currentApp) !== 'Termdock.app')
        throw Error('请从已安装的 Termdock.app 执行迁移');
    await fs.access(path.dirname(currentApp), fs.constants.W_OK).catch(() => { throw Error('应用目录不可写；请下载新版 DMG，由管理员安装 Termdock.app'); });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termdock-rust-update-'));
    await fs.chmod(root, 0o700);
    const dmg = path.join(root, 'update.dmg'), mount = path.join(root, 'mount');
    let mounted = false;
    try {
        await downloadVerifiedMigration(asset, dmg);
        const ownTeam = await identity(currentApp);
        if (await identity(dmg) !== ownTeam)
            throw Error('更新包的签名团队不匹配');
        await execute('/usr/bin/codesign', ['--verify', '--strict', dmg]);
        await execute('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
        await execute('/usr/sbin/spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', dmg]);
        await fs.mkdir(mount);
        await execute('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount, '-quiet']);
        mounted = true;
        const app = path.join(mount, 'Termdock.app');
        await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
        if (await identity(app) !== ownTeam)
            throw Error('正式应用的签名团队不匹配');
        for (const [key, value] of Object.entries({ CFBundleIdentifier: 'com.jovines.termdock', CFBundleShortVersionString: asset.version, CFBundleExecutable: 'Termdock' })) {
            const result = await execute('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents/Info.plist')]);
            if (result.stdout.trim() !== value)
                throw Error('正式应用身份或版本不匹配');
        }
        await execute('/usr/bin/xcrun', ['stapler', 'validate', app]);
        await execute('/usr/sbin/spctl', ['-a', '-t', 'exec', app]);
        const staged = path.join(root, 'Termdock.app');
        await execute('/usr/bin/ditto', [app, staged]);
        await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
        await fs.writeFile(path.join(root, 'install.mjs'), await fs.readFile(new URL('./rustMigrationInstaller.js', import.meta.url)), { mode: 0o600 });
        return { root, staged, target: currentApp };
    }
    catch (error) {
        await fs.rm(root, { recursive: true, force: true }).catch(() => { });
        throw error;
    }
    finally {
        if (mounted)
            await execute('/usr/bin/hdiutil', ['detach', mount, '-quiet']).catch(() => { });
    }
}
export async function launchRustMigration(prepared: PreparedRustMigration): Promise<void> {
    const ready = path.join(prepared.root, 'ready.json'), receipt = path.join(prepared.root, 'receipt.json');
    await fs.rm(ready, { force: true });
    await fs.rm(receipt, { force: true });
    const locks = path.join(os.homedir(), '.termdock', 'desktop-update-locks');
    await fs.mkdir(locks, { recursive: true, mode: 0o700 });
    const lock = path.join(locks, createHash('sha256').update(prepared.target).digest('hex') + '.lock');
    const previous = await fs.readFile(lock, 'utf8').then(JSON.parse).catch(() => null);
    if (Number.isSafeInteger(previous?.pid) && previous.pid > 1) {
        try {
            process.kill(previous.pid, 0);
            throw Error('已有 Rust 安装器正在运行，请稍后重试');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH')
                await fs.rm(lock, { force: true });
            else
                throw error;
        }
    }
    const plan = { ...prepared, parentPid: process.pid, ready, receipt, lock, backup: path.join(os.homedir(), '.Trash', `Termdock-before-Rust-${randomUUID()}.app`) };
    const file = path.join(prepared.root, 'plan.json');
    await fs.writeFile(file, JSON.stringify(plan), { mode: 0o600 });
    const log = openSync(path.join(prepared.root, 'install.log'), 'a', 0o600);
    const child = spawn(process.execPath, [path.join(prepared.root, 'install.mjs'), file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: ['ignore', log, log] });
    closeSync(log);
    let failure: Error | undefined;
    child.once('error', error => { failure = error; });
    child.unref();
    for (let i = 0; i < 100; i++) {
        if (failure)
            throw failure;
        const value = await fs.readFile(ready, 'utf8').then(JSON.parse).catch(() => null);
        if (value?.pid === child.pid)
            return;
        const failed = await fs.readFile(receipt, 'utf8').then(JSON.parse).catch(() => null);
        if (failed)
            throw Error(failed.error ?? 'Rust 安装准备失败');
        if (child.exitCode !== null)
            throw Error('Rust 安装器未能启动，请查看迁移日志');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Rust 安装器准备超时；原客户端保持不变');
}
