import React from 'react';
import { useI18n } from '../../i18n';
import { encodeToolbarKeyCombo, getToolbarKeyComboLabel, TOOLBAR_CHARACTER_KEYS, TOOLBAR_NAMED_KEYS, type ToolbarKeyCombo } from '../../terminal/toolbarKeyCombo';

export function ToolbarKeyComboPicker({ onInsert }: { onInsert: (sequence: string, label: string) => void }) {
  const { t } = useI18n();
  const [combo, setCombo] = React.useState<ToolbarKeyCombo>({ key: 'ArrowLeft', shift: true, ctrl: false, alt: false });
  const sequence = encodeToolbarKeyCombo(combo);
  const label = getToolbarKeyComboLabel(combo);
  return (
    <details className="rounded-2xl bg-surface">
      <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium text-accent">{t('toolbarPresets.keyCombo')}</summary>
      <div className="space-y-2 px-3 pb-3">
        <div className="flex flex-wrap gap-2">
          {(['shift', 'ctrl', 'alt'] as const).map(modifier => (
            <button key={modifier} type="button" aria-pressed={combo[modifier]}
              onClick={() => setCombo(current => ({ ...current, [modifier]: !current[modifier] }))}
              className={`min-h-11 rounded-full px-4 text-xs font-medium ${combo[modifier] ? 'bg-primary/20 text-primary ring-1 ring-primary/30' : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated'}`}>
              {modifier === 'shift' ? 'Shift' : modifier === 'ctrl' ? 'Ctrl' : 'Alt'}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-3 text-xs text-muted-foreground">
          {t('toolbarPresets.comboKey')}
          <select value={combo.key} onChange={event => setCombo(current => ({ ...current, key: event.target.value }))}
            className="min-h-11 min-w-0 flex-1 rounded-xl bg-surface-2 px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-accent/40">
            <optgroup label={t('toolbarPresets.namedKeys')}>
              {TOOLBAR_NAMED_KEYS.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </optgroup>
            <optgroup label={t('toolbarPresets.functionKeys')}>
              {Array.from({ length: 12 }, (_, i) => `F${i + 1}`).map(key => <option key={key} value={key}>{key}</option>)}
            </optgroup>
            <optgroup label={t('toolbarPresets.characterKeys')}>
              {TOOLBAR_CHARACTER_KEYS.map(key => <option key={key} value={key}>{key.toUpperCase()}</option>)}
            </optgroup>
          </select>
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-foreground">{label}</span>
          <button type="button" disabled={sequence === null} onClick={() => { if (sequence !== null) onInsert(sequence, label); }}
            className="min-h-11 rounded-full bg-primary/15 px-4 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-40">
            {t('toolbarPresets.insertCombo')}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground" role={sequence === null ? 'status' : undefined}>
          {t(sequence === null ? 'toolbarPresets.unsupportedCombo' : 'toolbarPresets.keyComboHint')}
        </p>
      </div>
    </details>
  );
}
