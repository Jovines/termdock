// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginScreen } from './LoginScreen';
import { I18nProvider } from '../../i18n';

const mocks = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock('../../terminal/api', () => ({ loginWithPassword: mocks.login, getSettings: async () => ({}), updateSettings: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); mocks.login.mockReset(); });

describe('login feedback and focus ownership', () => {
  it('leaves a management dialog focused while login mounts, then restores the password field', () => {
    const dialog = document.createElement('div'); dialog.tabIndex = -1; dialog.setAttribute('role', 'dialog');
    document.body.append(dialog); dialog.focus();
    const view = render(<LoginScreen focusEnabled={false} onLoginSuccess={() => {}} />);
    expect(document.activeElement).toBe(dialog);
    expect((screen.getByLabelText('Enter password') as HTMLInputElement).disabled).toBe(true);
    dialog.remove(); view.rerender(<LoginScreen focusEnabled onLoginSuccess={() => {}} />);
    expect(document.activeElement).toBe(screen.getByLabelText('Enter password'));
  });

  it.each(['en', 'zh'])('uses %s feedback and does not expose server diagnostics', async locale => {
    localStorage.setItem('termdock:locale', locale);
    mocks.login.mockResolvedValue({ ok: false, error: 'server identity /private/key.pem secret details' });
    render(<I18nProvider><LoginScreen onLoginSuccess={() => {}} /></I18nProvider>);
    const input = screen.getByLabelText(locale === 'en' ? 'Enter password' : '请输入密码');
    fireEvent.change(input, { target: { value: 'incorrect-test-password' } });
    fireEvent.submit(input.closest('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(locale === 'en'
      ? 'The password is incorrect, or the service identity could not be verified. Check and try again.'
      : '密码不正确，或服务身份无法验证。请检查后重试。');
    expect(alert.textContent).not.toContain('private');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'revised-password' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a recoverable connection error when authentication rejects unexpectedly', async () => {
    mocks.login.mockRejectedValue(new Error('raw transport diagnostics'));
    render(<LoginScreen onLoginSuccess={() => {}} />);
    const input = screen.getByLabelText('Enter password');
    fireEvent.change(input, { target: { value: 'test-password' } }); fireEvent.submit(input.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not sign in. Check the connection and try again.');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false));
  });
});

it.each([
  ['connectionFailed', 'Could not sign in. Check the connection and try again.'],
  ['identityMismatch', 'The service identity has changed. Check the address with its owner before trying again.'],
  ['unavailable', 'Password sign-in is unavailable on this service. Check the address or ask its owner for an invitation.'],
  ['authorizationRequired', 'This device needs authorization. Ask the service owner for a new invitation.'],
])('provides safe, distinct feedback for %s and permits retry', async (reason, message) => {
  mocks.login.mockResolvedValue({ ok: false, reason, error: '/private/credential-secret' });
  render(<LoginScreen onLoginSuccess={() => {}} />);
  const input = screen.getByLabelText('Enter password');
  fireEvent.change(input, { target: { value: 'test-password' } }); fireEvent.submit(input.closest('form')!);
  expect((await screen.findByRole('alert')).textContent).toBe(message);
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect((input as HTMLInputElement).value).toBe('test-password');
});
it('shows the current destination and opens service management before sign-in', () => {
  const onManageServices = vi.fn();
  render(<LoginScreen serviceOrigin="https://[::1]:9881" onManageServices={onManageServices} onLoginSuccess={() => {}} />);
  expect(screen.getByText('Signing in to [::1]:9881')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Manage services / use another address' }));
  expect(onManageServices).toHaveBeenCalledOnce(); expect(mocks.login).not.toHaveBeenCalled();
});
