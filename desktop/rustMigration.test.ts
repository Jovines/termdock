import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { downloadVerifiedMigration, validateMigrationAsset } from './rustMigration.js';
import { replaceInstalledBundle } from './rustMigrationInstaller.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true }); });
async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termdock-migration-test-')); roots.push(root); return root; }
const bytes = Buffer.from('signed notarized payload bytes');
const asset = { version: '1.4.358', url: 'https://github.com/Jovines/termdock/releases/download/v1.4.358/Termdock_1.4.358_aarch64.dmg', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
it('only selects the exact versioned official DMG and verifies streamed bytes before mounting', async () => {
    const root = await directory(), target = path.join(root, 'update.dmg');
    await downloadVerifiedMigration(asset, target, async () => new Response(bytes));
    expect(await fs.readFile(target)).toEqual(bytes);
    for (const url of ['http://github.com/Jovines/termdock/releases/download/v1.4.358/Termdock_1.4.358_aarch64.dmg', asset.url + '?other=1', asset.url.replace('github.com', 'other.test')])
        expect(() => validateMigrationAsset({ ...asset, url })).toThrow();
});
it('rejects truncation, extra bytes and same-length corruption while preserving existing files', async () => {
    const root = await directory();
    for (const [index, payload] of [bytes.subarray(1), Buffer.concat([bytes, Buffer.from('extra')]), Buffer.alloc(bytes.length)].entries()) {
        const target = path.join(root, `bad-${index}`);
        await expect(downloadVerifiedMigration(asset, target, async () => new Response(payload))).rejects.toThrow();
        await expect(fs.stat(target)).rejects.toThrow();
    }
    const existing = path.join(root, 'existing');
    await fs.writeFile(existing, 'preserve');
    await expect(downloadVerifiedMigration(asset, existing, async () => new Response(bytes))).rejects.toThrow();
    expect(await fs.readFile(existing, 'utf8')).toBe('preserve');
});
it('replaces a complete bundle and restores the original when the final rename fails', async () => {
    const root = await directory(), target = path.join(root, 'Termdock.app'), staged = path.join(root, 'new.app'), rollback = path.join(root, 'old.app');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'identity'), 'electron');
    await fs.mkdir(staged);
    await fs.writeFile(path.join(staged, 'identity'), 'rust');
    await replaceInstalledBundle(staged, target, rollback);
    expect(await fs.readFile(path.join(target, 'identity'), 'utf8')).toBe('rust');
    expect(await fs.readFile(path.join(rollback, 'identity'), 'utf8')).toBe('electron');
    await fs.rm(rollback, { recursive: true });
    const nested = path.join(target, 'nested.app');
    await fs.mkdir(nested);
    await expect(replaceInstalledBundle(nested, target, rollback)).rejects.toThrow();
    expect(await fs.readFile(path.join(target, 'identity'), 'utf8')).toBe('rust');
});
