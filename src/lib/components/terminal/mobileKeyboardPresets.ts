export type ToolbarPresetMode = 'auto' | string;

export interface MobileToolbarAction {
  id: string;
  label: string;
  sequence: string;
}

export interface ToolbarPresetDefinition {
  id: string;
  label: string;
  programs: string[];
  includeAlt: boolean;
  rowLayout: number[];
  actions: MobileToolbarAction[];
}

export interface ToolbarPresetOption {
  id: ToolbarPresetMode;
  label: string;
}

export function getToolbarActionLabel(action: MobileToolbarAction, index: number): string {
  return action.label.trim().length > 0 ? action.label : `Key ${index + 1}`;
}

const DEFAULT_PRESETS: ToolbarPresetDefinition[] = [
  {
    id: 'default',
    label: 'Base',
    programs: [],
    includeAlt: true,
    rowLayout: [3, 3, 3],
    actions: [],
  },
  {
    id: 'vim',
    label: 'Vim',
    programs: ['vim', 'nvim', 'vi'],
    includeAlt: false,
    rowLayout: [3, 3],
    actions: [
      { id: 'vim-colon', label: ':', sequence: ':' },
      { id: 'vim-slash', label: '/', sequence: '/' },
      { id: 'vim-qmark', label: '?', sequence: '?' },
      { id: 'vim-u', label: 'u', sequence: 'u' },
    ],
  },
  {
    id: 'navigation',
    label: 'Nav',
    programs: ['less', 'more', 'most', 'man'],
    includeAlt: false,
    rowLayout: [3, 3],
    actions: [
      { id: 'nav-q', label: 'q', sequence: 'q' },
      { id: 'nav-slash', label: '/', sequence: '/' },
      { id: 'nav-n', label: 'n', sequence: 'n' },
      { id: 'nav-big-n', label: 'N', sequence: 'N' },
    ],
  },
  {
    id: 'fzf',
    label: 'FZF',
    programs: ['fzf', 'sk', 'atuin'],
    includeAlt: false,
    rowLayout: [3, 3],
    actions: [
      { id: 'fzf-tab', label: 'Tab', sequence: '\\t' },
      { id: 'fzf-shift-tab', label: 'S-Tab', sequence: '\\u001b[Z' },
      { id: 'fzf-ctrl-j', label: 'C-j', sequence: '\\n' },
      { id: 'fzf-ctrl-k', label: 'C-k', sequence: '\\u000b' },
    ],
  },
  {
    id: 'opencode',
    label: 'Code',
    programs: ['opencode'],
    includeAlt: false,
    rowLayout: [3, 3],
    actions: [
      { id: 'opencode-undo', label: '/undo', sequence: '/undo' },
      { id: 'opencode-help', label: '/help', sequence: '/help' },
      { id: 'opencode-init', label: '/init', sequence: '/init' },
      { id: 'opencode-share', label: '/share', sequence: '/share' },
    ],
  },
];

export function createDefaultToolbarPresets(): ToolbarPresetDefinition[] {
  return DEFAULT_PRESETS.map((preset) => ({
    ...preset,
    programs: [...preset.programs],
    includeAlt: preset.includeAlt,
    rowLayout: [...preset.rowLayout],
    actions: preset.actions.map((action) => ({ ...action })),
  }));
}

export function sanitizeRowLayout(input: number[] | null | undefined): number[] {
  const sanitized = Array.isArray(input)
    ? input
      .map((value) => Math.min(6, Math.max(2, Math.floor(value))))
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

export function decodeToolbarSequence(input: string): string {
  return input
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

export function sanitizeToolbarPresets(input: ToolbarPresetDefinition[]): ToolbarPresetDefinition[] {
  const seen = new Set<string>();
  const sanitized = input
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
          ? preset.programs.map((program) => normalizeActiveProgram(program)).filter((program): program is string => !!program)
          : [],
        includeAlt: typeof (preset as Partial<ToolbarPresetDefinition>).includeAlt === 'boolean'
          ? Boolean((preset as Partial<ToolbarPresetDefinition>).includeAlt)
          : false,
        rowLayout: sanitizeRowLayout((preset as Partial<ToolbarPresetDefinition>).rowLayout),
        actions: Array.isArray(preset.actions)
          ? preset.actions
            .map((action, actionIndex) => ({
              id: typeof action.id === 'string' && action.id.trim().length > 0 ? action.id : `${id}-action-${actionIndex + 1}`,
              label: typeof action.label === 'string' ? action.label : `Key ${actionIndex + 1}`,
              sequence: typeof action.sequence === 'string' ? action.sequence : '',
            }))
          : [],
      };
    })
    .filter((preset) => preset.id !== 'auto');

  if (!sanitized.some((preset) => preset.id === 'default')) {
    sanitized.unshift(createDefaultToolbarPresets()[0]);
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
    if (preset.programs.includes(normalized)) {
      return preset.id;
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
