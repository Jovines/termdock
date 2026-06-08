export interface TmuxProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  stat: string;
  comm: string;
  args: string;
}

export interface TmuxProgramSelection {
  command: string | null;
  rawArgs: string | null;
}

export const DEFAULT_TMUX_HELPER_PROGRAM_NAMES = new Set([
  'caffeinate',
  'bytecloud-auth-rpc',
  'bytecloud-auth-rpc-darwin-arm64',
  'gitstatusd',
  'gitstatusd-darwin-arm64',
]);

export function normalizeProgramName(command: string | null | undefined): string | null {
  if (typeof command !== 'string') {
    return null;
  }

  const normalized = command.trim();
  if (!normalized) {
    return null;
  }

  const lastSegment = normalized.split(/[\\/]/).pop()?.trim();
  return lastSegment && lastSegment.length > 0 ? lastSegment : normalized;
}

export function extractProgramLabelFromArgs(
  args: string,
  options: {
    genericProgramNames: ReadonlySet<string>;
    wrapperScriptNames: ReadonlySet<string>;
  },
): string | null {
  if (!args) return null;

  const parts = args.split(/\s+/);
  const exe = parts[0];
  const exeName = normalizeProgramName(exe) || exe;

  if (options.genericProgramNames.has(exeName) && parts.length > 1) {
    const script = parts[1];
    const scriptName = normalizeProgramName(script) || script;
    const withoutExt = scriptName.replace(/\.(js|ts|mjs|cjs|py|sh|rb|pl|lua)$/, '');

    if (withoutExt && withoutExt.length > 0) {
      if (options.wrapperScriptNames.has(withoutExt)) {
        const remaining = parts.slice(2);
        const skipTokens = new Set(['x', 'run', 'exec', 'use']);
        let idx = 0;
        if (remaining.length > 0 && skipTokens.has(remaining[0])) {
          idx = 1;
        }
        for (let i = idx; i < remaining.length; i += 1) {
          const token = remaining[i];
          if (token.startsWith('-')) continue;
          return normalizeProgramName(token);
        }
        return withoutExt;
      }

      return withoutExt;
    }
  }

  return exeName;
}

function lowerProgramName(value: string | null | undefined): string | null {
  return normalizeProgramName(value)?.toLowerCase() ?? null;
}

function isKnownProgram(
  value: string | null | undefined,
  names: ReadonlySet<string>,
): boolean {
  const normalized = lowerProgramName(value);
  if (!normalized) return false;
  if (names.has(normalized)) return true;
  for (const name of names) {
    if (normalized.includes(name)) return true;
  }
  return false;
}

function ancestorDistance(
  row: TmuxProcessRow,
  panePid: number,
  rowsByPid: Map<number, TmuxProcessRow>,
): number | null {
  let current: TmuxProcessRow | undefined = row;
  const seen = new Set<number>();
  for (let depth = 0; depth < 25; depth += 1) {
    if (!current || seen.has(current.pid)) return null;
    seen.add(current.pid);
    if (current.ppid === panePid) return depth + 1;
    current = rowsByPid.get(current.ppid);
  }
  return null;
}

function isDirectProgramMatch(row: TmuxProcessRow, command: string | null): boolean {
  if (!command) return false;
  const normalized = command.toLowerCase();
  const comm = lowerProgramName(row.comm);
  const exe = lowerProgramName(row.args.split(/\s+/)[0]);
  return comm === normalized || exe === normalized;
}

export function selectTmuxForegroundProgram(input: {
  panePid: number;
  rows: TmuxProcessRow[];
  shellNames: ReadonlySet<string>;
  genericProgramNames: ReadonlySet<string>;
  helperProgramNames?: ReadonlySet<string>;
  extractProgramLabel: (args: string) => string | null;
}): TmuxProgramSelection | null {
  const helperProgramNames = input.helperProgramNames ?? DEFAULT_TMUX_HELPER_PROGRAM_NAMES;
  const rowsByPid = new Map(input.rows.map((row) => [row.pid, row]));
  const foregroundRows = input.rows.filter(
    (row) => row.pid !== input.panePid && row.tpgid > 0 && row.pgid === row.tpgid && !row.stat.startsWith('Z'),
  );

  if (foregroundRows.length === 0) {
    return null;
  }

  const decorated = foregroundRows.map((row) => {
    const command = normalizeProgramName(input.extractProgramLabel(row.args) ?? row.comm);
    const commandKey = command?.toLowerCase() ?? null;
    const distance = ancestorDistance(row, input.panePid, rowsByPid);
    const isHelper = isKnownProgram(command, helperProgramNames) || isKnownProgram(row.comm, helperProgramNames) || isKnownProgram(row.args.split(/\s+/)[0], helperProgramNames);
    const isShell = commandKey ? input.shellNames.has(commandKey) : false;
    const isGeneric = commandKey ? input.genericProgramNames.has(commandKey) : false;

    let score = 0;
    if (!isHelper) score += 1000;
    if (!isShell && !isGeneric) score += 200;
    if (isDirectProgramMatch(row, command)) score += 120;
    if (distance !== null) score += 50 + distance;
    if (isHelper) score -= 1000;
    if (isShell) score -= 200;
    if (isGeneric) score -= 80;

    return { row, command, isHelper, score };
  });

  const nonHelper = decorated.filter((candidate) => candidate.command && !candidate.isHelper);
  const pool = nonHelper.length > 0
    ? nonHelper
    : decorated.filter((candidate) => candidate.command);

  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.row.pid - b.row.pid;
  });

  const selected = pool[0];
  if (!selected?.command) {
    return null;
  }

  return {
    command: selected.command,
    rawArgs: selected.row.args,
  };
}

export function normalizeTmuxMetadataProgram(
  program: string | null | undefined,
  options: {
    shellNames: ReadonlySet<string>;
    helperProgramNames?: ReadonlySet<string>;
  },
): string | null {
  const normalized = normalizeProgramName(program);
  if (!normalized) return null;
  const key = normalized.toLowerCase();
  if (options.shellNames.has(key)) return null;
  if (isKnownProgram(normalized, options.helperProgramNames ?? DEFAULT_TMUX_HELPER_PROGRAM_NAMES)) return null;
  return normalized;
}

export function tmuxMetadataChanged(
  previous: { program: string | null; cwd: string | null; label: string } | null,
  next: { program: string | null; cwd: string | null; label: string },
): boolean {
  return !previous || previous.program !== next.program || previous.cwd !== next.cwd || previous.label !== next.label;
}
