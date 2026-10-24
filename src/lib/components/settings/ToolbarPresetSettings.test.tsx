// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolbarPresetSettings } from './ToolbarPresetSettings';
import { MobileKeyboard } from '../terminal/MobileKeyboard';
import { createDefaultToolbarPresets, decodeToolbarSequence, sanitizeToolbarPresets, type ToolbarPresetDefinition } from '../terminal/mobileKeyboardPresets';

afterEach(cleanup);

function Fixture({ presetId = 'traex' }: { presetId?: string }) {
  const [presets, setPresets] = React.useState(createDefaultToolbarPresets);
  const [selectedPresetId, onSelectPreset] = React.useState(presetId);
  return <>
    <ToolbarPresetSettings {...{ presets, selectedPresetId, onSelectPreset }}
      onUpdatePreset={(id, updater) => setPresets(current => current.map(preset => preset.id === id ? updater(preset) : preset))}
      onAddPreset={vi.fn()} onRemovePreset={vi.fn()} onResetDefaults={vi.fn()} />
    <output data-testid="presets">{JSON.stringify(presets)}</output>
  </>;
}

function getPreset(id = 'traex') {
  const persisted = JSON.parse(screen.getByTestId('presets').textContent!) as ToolbarPresetDefinition[];
  return sanitizeToolbarPresets(persisted).find(preset => preset.id === id)!;
}

function addCombo() {
  fireEvent.click(screen.getByRole('button', { name: 'Add button' }));
  fireEvent.click(screen.getByText('Key combination', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('button', { name: 'Insert key combination' }));
}

describe('custom toolbar key combinations', () => {
  it.each(['mobile', 'desktop-actions'] as const)('saves a new Shift+Left button outside Codex and sends it from %s', presentation => {
    const view = render(<Fixture />);
    addCombo();
    const preset = getPreset();
    const action = preset.actions.at(-1)!;
    expect(action).toMatchObject({ label: 'Shift+←', sequence: '\\u001b[1;2D' });
    view.unmount();
    const onTextPress = vi.fn();
    render(<MobileKeyboard visible defaultShowExtended presentation={presentation} activeModifier={null} lockedModifier={null}
      disabled={false} presetLabel={preset.label} presetModeLabel={preset.label} presetMode={preset.id} presetOptions={[]}
      includeAlt={false} presetRowLayout={preset.rowLayout} extraActions={preset.actions}
      onKeyPress={vi.fn()} onTextPress={onTextPress} onPastePress={vi.fn()} onFilePress={vi.fn()} onModifierToggle={vi.fn()} onPresetSelect={vi.fn()} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Shift+←' }), { pointerType: 'touch' });
    expect(onTextPress).toHaveBeenCalledExactlyOnceWith('\\u001b[1;2D');
    expect(decodeToolbarSequence(onTextPress.mock.calls[0][0])).toBe('\x1b[1;2D');
  });

  it('appends multiple modifiers and function keys to existing text and double-tap sequences', () => {
    render(<Fixture />);
    addCombo();
    fireEvent.change(screen.getByRole('textbox', { name: 'Sequence' }), { target: { value: '/edit||' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Key' }), { target: { value: 'ArrowRight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert key combination' }));
    expect(getPreset().actions.at(-1)?.sequence).toBe('/edit||\\u001b[1;6C');
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Double-tap sequence' }), { target: { value: '/edit\\r' } });
    const picker = screen.getAllByText('Key combination', { selector: 'summary' })[1].closest('details')!;
    fireEvent.click(within(picker).getByText('Key combination'));
    fireEvent.change(within(picker).getByRole('combobox'), { target: { value: 'F12' } });
    fireEvent.click(within(picker).getByRole('button', { name: 'Alt' }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Insert key combination' }));
    expect(getPreset().actions.at(-1)?.doubleTapSequence).toBe('/edit\\r\\u001b[24;4~');
  });

  it('disables unsupported combinations without modifying the sequence', () => {
    render(<Fixture />);
    addCombo();
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Tab' } });
    const insert = screen.getByRole('button', { name: 'Insert key combination' }) as HTMLButtonElement;
    expect(insert.disabled).toBe(true);
    fireEvent.click(insert);
    expect(getPreset().actions.at(-1)?.sequence).toBe('\\u001b[1;2D');
    expect(screen.getByText(/The terminal cannot distinguish/).textContent).toContain('cannot distinguish');
  });

  it('displays existing raw controls as editable escapes and preserves the custom label', () => {
    render(<Fixture presetId="codex" />);
    fireEvent.click(screen.getByRole('button', { name: '⇧← \\u001b[1;2D' }));
    expect((screen.getByRole('textbox', { name: 'Sequence' }) as HTMLInputElement).value).toBe('\\u001b[1;2D');
    fireEvent.click(screen.getByText('Key combination', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert key combination' }));
    expect(getPreset('codex').actions[0]).toMatchObject({ label: '⇧←', sequence: '\\u001b[1;2D\\u001b[1;2D' });
  });
});
