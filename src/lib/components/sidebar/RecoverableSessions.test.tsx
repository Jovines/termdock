// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { RecoverableSessions } from './RecoverableSessions';

const sessions = Array.from({ length: 5 }, (_, index) => ({
  name: `wt-${index}`, friendlyName: `Session ${index}`, windows: 1, attached: 0,
}));

beforeEach(() => {
  useSidebarStore.setState({ collapsedGroups: new Set() });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en' }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function view(onClose = vi.fn(async () => {}), onRestore = vi.fn()) {
  return <I18nProvider><RecoverableSessions sessions={sessions} loading={false}
    attachingName={null} onClose={onClose} onRestore={onRestore} /></I18nProvider>;
}

describe('Recoverable sessions controls', () => {
  it('makes every session actionable and requires confirmation before ending it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn(async () => {});
    const onRestore = vi.fn();
    render(view(onClose, onRestore));
    await user.click(screen.getByRole('button', { name: 'Close Session 4' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    expect(screen.getByText(/This stops all processes/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'End session' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close Session 4' }));
    await user.click(screen.getByRole('button', { name: 'End session' }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith('wt-4');
    expect(screen.queryByRole('button', { name: 'End session' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Restore Session 0' }));
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(sessions[0]);
  });

  it('keeps failed sessions available for retry and prevents duplicate end requests', async () => {
    const user = userEvent.setup();
    let rejectClose!: (error: Error) => void;
    const onClose = vi.fn().mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectClose = reject; }))
      .mockResolvedValue(undefined);
    render(view(onClose));
    await user.click(screen.getByRole('button', { name: 'Close Session 0' }));
    await user.click(screen.getByRole('button', { name: 'End session' }));
    expect(screen.getByRole('button', { name: 'Loading…' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Loading…' }));
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => rejectClose(new Error('Connection interrupted')));
    expect(screen.getByRole('alert').textContent).toBe('Connection interrupted');
    expect(screen.getByRole('button', { name: 'Restore Session 0' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'End session' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('remembers folding across sidebar remounts without ending sessions', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn(async () => {});
    const rendered = render(view(onClose));
    await user.click(screen.getByRole('button', { name: /Recoverable sessions/ }));
    expect(screen.queryByRole('button', { name: 'Restore Session 0' })).toBeNull();
    rendered.unmount();
    render(view(onClose));
    expect(screen.getByRole('button', { name: /Recoverable sessions/ }).getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('button', { name: /Recoverable sessions/ }));
    expect(screen.getByRole('button', { name: 'Restore Session 0' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
