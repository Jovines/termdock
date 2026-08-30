// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { DirectoryPickerDialog } from './DirectoryPickerDialog';

afterEach(cleanup);

describe('DirectoryPickerDialog', () => {
  it('keeps the draft path isolated until the user confirms', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <I18nProvider>
        <DirectoryPickerDialog open initialPath="/workspace" title="Choose working directory" onCancel={onCancel} onConfirm={onConfirm} />
      </I18nProvider>,
    );

    expect(screen.getByRole('dialog', { name: 'Choose working directory' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Parent folder' }));
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Use folder' }));
    expect(onConfirm).toHaveBeenCalledWith('/');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('treats Escape as cancel without confirming a directory', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <I18nProvider>
        <DirectoryPickerDialog open initialPath="/workspace" title="Choose working directory" onCancel={onCancel} onConfirm={onConfirm} />
      </I18nProvider>,
    );

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
