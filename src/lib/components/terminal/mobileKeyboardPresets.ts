export type ToolbarPresetMode = 'auto' | string;

export interface MobileToolbarAction {
  id: string;
  label: string;
  sequence: string;
  doubleTapSequence?: string;
}

export interface ToolbarPresetDefinition {
  id: string;
  label: string;
  programs: string[];
  includeAlt: boolean;
  rowLayout: number[];
  actions: MobileToolbarAction[];
  showOnDesktop?: boolean;
}

export interface ToolbarPresetOption {
  id: ToolbarPresetMode;
  label: string;
}

export function getToolbarActionLabel(action: MobileToolbarAction, index: number): string {
  return action.label.trim().length > 0 ? action.label : `Key ${index + 1}`;
}

// Bump this whenever the built-in DEFAULT_PRESETS change in a way that should
// be force-pushed to existing clients (new preset added, removed, or default
// actions/programs changed). The App reads this on startup and, when the
// stored version differs, overwrites all built-in preset ids with the latest
// definitions while keeping any user-authored custom presets intact.
export const BUILTIN_TOOLBAR_PRESETS_VERSION = 10;

export function getBuiltinToolbarPresetIds(): string[] {
  return DEFAULT_PRESETS.map((preset) => preset.id);
}

const DEFAULT_PRESETS: ToolbarPresetDefinition[] = [
  {
    id: 'default',
    label: 'Base',
    programs: [],
    includeAlt: true,
    rowLayout: [3, 3, 3],
    actions: [],
    showOnDesktop: false,
  },
  {
    id: 'opencode',
    label: 'Code',
    programs: ['opencode'],
    includeAlt: false,
    rowLayout: [4],
    actions: [
      { id: 'opencode-undo', label: '/undo', sequence: '/undo', doubleTapSequence: '/undo||\r' },
      { id: 'opencode-new', label: '/new', sequence: '/new', doubleTapSequence: '/new||\r' },
      { id: 'opencode-models', label: '/models', sequence: '/models', doubleTapSequence: '/models||\r' },
      { id: 'opencode-compact', label: '/compact', sequence: '/compact', doubleTapSequence: '/compact||\r' },
    ],
    showOnDesktop: true,
  },
  {
    id: 'claude',
    label: 'Claude',
    programs: ['claude', 'claude-code'],
    includeAlt: false,
    rowLayout: [4],
    actions: [
      { id: 'claude-undo', label: '/undo', sequence: '/undo', doubleTapSequence: '/undo\r' },
      { id: 'claude-clear', label: '/clear', sequence: '/clear', doubleTapSequence: '/clear\r' },
      { id: 'claude-compact', label: '/compact', sequence: '/compact', doubleTapSequence: '/compact\r' },
    ],
    showOnDesktop: true,
  },
  {
    id: 'coco',
    label: 'Coco',
    programs: ['coco'],
    includeAlt: false,
    rowLayout: [3, 3],
    actions: [
      { id: 'coco-undo', label: '/undo', sequence: '/||undo ', doubleTapSequence: '/||undo ||\r' },
      { id: 'coco-clear', label: '/clear', sequence: '/||clear ', doubleTapSequence: '/||clear ||\r' },
      { id: 'coco-model', label: '/model', sequence: '/||model ', doubleTapSequence: '/||model ||\r' },
      { id: 'coco-resume', label: '/resume', sequence: '/||resume ', doubleTapSequence: '/||resume ||\r' },
    ],
    showOnDesktop: true,
  },
  {
    id: 'traex',
    label: 'TraeX',
    programs: ['traex', 'traecli'],
    includeAlt: false,
    rowLayout: [3, 3],
    actions: [
      { id: 'traex-undo', label: '/undo', sequence: '/||undo ', doubleTapSequence: '/||undo ||\r' },
      { id: 'traex-clear', label: '/clear', sequence: '/||clear ', doubleTapSequence: '/||clear ||\r' },
      { id: 'traex-compact', label: '/compact', sequence: '/||compact ', doubleTapSequence: '/||compact ||\r' },
      { id: 'traex-model', label: '/model', sequence: '/||model ', doubleTapSequence: '/||model ||\r' },
      { id: 'traex-resume', label: '/resume', sequence: '/||resume ', doubleTapSequence: '/||resume ||\r' },
      { id: 'traex-status', label: '/status', sequence: '/||status ', doubleTapSequence: '/||status ||\r' },
    ],
    showOnDesktop: true,
  },
];

export function createDefaultToolbarPresets(): ToolbarPresetDefinition[] {
  return DEFAULT_PRESETS.map((preset) => ({
    ...preset,
    programs: [...preset.programs],
    includeAlt: preset.includeAlt,
    rowLayout: [...preset.rowLayout],
    actions: preset.actions.map((action) => {
      const copy: MobileToolbarAction = { ...action };
      return copy;
    }),
    showOnDesktop: preset.showOnDesktop,
  }));
}

export function sanitizeRowLayout(input: number[] | null | undefined): number[] {
  const sanitized = Array.isArray(input)
    ? input
      .map((value) => Math.min(20, Math.max(2, Math.floor(value))))
      .filter((value) => Number.isFinite(value))
    : [];

  return sanitized.length > 0 ? sanitized : [3, 3];
}

export function normalizeActiveProgram(program: string | null | undefined): string | null {
  if (typeof program !== 'string') {
    return null;
  }

  const normalized = program.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

// A program-match entry may be either a plain case-insensitive substring
// like `claude` or a JS-style regex literal like `/^claude(-code)?$/i`.
const PROGRAM_REGEX_PATTERN = /^\/(.+)\/([gimsuy]*)$/;

export function isRegexProgramPattern(input: string): boolean {
  return PROGRAM_REGEX_PATTERN.test(input.trim());
}

export function tryCompileProgramRegex(input: string): RegExp | null {
  const match = input.trim().match(PROGRAM_REGEX_PATTERN);
  if (!match) {
    return null;
  }
  try {
    return new RegExp(match[1] ?? '', match[2] ?? '');
  } catch {
    return null;
  }
}

export function normalizeProgramMatchEntry(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (PROGRAM_REGEX_PATTERN.test(trimmed)) {
    // Preserve the regex literal verbatim (case + flags matter), but drop
    // entries that fail to compile so we never throw at match time.
    return tryCompileProgramRegex(trimmed) ? trimmed : null;
  }
  // Plain program name: case-insensitive substring comparison via lowercase.
  return trimmed.toLowerCase();
}

export function decodeToolbarSequence(input: string): string {
  return input
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

// Multi-segment delimiter for toolbar sequences. Buttons whose `sequence`
// contains `||` are sent segment-by-segment with a small delay between
// segments. Useful for TUIs that open a slash-command menu after the first
// `/` keystroke (e.g. coco) and only then accept the command name.
export const TOOLBAR_SEGMENT_DELIMITER = '||';
export const TOOLBAR_SEGMENT_DELAY_MS = 120;

export function splitToolbarSequenceSegments(sequence: string): string[] {
  if (!sequence.includes(TOOLBAR_SEGMENT_DELIMITER)) {
    return [sequence];
  }
  return sequence.split(TOOLBAR_SEGMENT_DELIMITER).filter((segment) => segment.length > 0);
}

export function sanitizeToolbarPresets(input: Partial<ToolbarPresetDefinition>[]): ToolbarPresetDefinition[] {
  const seen = new Set<string>();
  const sanitized: ToolbarPresetDefinition[] = input
    .map((preset, presetIndex) => {
      const baseId = typeof preset.id === 'string' && preset.id.trim().length > 0
        ? preset.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
        : `preset-${presetIndex + 1}`;
      const id = seen.has(baseId) ? `${baseId}-${presetIndex + 1}` : baseId;
      seen.add(id);

      return {
        id,
        label: typeof preset.label === 'string' && preset.label.trim().length > 0 ? preset.label.trim() : 'Preset',
        programs: Array.isArray(preset.programs)
          ? preset.programs.map((program) => normalizeProgramMatchEntry(program)).filter((program): program is string => !!program)
          : [],
        includeAlt: typeof preset.includeAlt === 'boolean'
          ? Boolean(preset.includeAlt)
          : false,
        rowLayout: sanitizeRowLayout(preset.rowLayout),
        showOnDesktop: typeof preset.showOnDesktop === 'boolean'
          ? Boolean(preset.showOnDesktop)
          : false,
        actions: Array.isArray(preset.actions)
          ? preset.actions
            .map((action, actionIndex) => {
              const sanitized: MobileToolbarAction = {
                id: typeof action.id === 'string' && action.id.trim().length > 0 ? action.id : `${id}-action-${actionIndex + 1}`,
                label: typeof action.label === 'string' ? action.label : `Key ${actionIndex + 1}`,
                sequence: typeof action.sequence === 'string' ? action.sequence : '',
              };
              if (typeof (action as Partial<MobileToolbarAction>).doubleTapSequence === 'string') {
                sanitized.doubleTapSequence = (action as Partial<MobileToolbarAction>).doubleTapSequence;
              }
              return sanitized;
            })
          : [],
      };
    })
    .filter((preset) => preset.id !== 'auto');

  const defaultPreset = createDefaultToolbarPresets()[0];
  if (defaultPreset && !sanitized.some((preset) => preset.id === 'default')) {
    sanitized.unshift(defaultPreset);
  }

  return sanitized;
}

export function detectToolbarPreset(program: string | null | undefined, presets: ToolbarPresetDefinition[]): string {
  const normalized = normalizeActiveProgram(program);
  if (!normalized) {
    return 'default';
  }

  for (const preset of presets) {
    if (preset.id === 'default') {
      continue;
    }
    for (const entry of preset.programs) {
      const regex = tryCompileProgramRegex(entry);
      if (regex) {
        if (regex.test(normalized)) {
          return preset.id;
        }
      } else if (normalized.includes(entry)) {
        return preset.id;
      }
    }
  }

  return 'default';
}

export function getToolbarPreset(presets: ToolbarPresetDefinition[], presetId: string): ToolbarPresetDefinition {
  return presets.find((preset) => preset.id === presetId)
    ?? presets.find((preset) => preset.id === 'default')
    ?? createDefaultToolbarPresets()[0];
}

export function getToolbarPresetModeLabel(mode: ToolbarPresetMode, presets: ToolbarPresetDefinition[]): string {
  if (mode === 'auto') {
    return 'Auto';
  }

  return getToolbarPreset(presets, mode).label;
}

export function getNextToolbarPresetMode(current: ToolbarPresetMode, presets: ToolbarPresetDefinition[]): ToolbarPresetMode {
  const order: ToolbarPresetMode[] = ['auto', ...presets.map((preset) => preset.id)];
  const index = order.indexOf(current);
  if (index === -1 || index === order.length - 1) {
    return order[0] ?? 'auto';
  }

  return order[index + 1] ?? 'auto';
}

export function buildToolbarPresetOptions(presets: ToolbarPresetDefinition[]): ToolbarPresetOption[] {
  return [
    { id: 'auto', label: 'Auto' },
    ...presets.map((preset) => ({ id: preset.id, label: preset.label })),
  ];
}

export function buildDesktopToolbarPresetOptions(presets: ToolbarPresetDefinition[]): ToolbarPresetOption[] {
  return [
    { id: 'auto', label: 'Auto' },
    ...presets
      .filter((preset) => preset.showOnDesktop === true)
      .map((preset) => ({ id: preset.id, label: preset.label })),
  ];
}

export function splitButtonsIntoRows<T>(items: T[], rowLayout: number[]): Array<{ columns: number; items: T[] }> {
  const sanitizedLayout = sanitizeRowLayout(rowLayout);
  const rows: Array<{ columns: number; items: T[] }> = [];
  let cursor = 0;
  let rowIndex = 0;

  while (cursor < items.length) {
    const columns = sanitizedLayout[Math.min(rowIndex, sanitizedLayout.length - 1)] ?? 3;
    rows.push({
      columns,
      items: items.slice(cursor, cursor + columns),
    });
    cursor += columns;
    rowIndex += 1;
  }

  return rows;
}
