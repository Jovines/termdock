import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const TERMDOCK_OUTER_TERM = 'xterm-256color';
export const TERMDOCK_TRUECOLOR_FEATURE_SLOT = 'terminal-features[100]';
export const TERMDOCK_TRUECOLOR_OVERRIDE_SLOT = 'terminal-overrides[100]';

export type TmuxCommandRunner = (args: string[]) => Promise<unknown>;

export function buildInteractiveColorEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, COLORTERM: 'truecolor' };
  delete env.NO_COLOR;
  if (source.TERMDOCK_FORCE_COLOR === '1') {
    env.FORCE_COLOR = '1';
  } else {
    delete env.FORCE_COLOR;
  }
  return env;
}

export function buildTmuxColorEnvironmentCommands(
  sessionName?: string,
  forceColor = false,
): string[][] {
  const commands: string[][] = [
    ['set-environment', '-g', 'COLORTERM', 'truecolor'],
    ['set-environment', '-g', '-u', 'NO_COLOR'],
    forceColor
      ? ['set-environment', '-g', 'FORCE_COLOR', '1']
      : ['set-environment', '-g', '-u', 'FORCE_COLOR'],
  ];
  if (sessionName) {
    commands.push(
      ['set-environment', '-t', sessionName, 'COLORTERM', 'truecolor'],
      ['set-environment', '-t', sessionName, '-u', 'NO_COLOR'],
      forceColor
        ? ['set-environment', '-t', sessionName, 'FORCE_COLOR', '1']
        : ['set-environment', '-t', sessionName, '-u', 'FORCE_COLOR'],
    );
  }
  return commands;
}

/**
 * Pick the richest tmux TERM that applications on this host can resolve.
 * Older/minimal Linux installations may ship tmux without the matching
 * tmux-256color terminfo entry, in which case screen-256color is safer.
 */
export async function resolveTmuxInnerTerm(): Promise<'tmux-256color' | 'screen-256color'> {
  try {
    await execFileAsync('infocmp', ['tmux-256color'], {
      timeout: 2000,
      maxBuffer: 64 * 1024,
    });
    return 'tmux-256color';
  } catch {
    return 'screen-256color';
  }
}

/**
 * Keep Termdock's known xterm.js capabilities independent of each host's
 * ~/.tmux.conf. A fixed array slot makes repeated preparation idempotent.
 * terminal-features is available in modern tmux; legacy releases use Tc.
 */
export async function ensureTmuxColorCapabilities(
  runTmux: TmuxCommandRunner,
  sessionName?: string,
  innerTerm: 'tmux-256color' | 'screen-256color' = 'tmux-256color',
): Promise<void> {
  try {
    await runTmux([
      'set-option', '-s', TERMDOCK_TRUECOLOR_FEATURE_SLOT,
      `${TERMDOCK_OUTER_TERM}:RGB`,
    ]);
  } catch {
    await runTmux([
      'set-option', '-s', TERMDOCK_TRUECOLOR_OVERRIDE_SLOT,
      `${TERMDOCK_OUTER_TERM}:Tc`,
    ]);
  }

  if (!sessionName) return;

  await runTmux(['set-option', '-t', sessionName, 'default-terminal', innerTerm]);
  await runTmux(['set-environment', '-t', sessionName, 'TERM', innerTerm]);
}
