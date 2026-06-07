// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileKeyboard } from './MobileKeyboard';

const baseProps = {
  visible: true,
  activeModifier: null,
  lockedModifier: null,
  disabled: false,
  defaultShowExtended: true,
  presetLabel: 'Claude',
  presetModeLabel: 'Auto preset · Claude',
  presetMode: 'auto',
  presetOptions: [
    { id: 'auto', label: 'Auto' },
    { id: 'claude', label: 'Claude' },
  ],
  includeAlt: true,
  presetRowLayout: [4],
  extraActions: [{ id: 'undo', label: '/undo', sequence: '/undo' }],
  onKeyPress: vi.fn(),
  onTextPress: vi.fn(),
  onModifierToggle: vi.fn(),
  onPresetSelect: vi.fn(),
};

describe('MobileKeyboard interaction state', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps the toolbar visible without firing actions when non-interactive', () => {
    const onKeyPress = vi.fn();
    const onTextPress = vi.fn();
    render(<MobileKeyboard {...baseProps} interactive={false} onKeyPress={onKeyPress} onTextPress={onTextPress} />);

    const toolbar = screen.getByText('Esc').closest('[data-mobile-keyboard="true"]');
    expect(toolbar?.className).toContain('opacity-100');
    expect(toolbar?.className).toContain('[&_button]:pointer-events-none');

    fireEvent.pointerDown(screen.getByText('Esc'));
    fireEvent.pointerDown(screen.getByText('/undo'));

    expect(onKeyPress).not.toHaveBeenCalled();
    expect(onTextPress).not.toHaveBeenCalled();
  });

  it('closes the preset menu when it becomes non-interactive', () => {
    const { rerender } = render(<MobileKeyboard {...baseProps} />);

    fireEvent.pointerDown(screen.getByTitle('Auto preset · Claude'));
    expect(screen.getByText('Claude')).toBeTruthy();

    rerender(<MobileKeyboard {...baseProps} interactive={false} />);

    expect(screen.queryByText('Claude')).toBeNull();
  });
});

describe('MobileKeyboard desktop actions presentation', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders preset actions without the basic keyboard row', () => {
    render(<MobileKeyboard {...baseProps} presentation="desktop-actions" />);

    expect(screen.getByText('/undo')).toBeTruthy();
    expect(screen.queryByText('Esc')).toBeNull();
    expect(screen.queryByText('Ctrl')).toBeNull();
    expect(screen.queryByText('C-C')).toBeNull();
    expect(screen.queryByText('/')).toBeNull();
  });

  it('does not render basic fallback keys when no custom action exists on desktop', () => {
    render(<MobileKeyboard {...baseProps} presentation="desktop-actions" extraActions={[]} />);

    expect(screen.queryByText('Home')).toBeNull();
    expect(screen.queryByText('End')).toBeNull();
    expect(screen.queryByText('Ctrl-D')).toBeNull();
  });

  it('keeps action clicks wired to the existing text callback', () => {
    const onTextPress = vi.fn();
    render(<MobileKeyboard {...baseProps} presentation="desktop-actions" onTextPress={onTextPress} />);

    fireEvent.pointerDown(screen.getByText('/undo'));

    expect(onTextPress).toHaveBeenCalledWith('/undo');
  });

  it('does not persist desktop forced expanded state', () => {
    const onExpandedChange = vi.fn();
    render(<MobileKeyboard {...baseProps} presentation="desktop-actions" onExpandedChange={onExpandedChange} />);

    expect(onExpandedChange).not.toHaveBeenCalled();
  });
});
