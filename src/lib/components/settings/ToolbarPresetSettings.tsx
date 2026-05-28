import React from 'react';
import {
  RiAddLine,
  RiRefreshLine,
  RiDeleteBinLine,
  RiArrowUpLine,
  RiArrowDownLine,
  RiCloseLine,
  RiSubtractLine,
} from '@remixicon/react';
import {
  getToolbarActionLabel,
  sanitizeRowLayout,
  splitButtonsIntoRows,
  type ToolbarPresetDefinition,
} from '../terminal/mobileKeyboardPresets';

interface ToolbarPresetSettingsProps {
  presets: ToolbarPresetDefinition[];
  selectedPresetId: string;
  onSelectPreset: (presetId: string) => void;
  onUpdatePreset: (presetId: string, updater: (preset: ToolbarPresetDefinition) => ToolbarPresetDefinition) => void;
  onAddPreset: () => void;
  onRemovePreset: (presetId: string) => void;
  onResetDefaults: () => void;
}

interface SequenceTemplate {
  label: string;
  sequence: string;
  hint?: string;
}

const SEQUENCE_TEMPLATES: SequenceTemplate[] = [
  { label: 'Esc', sequence: '\\u001b' },
  { label: 'Tab', sequence: '\\t' },
  { label: 'Enter', sequence: '\\r' },
  { label: 'S-Tab', sequence: '\\u001b[Z' },
  { label: 'C-c', sequence: '\\u0003' },
  { label: 'C-d', sequence: '\\u0004' },
  { label: 'C-l', sequence: '\\u000c' },
  { label: 'C-r', sequence: '\\u0012' },
  { label: 'C-z', sequence: '\\u001a' },
  { label: 'C-w', sequence: '\\u0017' },
  { label: 'Up', sequence: '\\u001b[A' },
  { label: 'Down', sequence: '\\u001b[B' },
  { label: 'Left', sequence: '\\u001b[D' },
  { label: 'Right', sequence: '\\u001b[C' },
  { label: 'PgUp', sequence: '\\u001b[5~' },
  { label: 'PgDn', sequence: '\\u001b[6~' },
];

const MIN_COLUMNS = 2;
const MAX_COLUMNS = 6;

function PreviewButton({ label }: { label: string }) {
  return (
    <div className="h-7 rounded-full bg-surface-2 px-3 text-[11px] leading-7 text-center text-muted-foreground truncate">
      {label}
    </div>
  );
}

function ChipInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = React.useState('');

  const addChip = (raw: string) => {
    const tokens = raw
      .split(/[,\s]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) return;
    const next = [...value];
    for (const token of tokens) {
      if (!next.includes(token)) next.push(token);
    }
    onChange(next);
    setDraft('');
  };

  const removeChip = (token: string) => {
    onChange(value.filter((t) => t !== token));
  };

  return (
    <div className="rounded-2xl bg-surface px-3 py-2 ring-1 ring-border/15 focus-within:ring-accent/40">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((token) => (
          <span
            key={token}
            className="inline-flex items-center gap-1 rounded-full bg-surface-elevated px-2.5 py-1 text-[11px] text-foreground"
          >
            {token}
            <button
              type="button"
              onClick={() => removeChip(token)}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
              aria-label={`Remove ${token}`}
            >
              <RiCloseLine size={12} />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addChip(draft);
            } else if (e.key === 'Backspace' && draft.length === 0 && value.length > 0) {
              removeChip(value[value.length - 1]);
            }
          }}
          onBlur={() => addChip(draft)}
          placeholder={value.length === 0 ? placeholder : ''}
          className="min-w-[8ch] flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted/60"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
        />
      </div>
    </div>
  );
}

function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-surface px-1 py-1 ring-1 ring-border/15">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="h-7 w-7 rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated disabled:opacity-40 inline-flex items-center justify-center"
        aria-label="Decrease"
      >
        <RiSubtractLine size={14} />
      </button>
      <span className="w-6 text-center text-sm font-medium tabular-nums text-foreground">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="h-7 w-7 rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated disabled:opacity-40 inline-flex items-center justify-center"
        aria-label="Increase"
      >
        <RiAddLine size={14} />
      </button>
    </div>
  );
}

export const ToolbarPresetSettings: React.FC<ToolbarPresetSettingsProps> = ({
  presets,
  selectedPresetId,
  onSelectPreset,
  onUpdatePreset,
  onAddPreset,
  onRemovePreset,
  onResetDefaults,
}) => {
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? presets[0] ?? null;
  const [editingActionId, setEditingActionId] = React.useState<string | null>(null);

  if (!selectedPreset) {
    return null;
  }

  const hasCustomActions = selectedPreset.actions.length > 0;
  const previewItems = [
    { id: 'preview-auto', label: 'Auto' },
    ...(selectedPreset.includeAlt ? [{ id: 'preview-alt', label: 'Alt' }] : []),
    ...(hasCustomActions
      ? selectedPreset.actions.map((action, index) => ({ id: action.id, label: getToolbarActionLabel(action, index) }))
      : ['Enter', 'Home', 'End', 'Ctrl-C', 'Ctrl-D'].map((label) => ({ id: label, label }))),
  ];
  const previewRows = splitButtonsIntoRows(previewItems, selectedPreset.rowLayout);

  const moveAction = (actionId: string, direction: -1 | 1) => {
    onUpdatePreset(selectedPreset.id, (preset) => {
      const sourceIndex = preset.actions.findIndex((action) => action.id === actionId);
      if (sourceIndex === -1) return preset;
      const targetIndex = sourceIndex + direction;
      if (targetIndex < 0 || targetIndex >= preset.actions.length) return preset;
      const nextActions = [...preset.actions];
      [nextActions[sourceIndex], nextActions[targetIndex]] = [nextActions[targetIndex], nextActions[sourceIndex]];
      return { ...preset, actions: nextActions };
    });
  };

  const totalCapacity = selectedPreset.rowLayout.reduce((sum, c) => sum + c, 0);
  const reservedSlots = 1 + (selectedPreset.includeAlt ? 1 : 0);

  return (
    <div className="space-y-4">
      {/* Sticky Preview at the top */}
      <div className="sticky top-0 z-10 -mx-4 -mt-4 sm:-mx-6 sm:-mt-6 border-b border-border/15 bg-surface/95 backdrop-blur px-4 py-3 sm:px-6">
        <div className="mb-2 flex items-center justify-between">
          <span className="ui-kicker">Preview</span>
          <span className="text-[10px] text-muted-foreground">
            {selectedPreset.actions.length} button{selectedPreset.actions.length === 1 ? '' : 's'} · {totalCapacity} slot{totalCapacity === 1 ? '' : 's'}
          </span>
        </div>
        <div className="space-y-1 rounded-2xl bg-surface-2/60 p-2">
          {previewRows.map((row, rowIndex) => (
            <div
              key={`preview-row-${rowIndex}`}
              className="grid gap-1"
              style={{ gridTemplateColumns: `repeat(${Math.max(2, row.columns)}, minmax(0, 1fr))` }}
            >
              {row.items.map((item) => (
                <PreviewButton key={item.id} label={item.label} />
              ))}
            </div>
          ))}
        </div>
        {selectedPreset.actions.length > totalCapacity - reservedSlots && (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            More buttons than slots. Extra rows will use the last row size.
          </p>
        )}
      </div>

      {/* Preset selector */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="ui-kicker">Presets</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onAddPreset}
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-3 py-2 text-xs font-medium hover:bg-surface-elevated transition"
            >
              <RiAddLine size={14} />
              New
            </button>
            <button
              type="button"
              onClick={onResetDefaults}
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-3 py-2 text-xs font-medium hover:bg-surface-elevated transition"
            >
              <RiRefreshLine size={14} />
              Reset
            </button>
          </div>
        </div>
        <div className="-mx-1 flex flex-wrap gap-1.5 px-1">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelectPreset(preset.id)}
              className={`rounded-full px-3 py-2 text-xs font-medium transition ${
                preset.id === selectedPreset.id
                  ? 'bg-primary/20 text-primary ring-1 ring-primary/30'
                  : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated'
              }`}
            >
              {preset.label}
              {preset.actions.length > 0 && (
                <span className="ml-1.5 text-[10px] text-muted-foreground">{preset.actions.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Preset config */}
      <div className="space-y-4 rounded-2xl bg-surface p-4 ring-1 ring-border/10">
        {/* Label */}
        <div className="space-y-1.5">
          <span className="ui-kicker">Label</span>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={selectedPreset.label}
              onChange={(event) =>
                onUpdatePreset(selectedPreset.id, (preset) => ({ ...preset, label: event.target.value }))
              }
              className="flex-1 rounded-full bg-surface-2 px-4 py-2.5 text-sm placeholder:text-muted/60 outline-none ring-1 ring-transparent focus:ring-accent/40"
              placeholder="Preset label"
              autoCapitalize="off"
              autoCorrect="off"
            />
            {selectedPreset.id !== 'default' && (
              <button
                type="button"
                onClick={() => onRemovePreset(selectedPreset.id)}
                className="shrink-0 rounded-full bg-surface-2 px-3 py-2.5 text-destructive hover:bg-destructive/15"
                aria-label={`Delete preset ${selectedPreset.label}`}
              >
                <RiDeleteBinLine size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Programs */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="ui-kicker">Match programs</span>
            <span className="text-[10px] text-muted-foreground">Type & Enter</span>
          </div>
          <ChipInput
            value={selectedPreset.programs}
            onChange={(next) =>
              onUpdatePreset(selectedPreset.id, (preset) => ({ ...preset, programs: next }))
            }
            placeholder="vim, nvim, opencode…"
          />
        </div>

        {/* Include Alt */}
        <button
          type="button"
          onClick={() =>
            onUpdatePreset(selectedPreset.id, (preset) => ({ ...preset, includeAlt: !preset.includeAlt }))
          }
          className="flex w-full items-center justify-between rounded-2xl bg-surface-2 px-4 py-3 text-sm transition hover:bg-surface-elevated"
        >
          <span>
            <span className="block font-medium text-foreground">Alt modifier slot</span>
            <span className="block text-[11px] text-muted-foreground">
              Reserve one preview slot for the Alt key.
            </span>
          </span>
          <span
            className={`inline-flex h-6 w-10 shrink-0 items-center rounded-full transition ${
              selectedPreset.includeAlt ? 'bg-primary/70' : 'bg-surface-elevated'
            }`}
          >
            <span
              className={`mx-0.5 inline-block h-5 w-5 rounded-full bg-foreground/90 transition ${
                selectedPreset.includeAlt ? 'translate-x-4' : ''
              }`}
            />
          </span>
        </button>

        {/* Rows */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <span className="ui-kicker">Row layout</span>
              <p className="text-[11px] text-muted-foreground">Buttons per expanded row.</p>
            </div>
            <button
              type="button"
              onClick={() =>
                onUpdatePreset(selectedPreset.id, (preset) => ({
                  ...preset,
                  rowLayout: [...sanitizeRowLayout(preset.rowLayout), 3],
                }))
              }
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-3 py-1.5 text-xs font-medium hover:bg-surface-elevated"
            >
              <RiAddLine size={12} />
              Row
            </button>
          </div>
          <div className="space-y-2">
            {selectedPreset.rowLayout.map((columns, rowIndex) => (
              <div key={`row-${rowIndex}`} className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2">
                <span className="w-12 shrink-0 text-xs text-muted-foreground">Row {rowIndex + 1}</span>
                <div className="flex-1" />
                <Stepper
                  value={columns}
                  min={MIN_COLUMNS}
                  max={MAX_COLUMNS}
                  onChange={(next) =>
                    onUpdatePreset(selectedPreset.id, (preset) => ({
                      ...preset,
                      rowLayout: preset.rowLayout.map((value, index) => (index === rowIndex ? next : value)),
                    }))
                  }
                />
                {selectedPreset.rowLayout.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      onUpdatePreset(selectedPreset.id, (preset) => ({
                        ...preset,
                        rowLayout: preset.rowLayout.filter((_, index) => index !== rowIndex),
                      }))
                    }
                    className="rounded-full bg-surface px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                    aria-label={`Remove row ${rowIndex + 1}`}
                  >
                    Del
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Buttons */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <span className="ui-kicker">Buttons</span>
              <p className="text-[11px] text-muted-foreground">Tap to edit. Use ↑↓ to reorder.</p>
            </div>
            <button
              type="button"
              onClick={() => {
                const newId = `${selectedPreset.id}-action-${Date.now()}`;
                onUpdatePreset(selectedPreset.id, (preset) => ({
                  ...preset,
                  actions: [
                    ...preset.actions,
                    {
                      id: newId,
                      label: `Key ${preset.actions.length + 1}`,
                      sequence: '',
                    },
                  ],
                }));
                setEditingActionId(newId);
              }}
              className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25"
            >
              <RiAddLine size={12} />
              Add button
            </button>
          </div>

          {selectedPreset.actions.length === 0 && (
            <div className="rounded-2xl bg-surface-2/60 px-4 py-6 text-center text-[11px] text-muted-foreground">
              No custom buttons yet. Add one to override the default toolbar.
            </div>
          )}

          {selectedPreset.actions.map((action, index) => {
            const isEditing = editingActionId === action.id;
            return (
              <div
                key={action.id}
                className={`rounded-2xl bg-surface-2 transition ${
                  isEditing ? 'ring-1 ring-accent/40' : ''
                }`}
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => moveAction(action.id, -1)}
                      disabled={index === 0}
                      className="h-6 w-6 rounded-full bg-surface text-muted-foreground hover:bg-surface-elevated disabled:opacity-30 inline-flex items-center justify-center"
                      aria-label="Move up"
                    >
                      <RiArrowUpLine size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveAction(action.id, 1)}
                      disabled={index === selectedPreset.actions.length - 1}
                      className="h-6 w-6 rounded-full bg-surface text-muted-foreground hover:bg-surface-elevated disabled:opacity-30 inline-flex items-center justify-center"
                      aria-label="Move down"
                    >
                      <RiArrowDownLine size={12} />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingActionId(isEditing ? null : action.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-sm font-medium text-foreground">
                      {getToolbarActionLabel(action, index)}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {action.sequence ? action.sequence : 'No sequence'}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdatePreset(selectedPreset.id, (preset) => ({
                        ...preset,
                        actions: preset.actions.filter((item) => item.id !== action.id),
                      }))
                    }
                    className="shrink-0 rounded-full bg-surface p-2 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                    aria-label={`Remove ${action.label}`}
                  >
                    <RiDeleteBinLine size={14} />
                  </button>
                </div>

                {isEditing && (
                  <div className="space-y-3 border-t border-border/10 px-3 py-3">
                    <div className="space-y-1.5">
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Label</span>
                      <input
                        type="text"
                        value={action.label}
                        onChange={(event) =>
                          onUpdatePreset(selectedPreset.id, (preset) => ({
                            ...preset,
                            actions: preset.actions.map((item) =>
                              item.id === action.id ? { ...item, label: event.target.value } : item,
                            ),
                          }))
                        }
                        className="w-full rounded-full bg-surface px-4 py-2.5 text-sm outline-none ring-1 ring-transparent focus:ring-accent/40"
                        placeholder="Label shown on the button"
                        autoCapitalize="off"
                        autoCorrect="off"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Sequence</span>
                      <input
                        type="text"
                        value={action.sequence}
                        onChange={(event) =>
                          onUpdatePreset(selectedPreset.id, (preset) => ({
                            ...preset,
                            actions: preset.actions.map((item) =>
                              item.id === action.id ? { ...item, sequence: event.target.value } : item,
                            ),
                          }))
                        }
                        className="w-full rounded-full bg-surface px-4 py-2.5 font-mono text-sm outline-none ring-1 ring-transparent focus:ring-accent/40"
                        placeholder="e.g. /undo or \t or /||undo"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {SEQUENCE_TEMPLATES.map((template) => (
                          <button
                            key={template.label}
                            type="button"
                            onClick={() =>
                              onUpdatePreset(selectedPreset.id, (preset) => ({
                                ...preset,
                                actions: preset.actions.map((item) =>
                                  item.id === action.id ? { ...item, sequence: template.sequence } : item,
                                ),
                              }))
                            }
                            className="rounded-full bg-surface px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
                          >
                            {template.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
