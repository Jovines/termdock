import React from 'react';
import { RiAddLine, RiRefreshLine, RiDeleteBinLine, RiDraggable } from '@remixicon/react';
import { getToolbarActionLabel, sanitizeRowLayout, splitButtonsIntoRows, type ToolbarPresetDefinition } from '../terminal/mobileKeyboardPresets';

interface ToolbarPresetSettingsProps {
  presets: ToolbarPresetDefinition[];
  selectedPresetId: string;
  onSelectPreset: (presetId: string) => void;
  onUpdatePreset: (presetId: string, updater: (preset: ToolbarPresetDefinition) => ToolbarPresetDefinition) => void;
  onAddPreset: () => void;
  onRemovePreset: (presetId: string) => void;
  onResetDefaults: () => void;
}

function PreviewButton({ label }: { label: string }) {
  return (
    <div className="h-7 rounded-full bg-surface-2 px-3 text-xs leading-7 text-center text-muted-foreground">
      {label}
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
  const [draggingActionId, setDraggingActionId] = React.useState<string | null>(null);
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? presets[0] ?? null;

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

  const moveAction = (sourceId: string, targetId: string) => {
    onUpdatePreset(selectedPreset.id, (preset) => {
      const sourceIndex = preset.actions.findIndex((action) => action.id === sourceId);
      const targetIndex = preset.actions.findIndex((action) => action.id === targetId);
      if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
        return preset;
      }

      const nextActions = [...preset.actions];
      const [moved] = nextActions.splice(sourceIndex, 1);
      nextActions.splice(targetIndex, 0, moved);
      return {
        ...preset,
        actions: nextActions,
      };
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground uppercase tracking-wider">Toolbar Presets</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onAddPreset}
            className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-3 py-1.5 text-xs hover:bg-surface-elevated transition-colors"
          >
            <RiAddLine size={12} />
            Add
          </button>
          <button
            type="button"
            onClick={onResetDefaults}
            className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-3 py-1.5 text-xs hover:bg-surface-elevated transition-colors"
          >
            <RiRefreshLine size={12} />
            Reset
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onSelectPreset(preset.id)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              preset.id === selectedPreset.id
                ? 'bg-primary/20 text-primary'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated'
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="space-y-3 rounded-2xl bg-surface p-4">
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Preset Label</span>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={selectedPreset.label}
              onChange={(event) => onUpdatePreset(selectedPreset.id, (preset) => ({ ...preset, label: event.target.value }))}
              className="w-full rounded-full bg-surface px-4 py-2.5 text-base sm:text-sm placeholder:text-muted/60"
              placeholder="Preset label"
            />
            {selectedPreset.id !== 'default' && (
              <button
                type="button"
                onClick={() => onRemovePreset(selectedPreset.id)}
                className="shrink-0 rounded-full bg-surface-2 px-3 py-2 text-destructive hover:bg-destructive/15"
                aria-label={`Remove ${selectedPreset.label}`}
              >
                <RiDeleteBinLine size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Programs</span>
          <input
            type="text"
            value={selectedPreset.programs.join(', ')}
            onChange={(event) => onUpdatePreset(selectedPreset.id, (preset) => ({
              ...preset,
              programs: event.target.value.split(',').map((item) => item.trim()).filter(Boolean),
            }))}
            className="w-full rounded-full bg-surface px-4 py-2.5 text-base sm:text-sm placeholder:text-muted/60"
            placeholder="vim, nvim, opencode"
          />
          <p className="text-[11px] text-muted-foreground">Use exact program names, comma separated.</p>
        </div>

        <div className="space-y-2">
          <label className="flex items-center justify-between rounded-2xl bg-surface-2 px-4 py-2.5 text-sm">
            <span>Include Alt</span>
            <input
              type="checkbox"
              checked={selectedPreset.includeAlt}
              onChange={(event) => onUpdatePreset(selectedPreset.id, (preset) => ({
                ...preset,
                includeAlt: event.target.checked,
              }))}
              className="h-4 w-4"
            />
          </label>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Rows</span>
            <button
              type="button"
              onClick={() => onUpdatePreset(selectedPreset.id, (preset) => ({
                ...preset,
                rowLayout: [...sanitizeRowLayout(preset.rowLayout), 3],
              }))}
              className="text-xs text-primary hover:underline"
            >
              Add row
            </button>
          </div>
          <div className="space-y-2">
            {selectedPreset.rowLayout.map((columns, rowIndex) => (
              <div key={`row-${rowIndex}`} className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-xs text-muted-foreground">Row {rowIndex + 1}</span>
                <input
                  type="range"
                  min="2"
                  max="6"
                  step="1"
                  value={columns}
                  onChange={(event) => onUpdatePreset(selectedPreset.id, (preset) => ({
                    ...preset,
                    rowLayout: preset.rowLayout.map((value, index) => index === rowIndex ? Number.parseInt(event.target.value, 10) : value),
                  }))}
                  className="flex-1"
                />
                <span className="w-8 text-right text-xs text-muted-foreground">{columns}</span>
                {selectedPreset.rowLayout.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onUpdatePreset(selectedPreset.id, (preset) => ({
                      ...preset,
                      rowLayout: preset.rowLayout.filter((_, index) => index !== rowIndex),
                    }))}
                    className="rounded-full bg-surface-2 px-2.5 py-1 text-xs hover:bg-surface-elevated"
                  >
                    Del
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">Set how many buttons each expanded row can hold. Extra buttons continue using the last row size.</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Buttons</span>
            <button
              type="button"
              onClick={() => onUpdatePreset(selectedPreset.id, (preset) => ({
                ...preset,
                actions: [
                  ...preset.actions,
                  {
                    id: `${preset.id}-action-${Date.now()}`,
                    label: `Key ${preset.actions.length + 1}`,
                    sequence: '',
                  },
                ],
              }))}
              className="text-xs text-primary hover:underline"
            >
              Add button
            </button>
          </div>

          {selectedPreset.actions.map((action) => (
            <div
              key={action.id}
              draggable
              onDragStart={() => setDraggingActionId(action.id)}
              onDragEnd={() => setDraggingActionId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggingActionId) {
                  moveAction(draggingActionId, action.id);
                }
                setDraggingActionId(null);
              }}
              className={`rounded-2xl bg-surface-2 p-3 transition-colors ${draggingActionId === action.id ? 'ring-2 ring-accent/40' : 'hover:bg-surface-elevated'}`}
            >
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <RiDraggable size={14} />
                <span>Drag to reorder</span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr,1.4fr,auto]">
              <input
                type="text"
                value={action.label}
                onChange={(event) => onUpdatePreset(selectedPreset.id, (preset) => ({
                  ...preset,
                  actions: preset.actions.map((item) => item.id === action.id ? { ...item, label: event.target.value } : item),
                }))}
                className="rounded-full bg-surface border border-border/15 px-4 py-2.5 text-base sm:text-sm placeholder:text-muted/60"
                placeholder="Label"
              />
              <input
                type="text"
                value={action.sequence}
                onChange={(event) => onUpdatePreset(selectedPreset.id, (preset) => ({
                  ...preset,
                  actions: preset.actions.map((item) => item.id === action.id ? { ...item, sequence: event.target.value } : item),
                }))}
                className="rounded-full bg-surface border border-border/15 px-4 py-2.5 text-base sm:text-sm placeholder:text-muted/60"
                placeholder="Sequence, eg /undo or \t"
              />
              <button
                type="button"
                onClick={() => onUpdatePreset(selectedPreset.id, (preset) => ({
                  ...preset,
                  actions: preset.actions.filter((item) => item.id !== action.id),
                }))}
                className="rounded-full bg-surface-2 p-2.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                aria-label={`Remove ${action.label}`}
              >
                <RiDeleteBinLine size={14} />
              </button>
              </div>
            </div>
          ))}

          {selectedPreset.actions.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No custom buttons yet. Add one to replace the expanded toolbar.</p>
          )}
        </div>

        <div className="space-y-2 rounded-2xl bg-surface-2/60 p-3">
          <span className="text-xs text-muted-foreground">Live Preview</span>
          <div className="space-y-1">
            {previewRows.map((row, rowIndex) => (
              <div
                key={`preview-row-${rowIndex}`}
                className="grid gap-1"
                style={{ gridTemplateColumns: `repeat(${Math.max(2, row.columns)}, minmax(0, 1fr))` }}
              >
                {row.items.map((item) => <PreviewButton key={item.id} label={item.label} />)}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">When a preset matches the current program, the expanded area will use these buttons.</p>
        </div>
      </div>
    </div>
  );
};
