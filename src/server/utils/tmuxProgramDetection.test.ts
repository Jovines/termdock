import { describe, expect, it } from 'vitest';
import {
  extractProgramLabelFromArgs,
  normalizeTmuxMetadataProgram,
  selectTmuxForegroundProgram,
  tmuxMetadataChanged,
  type TmuxProcessRow,
} from './tmuxProgramDetection.js';

const shellNames = new Set(['bash', 'zsh', 'fish', 'sh']);
const genericProgramNames = new Set(['node', 'python', 'python3']);
const wrapperScriptNames = new Set(['aiden', 'ttadk', 'npx']);

function extract(args: string): string | null {
  return extractProgramLabelFromArgs(args, { genericProgramNames, wrapperScriptNames });
}

describe('tmux program detection helpers', () => {
  it('prefers the real Claude process over node wrapper and caffeinate helper', () => {
    const rows: TmuxProcessRow[] = [
      { pid: 95690, ppid: 69188, pgid: 95690, tpgid: 36657, stat: 'Ss', comm: '-zsh', args: '-zsh' },
      { pid: 36657, ppid: 95690, pgid: 36657, tpgid: 36657, stat: 'S+', comm: 'node', args: 'node /tmp/bin/aiden x claude --dangerously-skip-permissions' },
      { pid: 39240, ppid: 36657, pgid: 36657, tpgid: 36657, stat: 'S+', comm: 'claude', args: 'claude --model haiku' },
      { pid: 24556, ppid: 39240, pgid: 36657, tpgid: 36657, stat: 'S+', comm: 'caffeinate', args: 'caffeinate -i -t 300' },
      { pid: 36824, ppid: 36657, pgid: 36657, tpgid: 36657, stat: 'S+', comm: 'bytecloud-auth-rpc', args: '/path/bytecloud-auth-rpc --bytecloud-auth-app-name aiden-cli' },
    ];

    const selected = selectTmuxForegroundProgram({
      panePid: 95690,
      rows,
      shellNames,
      genericProgramNames,
      extractProgramLabel: extract,
    });

    expect(selected).toEqual({ command: 'claude', rawArgs: 'claude --model haiku' });
  });

  it('falls back to a wrapper label when the real process is not listed', () => {
    const rows: TmuxProcessRow[] = [
      { pid: 95690, ppid: 69188, pgid: 95690, tpgid: 36657, stat: 'Ss', comm: '-zsh', args: '-zsh' },
      { pid: 36657, ppid: 95690, pgid: 36657, tpgid: 36657, stat: 'S+', comm: 'node', args: 'node /tmp/bin/aiden x claude --dangerously-skip-permissions' },
      { pid: 24556, ppid: 36657, pgid: 36657, tpgid: 36657, stat: 'S+', comm: 'caffeinate', args: 'caffeinate -i -t 300' },
    ];

    const selected = selectTmuxForegroundProgram({
      panePid: 95690,
      rows,
      shellNames,
      genericProgramNames,
      extractProgramLabel: extract,
    });

    expect(selected).toEqual({
      command: 'claude',
      rawArgs: 'node /tmp/bin/aiden x claude --dangerously-skip-permissions',
    });
  });

  it('normalizes shell and helper programs out of persisted metadata', () => {
    expect(normalizeTmuxMetadataProgram('zsh', { shellNames })).toBeNull();
    expect(normalizeTmuxMetadataProgram('caffeinate', { shellNames })).toBeNull();
    expect(normalizeTmuxMetadataProgram('claude', { shellNames })).toBe('claude');
  });

  it('treats program and cwd changes as metadata changes even when label is stable', () => {
    expect(tmuxMetadataChanged(
      { program: 'claude', cwd: '/repo/a', label: 'Friendly' },
      { program: null, cwd: '/repo/a', label: 'Friendly' },
    )).toBe(true);

    expect(tmuxMetadataChanged(
      { program: 'claude', cwd: '/repo/a', label: 'Friendly' },
      { program: 'claude', cwd: '/repo/b', label: 'Friendly' },
    )).toBe(true);

    expect(tmuxMetadataChanged(
      { program: 'claude', cwd: '/repo/a', label: 'Friendly' },
      { program: 'claude', cwd: '/repo/a', label: 'Friendly' },
    )).toBe(false);
  });
});
