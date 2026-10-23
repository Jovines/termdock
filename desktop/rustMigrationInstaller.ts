// Runs in the old, signed Electron executable in Node mode. It is copied out
// of the app before shutdown, so replacing the bundle cannot remove this code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const execute = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const guiEnvironment = { ...process.env };
delete guiEnvironment.ELECTRON_RUN_AS_NODE;
const openApp = (app: string) => execute('/usr/bin/open', ['-n', app], { env: guiEnvironment });
export async function replaceInstalledBundle(staged: string, target: string, rollback: string): Promise<void> {
    const exists = async (file: string) => !!await fs.lstat(file).catch(() => null);
    const stat = await fs.lstat(staged);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.lstat(target).catch(() => null))?.isSymbolicLink() || await exists(rollback))
        throw Error('Unsafe application replacement paths');
    const previous = await exists(target);
    if (previous)
        await fs.rename(target, rollback);
    try {
        await fs.rename(staged, target);
    }
    catch (error) {
        if (previous)
            await fs.rename(rollback, target);
        throw error;
    }
}
interface Plan {
    parentPid: number;
    root: string;
    staged: string;
    target: string;
    backup: string;
    receipt: string;
    ready: string;
    lock: string;
}
async function install(plan: Plan) {
    if (!Number.isSafeInteger(plan.parentPid) || plan.parentPid <= 1 || !path.isAbsolute(plan.root) || !path.basename(plan.root).startsWith('termdock-rust-update-') || path.basename(plan.target) !== 'Termdock.app' || plan.staged !== path.join(plan.root, 'Termdock.app') || plan.receipt !== path.join(plan.root, 'receipt.json') || plan.ready !== path.join(plan.root, 'ready.json'))
        throw Error('Invalid owned migration plan');
    // Copy onto the target volume before announcing readiness or asking the GUI
    // to quit. Permission/disk failures leave the running installation intact.
    const owner = await fs.open(plan.lock, 'wx', 0o600);
    await owner.writeFile(JSON.stringify({ pid: process.pid }));
    await owner.close();
    let sibling: string | undefined, rollback: string | undefined;
    let installed = false;
    try {
        sibling = await fs.mkdtemp(path.join(path.dirname(plan.target), '.termdock-rust-update-'));
        const staged = path.join(sibling, 'Termdock.app');
        rollback = path.join(sibling, 'previous.app');
        await execute('/usr/bin/ditto', [plan.staged, staged]);
        await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
        await fs.writeFile(plan.ready, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
        for (let i = 0;; i++) {
            let alive = true;
            try {
                process.kill(plan.parentPid, 0);
            }
            catch {
                alive = false;
            }
            if (!alive)
                break;
            if (i >= 120)
                throw Error('原客户端未退出；原应用保持不变');
            await delay(500);
        }
        if (await fs.stat(plan.target).catch(() => null)) {
            await fs.mkdir(path.dirname(plan.backup), { recursive: true });
            await execute('/usr/bin/ditto', [plan.target, plan.backup]);
        }
        await replaceInstalledBundle(staged, plan.target, rollback);
        installed = true;
        try {
            await openApp(plan.target);
        }
        catch (error) {
            await fs.rename(plan.target, path.join(sibling, 'failed.app'));
            if (await fs.stat(rollback).catch(() => null))
                await fs.rename(rollback, plan.target);
            installed = false;
            throw error;
        }
        await fs.writeFile(plan.receipt, JSON.stringify({ installed: true, target: plan.target, backup: plan.backup }), { mode: 0o600 });
        await fs.rm(plan.staged, { recursive: true, force: true }).catch(() => { });
        await fs.rm(path.join(plan.root, 'update.dmg'), { force: true }).catch(() => { });
    }
    catch (error) {
        await fs.writeFile(plan.receipt, JSON.stringify({ installed, error: String(error), backup: plan.backup, rollback }), { mode: 0o600 });
        // A failed handoff reopens the unchanged or restored GUI for recovery.
        if (!installed)
            await openApp(plan.target).catch(() => { });
        throw error;
    }
    finally {
        // Retain the old bundle if restoration itself failed; Trash backup and
        // receipt remain available independently of this temporary directory.
        if (sibling && (installed || !rollback || !(await fs.stat(rollback).catch(() => null))))
            await fs.rm(sibling, { recursive: true, force: true }).catch(() => { });
        await fs.rm(plan.lock, { force: true });
    }
}
if (process.argv[1] && await fs.realpath(process.argv[1]).then(file => import.meta.url === pathToFileURL(file).href).catch(() => false)) {
    const plan: Plan = JSON.parse(await fs.readFile(process.argv[2]!, 'utf8'));
    await install(plan);
}
