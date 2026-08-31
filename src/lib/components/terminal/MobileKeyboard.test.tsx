// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  onPastePress: vi.fn(),
  onFilePress: vi.fn(),
  onModifierToggle: vi.fn(),
  onPresetSelect: vi.fn(),
};

describe('MobileKeyboard interaction state', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the toolbar visible without firing actions when non-interactive', () => {
    const onKeyPress = vi.fn();
    const onTextPress = vi.fn();
    const onPastePress = vi.fn();
    const onFilePress = vi.fn();
    render(<MobileKeyboard {...baseProps} interactive={false} onKeyPress={onKeyPress} onTextPress={onTextPress} onPastePress={onPastePress} onFilePress={onFilePress} />);

    const toolbar = screen.getByText('Esc').closest('[data-mobile-keyboard="true"]');
    expect(toolbar?.className).toContain('opacity-100');
    expect(toolbar?.className).toContain('[&_button]:pointer-events-none');

    fireEvent.pointerDown(screen.getByText('Esc'));
    fireEvent.pointerDown(screen.getByText('/undo'));
    fireEvent.click(screen.getByLabelText('Insert local file'));

    expect(onKeyPress).not.toHaveBeenCalled();
    expect(onTextPress).not.toHaveBeenCalled();
    expect(onPastePress).not.toHaveBeenCalled();
    expect(onFilePress).not.toHaveBeenCalled();
  });

  it('fires the paste callback from the mobile toolbar', () => {
    const onPastePress = vi.fn();
    render(<MobileKeyboard {...baseProps} onPastePress={onPastePress} />);

    fireEvent.pointerDown(screen.getByLabelText('Paste'));

    expect(onPastePress).toHaveBeenCalledTimes(1);
  });

  it('opens the local file picker directly from the primary mobile toolbar', () => {
    const onFilePress = vi.fn();
    render(<MobileKeyboard {...baseProps} onFilePress={onFilePress} />);

    fireEvent.click(screen.getByLabelText('Insert local file'));

    expect(onFilePress).toHaveBeenCalledTimes(1);
  });

  it('shows temporary file upload feedback on the toolbar button', () => {
    const { rerender } = render(<MobileKeyboard {...baseProps} fileUploadState="uploading" fileUploadProgress={42} />);
    const uploadingButton = screen.getByTitle('Uploading… 42%') as HTMLButtonElement;
    expect(uploadingButton.disabled).toBe(true);
    expect((uploadingButton.querySelector('[data-file-upload-progress="true"]') as HTMLElement).style.width).toBe('42%');

    rerender(<MobileKeyboard {...baseProps} fileUploadState="inserted" />);
    expect(screen.getByTitle('Inserted')).toBeTruthy();

    rerender(<MobileKeyboard {...baseProps} fileUploadState="failed" />);
    expect(screen.getByTitle('Upload failed')).toBeTruthy();
  });

  it('keeps Ctrl-U in its original primary toolbar slot', () => {
    const onKeyPress = vi.fn();
    render(<MobileKeyboard {...baseProps} onKeyPress={onKeyPress} />);

    const ctrlUButton = screen.getByText('C-U');
    expect(ctrlUButton.closest('[data-mobile-keyboard-primary-row="true"]')).toBeTruthy();
    fireEvent.pointerDown(ctrlUButton);

    expect(onKeyPress).toHaveBeenCalledWith('ctrl-u');
  });

  it('closes the preset menu when it becomes non-interactive', () => {
    const { rerender } = render(<MobileKeyboard {...baseProps} />);

    fireEvent.pointerDown(screen.getByTitle('Auto preset · Claude'));
    expect(screen.getByText('Claude')).toBeTruthy();

    rerender(<MobileKeyboard {...baseProps} interactive={false} />);

    expect(screen.queryByText('Claude')).toBeNull();
  });

  it('toggles long-press mode from the mode button', () => {
    const onLongPressModeToggle = vi.fn();
    render(<MobileKeyboard {...baseProps} longPressMode="arrows" onLongPressModeToggle={onLongPressModeToggle} />);

    fireEvent.click(screen.getByLabelText('Switch long press to copy selection'));

    expect(onLongPressModeToggle).toHaveBeenCalledTimes(1);
  });

  it('shows copy feedback on the long-press mode button', () => {
    const { rerender } = render(<MobileKeyboard {...baseProps} longPressMode="copy" copyFeedback="copied" />);
    expect(screen.getByTitle('Copied')).toBeTruthy();

    rerender(<MobileKeyboard {...baseProps} longPressMode="copy" copyFeedback="failed" />);
    expect(screen.getByTitle('Copy failed')).toBeTruthy();
  });

  it('returns to arrow mode and announces it after a successful copy', () => {
    const onLongPressModeToggle = vi.fn();
    const { rerender } = render(
      <MobileKeyboard {...baseProps} longPressMode="copy" copyFeedback="idle" onLongPressModeToggle={onLongPressModeToggle} />,
    );

    rerender(
      <MobileKeyboard {...baseProps} longPressMode="copy" copyFeedback="copied" onLongPressModeToggle={onLongPressModeToggle} />,
    );

    expect(onLongPressModeToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('Copied · Long press sends arrow keys');
  });

  it('keeps copy mode active and announces it when copying fails', () => {
    const onLongPressModeToggle = vi.fn();
    const { rerender } = render(
      <MobileKeyboard {...baseProps} longPressMode="copy" copyFeedback="idle" onLongPressModeToggle={onLongPressModeToggle} />,
    );

    rerender(
      <MobileKeyboard {...baseProps} longPressMode="copy" copyFeedback="failed" onLongPressModeToggle={onLongPressModeToggle} />,
    );

    expect(onLongPressModeToggle).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Copy failed · Long press selects text');
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
