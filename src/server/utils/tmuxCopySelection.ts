import { randomUUID } from 'node:crypto';
export const TMUX_COPY_MAX_BYTES = 256 * 1024;
export type TmuxCopySelectionResult = { status: 'copied' | 'empty'; paneId: string; text: string; bytes: number };
export type TmuxCopyRunner = (args: string[], options?: { maxBuffer: number }) => Promise<string>;
type Pane = { session: string; pane: string; inMode: boolean; selected: boolean };
const FORMAT = '#{session_id}\t#{pane_id}\t#{pane_in_mode}\t#{selection_present}';
function state(value: string): Pane {
  const parts = value.replace(/\r?\n$/, '').split('\t');
  if (parts.length !== 4 || !/^\$\d+$/.test(parts[0]) || !/^%\d+$/.test(parts[1]) || !/^[01]$/.test(parts[2]) || !/^[01]?$/.test(parts[3])) throw new Error('Tmux selection state was not confirmed');
  return { session: parts[0], pane: parts[1], inMode: parts[2] === '1', selected: parts[3] === '1' };
}
/** Read this session's current selection through a unique, self-owned buffer.
 * No global last-buffer read, shell copy command, clipboard write or mode exit. */
export async function copyTmuxSelection(target: string, run: TmuxCopyRunner): Promise<TmuxCopySelectionResult> {
  if (!target.trim() || /[\0\r\n]/.test(target)) throw new Error('Invalid tmux selection target');
  const exact = `=${target}:`;
  const read = () => run(['display-message', '-t', exact, '-p', FORMAT], { maxBuffer: 1024 }).then(state);
  const before = await read();
  const empty = (): TmuxCopySelectionResult => ({ status: 'empty', paneId: before.pane, text: '', bytes: 0 });
  if (!before.inMode || !before.selected) return empty();
  const prefix = `termdock-copy-${randomUUID()}-`;
  const own = new RegExp(`^${prefix}[0-9]+$`);
  const buffers: Array<{ name: string; bytes: number }> = [];
  let failed = false;
  let primaryError: unknown;
  const listArgs = ['list-buffers', '-f', `#{m:${prefix}*,#{buffer_name}}`, '-F', '#{buffer_name}\t#{buffer_size}'];
  try {
    await run(['send-keys', '-t', before.pane, '-X', 'copy-selection-no-clear', prefix], { maxBuffer: 1024 });
    const metadata = await run(listArgs, { maxBuffer: 64 * 1024 });
    for (const line of metadata.split('\n').filter(Boolean)) {
      const [name, count] = line.split('\t');
      if (!own.test(name)) throw new Error('Tmux returned an unowned selection buffer');
      buffers.push({ name, bytes: Number(count) });
      if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw new Error('Invalid owned tmux buffer metadata');
    }
    if (!buffers.length) return empty();
    if (buffers.length !== 1) throw new Error('Tmux produced ambiguous selection buffers');
    const buffer = buffers[0];
    if (buffer.bytes > TMUX_COPY_MAX_BYTES) throw new Error('Tmux selection exceeds the 256 KiB copy limit');
    const text = await run(['save-buffer', '-b', buffer.name, '-'], { maxBuffer: TMUX_COPY_MAX_BYTES + 1 });
    const after = await read();
    if (after.session !== before.session || after.pane !== before.pane || !after.inMode || !after.selected) throw new Error('Tmux selection target changed while copying');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes !== buffer.bytes || bytes > TMUX_COPY_MAX_BYTES) throw new Error('Tmux selection was not read completely');
    return bytes ? { status: 'copied', paneId: before.pane, text, bytes } : empty();
  } catch (error) {
    failed = true; primaryError = error; throw error;
  } finally {
    // A command may create its buffer before its reply fails. Enumerate only
    // this UUID prefix even after metadata failure and attempt every own delete.
    const names = new Set(buffers.map(buffer => buffer.name));
    const cleanupErrors: unknown[] = [];
    try {
      const remaining = await run(listArgs, { maxBuffer: 64 * 1024 });
      for (const line of remaining.split('\n').filter(Boolean)) {
        const name = line.split('\t')[0];
        if (!own.test(name)) { cleanupErrors.push(new Error('Tmux cleanup returned an unowned buffer')); continue; }
        names.add(name);
      }
    } catch (error) { cleanupErrors.push(error); }
    for (const name of names) {
      try { await run(['delete-buffer', '-b', name], { maxBuffer: 1024 }); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      const error = new AggregateError(cleanupErrors, 'Owned tmux copy buffer cleanup failed');
      if (!failed) throw error;
      if (primaryError instanceof Error) primaryError.cause = error;
    }
  }
}
