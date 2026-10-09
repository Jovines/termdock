// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { batchTmuxOptions, TmuxMetadataWriter } from './tmuxMetadataWriter.js';

const exec = promisify(execFile);
it.skipIf(process.platform === 'win32')('writes one real tmux metadata batch without touching another session', async () => {
  const socket = `termdock-metadata-${process.pid}-${Date.now()}`;
  const run = async (args: string[]) => (await exec('tmux', ['-L', socket, ...args], { timeout: 5000 })).stdout;
  try {
    await run(['new-session', '-d', '-s', 'sample']);
    await run(['new-session', '-d', '-s', 'other']);
    let writes = 0;
    const writer = new TmuxMetadataWriter(async (name, options) => {
      writes++; await run(batchTmuxOptions(name, options));
    });
    const metadata = { program: 'codex', cwd: '/work with spaces', label: 'task; agent · 中文' };
    await Promise.all(Array.from({ length: 25 }, () => writer.sync('sample', metadata)));
    expect(writes).toBe(1);
    expect((await run(['show-option', '-vqt', 'sample', '@termdock-label'])).trim()).toBe(metadata.label);
    expect((await run(['show-option', '-vqt', 'sample', '@termdock-cwd'])).trim()).toBe(metadata.cwd);
    expect((await run(['show-option', '-vqt', 'other', '@termdock-label'])).trim()).toBe('');
    for (const label of [';', 'ends;', 'backslash\\;']) {
      await writer.sync('sample', { ...metadata, label });
      expect((await run(['show-option', '-vqt', 'sample', '@termdock-label'])).trim()).toBe(label);
    }
  } finally { await run(['kill-server']).catch(() => {}); }
}, 10_000);
